/**
 * The AI-assisted half of change management.
 *
 * Three endpoints, and all three are the same shape: retrieve your own data
 * deterministically, hand it to the model, return what the model says ALONGSIDE the data it
 * was given. The caller can always check the answer against the facts, because the facts come
 * back with it. Rule AI1 in CONTRACTS.md.
 *
 * None of them exists unless somebody's key can pay: the caller's own, or the deployment's
 * `ANTHROPIC_API_KEY`. `GET /ai/capabilities` is the one route that answers without either, so
 * the UI can hide the rest rather than offering buttons that 409.
 *
 * Rate-limited per user, because unlike every other endpoint here these cost money per call.
 * The limits are deliberately low: this is a feature you reach for while reading a change, not
 * one you poll.
 */
import { Request, Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { allow } from '../lib/rateLimit';
import { AclUser, aclFilter } from '../lib/acl';
import {
  aiComplete,
  AiCredential,
  AI_GROUND_RULES,
  deploymentCredential,
  keyHint,
  modelFor,
  validateKeyFormat,
  verifyCredential,
} from '../lib/ai';
import { isConfigured as secretsConfigured, open as openSecret, seal } from '../lib/secretBox';
import { buildChangeBrief, ChangeBrief } from '../lib/changeBrief';

const router = Router();
router.use(requireAuth);

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

/** One AI call per user per this window, per feature. Low on purpose: each one is billed. */
const WINDOW_MS = 60 * 60 * 1000;
const PER_HOUR = 20;

function spendAllowance(feature: string, userId: number): void {
  if (!allow(`ai:${feature}:${userId}`, PER_HOUR, WINDOW_MS)) {
    throw new HttpError(429, `Too many AI requests — ${PER_HOUR} an hour. Try again later.`);
  }
}

/** Where a user's own key lives, for lib/secretBox's AAD binding. */
function keyLocation(userId: number) {
  return { purpose: 'ai-provider-key', column: 'User.aiKeyEnc', rowId: userId };
}

/**
 * Whose key pays for this call.
 *
 * The caller's own key first, the deployment's only as a fallback. Both halves are required
 * before the user's key is used, because the two are only ever written together: `PUT /ai/key`
 * sets all four columns and both DELETEs clear all four, so there is no endpoint that can
 * produce (OPENAI, no key) — a state in which the resolution order would read the provider
 * off the user and the credential off the operator's account. Nothing in the schema enforces
 * that, so the condition is checked here rather than assumed.
 *
 * A user's key that FAILS TO OPEN does not silently fall back. That would mean a rotation of
 * the deployment's encryption key quietly moved everybody's spending onto the operator's
 * account, which is the kind of thing discovered on an invoice.
 */
async function resolveCredential(req: Request): Promise<AiCredential | null> {
  const user = req.user;
  if (!user) throw new HttpError(401, 'Not authenticated');
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { aiProvider: true, aiKeyEnc: true },
  });
  if (row?.aiProvider && row.aiKeyEnc) {
    const apiKey = openSecret(row.aiKeyEnc, keyLocation(user.id));
    if (apiKey === null) {
      throw new HttpError(
        409,
        'Your stored API key could not be read — remove it in your profile and set it again'
      );
    }
    return { provider: row.aiProvider, apiKey, source: 'user' };
  }
  return deploymentCredential();
}

/**
 * Refuses when nobody's key can pay. The message names which of the two situations it is,
 * because "the operator has not set one" and "you have not set one" need different actions
 * from different people.
 */
function requireCredential(credential: AiCredential | null): AiCredential {
  if (!credential) {
    throw new HttpError(
      409,
      'No AI key is available — add your own in your profile, or ask an administrator to ' +
        'configure one for this deployment'
    );
  }
  return credential;
}

// ---------------------------------------------------------------------------
// GET /ai/capabilities — what the UI may offer
// ---------------------------------------------------------------------------

/**
 * Answers WITHOUT the key, so the frontend can hide the buttons instead of rendering them and
 * discovering a 409. The same shape `GET /auth/providers` uses for the OAuth buttons, and for
 * the same reason: a capability the deployment does not have should be invisible, not broken.
 *
 * The model name is reported because an engineer reading an AI-written summary is entitled to
 * know what wrote it. The key is not reported, obviously, nor whether it looks valid — that
 * would be a credential oracle.
 */
router.get(
  '/ai/capabilities',
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { aiProvider: true, aiKeyHint: true, aiKeySetAt: true },
    });
    const deployment = deploymentCredential();
    /*
     * PER-CALLER, not per-deployment. Before bring-your-own-key this answered a question
     * about the operator's environment and the same answer was right for everybody; now two
     * people on one deployment get different answers, and the promise the UI makes (rule
     * AI3a: somebody with no key available sees no AI at all) has to hold for each of them
     * separately.
     */
    const configured = Boolean(row?.aiProvider) || deployment !== null;
    res.json({
      configured,
      source: row?.aiProvider ? 'user' : deployment ? 'deployment' : null,
      // The caller's own key, described well enough to recognise and never to use: provider,
      // last four characters, when it was set. Never the key.
      ownKey: row?.aiProvider
        ? {
            provider: row.aiProvider,
            hint: row.aiKeyHint,
            setAt: row.aiKeySetAt?.toISOString() ?? null,
          }
        : null,
      /** Whether this deployment can take custody of a key at all (lib/secretBox). */
      canStoreKeys: secretsConfigured(),
      model: configured
        ? modelFor(row?.aiProvider ?? deployment?.provider ?? 'ANTHROPIC')
        : null,
      features: {
        changeNarrative: configured,
        draftChangeOrder: configured,
        suggestReviewers: configured,
      },
    });
  })
);

// ---------------------------------------------------------------------------
// PUT / DELETE /ai/key — the caller's own credential
// ---------------------------------------------------------------------------

/**
 * Store the caller's own provider key.
 *
 * Refuses rather than storing weakly: with no `AI_KEY_ENCRYPTION_KEY` the deployment cannot
 * encrypt it, and taking custody of somebody's paid credential under a key derived from the
 * session secret is worse than declining. See lib/secretBox.ts.
 */
router.put(
  '/ai/key',
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    if (!secretsConfigured()) {
      throw new HttpError(
        409,
        'This deployment cannot store API keys yet — an administrator must set ' +
          'AI_KEY_ENCRYPTION_KEY'
      );
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = body.provider;
    if (provider !== 'ANTHROPIC' && provider !== 'OPENAI') {
      throw new HttpError(400, 'provider must be ANTHROPIC or OPENAI');
    }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    const problem = validateKeyFormat(provider, apiKey);
    if (problem) throw new HttpError(400, problem);

    /*
     * Checked against the provider, and the answer is REPORTED rather than used to gate.
     *
     * Gating on it would mean a provider outage, or a 429 on a busy account, stopping
     * somebody saving a key that is perfectly good — the product second-guessing the person
     * who owns the credential, on evidence it admits it could not gather. The format check
     * above already refuses what is definitely not a key; beyond that the person is told what
     * happened and decides.
     */
    const verification = await verifyCredential({ provider, apiKey, source: 'user' });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        aiProvider: provider,
        aiKeyEnc: seal(apiKey, keyLocation(user.id)),
        aiKeyHint: keyHint(apiKey),
        aiKeySetAt: new Date(),
      },
    });
    // The key is never echoed, not even masked beyond the hint the profile already shows.
    res.json({
      stored: true,
      provider,
      hint: keyHint(apiKey),
      // true = the provider accepted it, false = it said no, null = nobody could tell.
      verified: verification.verified,
      reason: 'reason' in verification ? verification.reason : null,
    });
  })
);

router.delete(
  '/ai/key',
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    await prisma.user.update({
      where: { id: user.id },
      data: { aiProvider: null, aiKeyEnc: null, aiKeyHint: null, aiKeySetAt: null },
    });
    res.status(204).end();
  })
);

/**
 * An ADMIN revoking somebody else's key. CLEAR ONLY — there is no endpoint that reads it.
 *
 * This exists because a departed engineer's key cannot otherwise be removed: the foreign keys
 * pointing at `User` restrict deletion, so the row survives offboarding by design (change
 * control is worthless if attribution can be deleted), the documented procedure is to move
 * them to VIEWER, and they can no longer sign in to clear it themselves. Without this the
 * credential sits in the database for ever with nobody able to remove it.
 */
router.delete(
  '/ai/key/:userId',
  asyncHandler(async (req, res) => {
    const actor = req.user;
    if (!actor) throw new HttpError(401, 'Not authenticated');
    if (actor.role !== 'ADMIN') throw new HttpError(403, 'Only an administrator can do that');
    const userId = idParam(req.params.userId);
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) throw new HttpError(404, 'User not found');
    await prisma.user.update({
      where: { id: userId },
      data: { aiProvider: null, aiKeyEnc: null, aiKeyHint: null, aiKeySetAt: null },
    });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /ai/ecns/:id/narrative — explain the change brief
// ---------------------------------------------------------------------------

/** The brief, rendered for a model rather than for a table. */
function briefToPrompt(brief: ChangeBrief): string {
  const lines: string[] = [];
  lines.push(`Change order ${brief.ecn.ecnNumber}: ${brief.ecn.title}`);
  lines.push(`Status ${brief.ecn.status}, priority ${brief.ecn.priority}.`);
  lines.push('');
  lines.push(
    `Totals across the whole change: ${brief.totals.affectedParts} affected part(s), ` +
      `${brief.totals.products} product(s) reached, ${brief.totals.releasedAssemblies} released ` +
      `or in-review assembly revision(s) that use the affected part(s), ` +
      `${brief.totals.builtUnits} built unit(s) of which ${brief.totals.shippedUnits} shipped, ` +
      `${brief.totals.requirements} traced requirement(s), ${brief.totals.openNcrs} open ` +
      `nonconformance(s).`
  );
  if (brief.totals.redactedProducts > 0) {
    lines.push(
      `${brief.totals.redactedProducts} product(s) are reached but hidden from this reader by ` +
        'access control. They are counted and must not be described.'
    );
  }
  for (const item of brief.items) {
    lines.push('');
    lines.push(`PART ${item.part.partNumber} — ${item.part.name}`);
    lines.push(`  revision ${item.fromRevision ?? '(none)'} -> ${item.toRevision ?? '(none)'}`);
    lines.push(
      item.products.length === 0
        ? '  products reached: none'
        : `  products reached: ${item.products
            .map((p) => `${p.partNumber} (${p.level} level(s) up, via ${p.path.join(' > ')})`)
            .join('; ')}`
    );
    if (item.releasedAssemblies.length > 0) {
      lines.push(
        `  released or in-review assemblies using this part: ${item.releasedAssemblies
          .map((a) => `${a.part.partNumber} rev ${a.revision} (${a.lifecycle})`)
          .join('; ')}`
      );
    }
    if (item.builtUnits.length > 0) {
      lines.push(
        `  built units: ${item.builtUnits.map((u) => `${u.identifier} (${u.status})`).join('; ')}`
      );
    }
    lines.push(`  shipped units of this part: ${item.shippedCount}`);
    if (item.requirements.length > 0) {
      lines.push(
        `  traced requirements: ${item.requirements
          .map((r) => `${r.reqNumber} ${r.title}`)
          .join('; ')}`
      );
    }
    if (item.openNcrs.length > 0) {
      lines.push(
        `  open nonconformances: ${item.openNcrs.map((n) => `${n.ncrNumber} ${n.title}`).join('; ')}`
      );
    }
  }
  if (brief.notes.length > 0) {
    lines.push('');
    lines.push('The data is incomplete in these ways, which you must mention:');
    brief.notes.forEach((n) => lines.push(`- ${n}`));
  }
  return lines.join('\n');
}

const NARRATIVE_SYSTEM = [
  AI_GROUND_RULES,
  '',
  'Your job: tell the engineer what this change reaches and what is likely to need attention,',
  'in at most six short sentences. Lead with whatever has already left the building — shipped',
  'units, released assemblies — because that is the expensive part. Then anything open against',
  'the parts. Do not list everything; name what matters and say how many of the rest there are.',
].join('\n');

router.post(
  '/ai/ecns/:id/narrative',
  asyncHandler(async (req, res) => {
    // Resolved BEFORE the allowance is spent: a request that nobody's key can pay for must
    // not consume one of the caller's twenty, or a misconfigured deployment locks someone out
    // of a feature they never got to use.
    const credential = requireCredential(await resolveCredential(req));
    const id = idParam(req.params.id);
    const user = aclUser(req);
    spendAllowance('narrative', user.id);

    const ecn = await prisma.ecn.findFirst({
      where: { id, ...(aclFilter('ECN', user) as Prisma.EcnWhereInput) },
      select: {
        id: true,
        ecnNumber: true,
        title: true,
        status: true,
        priority: true,
        items: {
          orderBy: { id: 'asc' },
          select: {
            partId: true,
            part: { select: { id: true, partNumber: true, name: true } },
            fromRevision: { select: { id: true, revision: true } },
            toRevision: { select: { id: true, revision: true } },
          },
        },
      },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');

    /*
     * The brief is built with the CALLER's access, not the ECN's. The model therefore cannot
     * be told about a product the reader may not see, which means its answer cannot leak one
     * either — the redaction happens before the prompt exists rather than being asked for in
     * it. Asking a model to keep a secret is not an access control.
     */
    const brief = await buildChangeBrief(ecn, user);
    const result = await aiComplete(
      { system: NARRATIVE_SYSTEM, user: briefToPrompt(brief), maxTokens: 700 },
      credential
    );

    /*
     * The brief comes back WITH the narrative. An AI summary a reader cannot check against
     * the underlying facts is a claim; next to the facts it is a reading aid.
     */
    res.json({
      narrative: result.text,
      model: result.model,
      // Whose account was billed — with BYOK that is a question the reader can now ask.
      paidBy: result.source,
      inputTruncated: result.inputTruncated,
      brief,
      advisory: true,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /ai/draft-change-order — turn a description into a proposal
// ---------------------------------------------------------------------------

const DRAFT_SYSTEM = [
  AI_GROUND_RULES,
  '',
  'Your job: turn a free-text description of a change into a proposed change order, for the',
  'engineer to edit before anything is saved. Nothing you return is written to the database by',
  'this call.',
  '',
  'Answer as JSON only, no prose around it, exactly this shape:',
  '{"title": string, "description": string, "partNumbers": string[], "priority": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "uncertain": string[]}',
  '',
  '- `title` is one line, imperative, naming the change. No change-order number.',
  '- `partNumbers` may contain ONLY part numbers present in the candidate list given to you.',
  '  If the description names a part that is not in that list, leave it out of `partNumbers`',
  '  and say so in `uncertain`.',
  '- `priority` is your reading of the description. If it gives no signal, use "MEDIUM".',
  '- `uncertain` is where anything you could not resolve goes, in plain sentences. An empty',
  '  array means you resolved everything; do not pad it.',
].join('\n');

const CANDIDATE_LIMIT = 60;

router.post(
  '/ai/draft-change-order',
  asyncHandler(async (req, res) => {
    const credential = requireCredential(await resolveCredential(req));
    const user = aclUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length < 10) {
      throw new HttpError(400, 'Describe the change in a sentence or more');
    }
    if (description.length > 4000) {
      throw new HttpError(400, 'That description is too long — summarise it to 4000 characters');
    }
    spendAllowance('draft', user.id);

    /*
     * Candidate parts are retrieved from the database and the model may only choose from them.
     *
     * Without this it invents part numbers that look exactly like this deployment's — the
     * format is guessable — and a plausible wrong part number in a change order is worse than
     * a blank field, because it will be accepted. The candidates are matched against words in
     * the description, under the caller's ACL filter, so a restricted part cannot be proposed.
     */
    const words = [...new Set(description.split(/[^A-Za-z0-9._-]+/).filter((w) => w.length >= 3))]
      .slice(0, 25);
    const candidates = words.length
      ? await prisma.part.findMany({
          where: {
            AND: [
              {
                OR: words.flatMap((w) => [
                  { partNumber: { contains: w, mode: 'insensitive' as const } },
                  { name: { contains: w, mode: 'insensitive' as const } },
                ]),
              },
              aclFilter('PART', user) as Prisma.PartWhereInput,
            ],
          },
          select: { partNumber: true, name: true },
          take: CANDIDATE_LIMIT,
        })
      : [];

    const prompt = [
      'The change, as the engineer described it:',
      description,
      '',
      candidates.length
        ? `Candidate parts from their PLM (the ONLY part numbers you may use):\n${candidates
            .map((c) => `- ${c.partNumber} — ${c.name}`)
            .join('\n')}`
        : 'No parts in their PLM matched the description. `partNumbers` must be empty, and say ' +
          'so in `uncertain`.',
    ].join('\n');

    const result = await aiComplete(
      { system: DRAFT_SYSTEM, user: prompt, maxTokens: 900 },
      credential
    );

    /*
     * Parsed here, and a model that did not return JSON is reported rather than passed on. The
     * frontend fills a form from this; a string where an array belongs would be a confusing
     * blank field rather than a visible failure.
     */
    let draft: unknown;
    try {
      const start = result.text.indexOf('{');
      const end = result.text.lastIndexOf('}');
      draft = JSON.parse(start >= 0 ? result.text.slice(start, end + 1) : result.text);
    } catch {
      console.error('ai: draft-change-order did not return JSON');
      throw new HttpError(502, 'The AI service returned an answer this could not read — try again');
    }

    /*
     * And the part numbers are checked against the candidates rather than trusted. The system
     * prompt asks for this; the check is what enforces it, because a prompt is a request and
     * not a constraint.
     */
    const allowed = new Set(candidates.map((c) => c.partNumber));
    const proposed = Array.isArray((draft as { partNumbers?: unknown }).partNumbers)
      ? ((draft as { partNumbers: unknown[] }).partNumbers.filter(
          (p): p is string => typeof p === 'string'
        ) as string[])
      : [];
    const partNumbers = proposed.filter((p) => allowed.has(p));
    const invented = proposed.filter((p) => !allowed.has(p));

    res.json({
      draft: {
        title: String((draft as { title?: unknown }).title ?? '').slice(0, 200),
        description: String((draft as { description?: unknown }).description ?? '').slice(0, 4000),
        partNumbers,
        priority: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).includes(
          (draft as { priority?: string }).priority as 'LOW'
        )
          ? ((draft as { priority: string }).priority as string)
          : 'MEDIUM',
        uncertain: Array.isArray((draft as { uncertain?: unknown }).uncertain)
          ? (draft as { uncertain: unknown[] }).uncertain
              .filter((u): u is string => typeof u === 'string')
              .slice(0, 10)
          : [],
      },
      // Reported, not hidden: a model that reached for parts outside the candidate list is
      // something the reader should know about before trusting the rest of the draft.
      discardedPartNumbers: invented,
      candidatesConsidered: candidates.length,
      model: result.model,
      paidBy: result.source,
      advisory: true,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /ai/ecns/:id/suggest-reviewers — who has actually touched these parts
// ---------------------------------------------------------------------------

const REVIEWER_SYSTEM = [
  AI_GROUND_RULES,
  '',
  'Your job: from a list of people and what they did to the affected parts, say who should',
  'review this change and why, in one short sentence each. At most four people. Order them by',
  'how directly their work touches the change. If the evidence is thin, say that instead of',
  'filling the list.',
].join('\n');

router.post(
  '/ai/ecns/:id/suggest-reviewers',
  asyncHandler(async (req, res) => {
    const credential = requireCredential(await resolveCredential(req));
    const id = idParam(req.params.id);
    const user = aclUser(req);
    spendAllowance('reviewers', user.id);

    const ecn = await prisma.ecn.findFirst({
      where: { id, ...(aclFilter('ECN', user) as Prisma.EcnWhereInput) },
      select: {
        id: true,
        ecnNumber: true,
        title: true,
        items: { select: { partId: true, part: { select: { partNumber: true } } } },
        reviews: { select: { reviewerId: true } },
      },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');
    if (ecn.items.length === 0) {
      throw new HttpError(409, 'Add the affected parts first — there is nothing to go on yet');
    }

    const partIds = ecn.items.map((i) => i.partId);

    /*
     * The evidence is who CREATED the affected parts and their revisions. That is recorded
     * data, which is the point — a suggestion the reader cannot audit is a guess with a
     * confident tone.
     *
     * People already assigned as reviewers are excluded: suggesting someone who is already on
     * the ECN is noise, and it is the kind of noise that makes a reader stop reading.
     */
    const already = new Set(ecn.reviews.map((r) => r.reviewerId));
    const [partCreators, revisionCreators] = await Promise.all([
      prisma.part.groupBy({
        by: ['createdById'],
        where: { id: { in: partIds } },
        _count: { _all: true },
      }),
      prisma.partRevision.groupBy({
        by: ['createdById'],
        where: { partId: { in: partIds } },
        _count: { _all: true },
      }),
    ]);

    const tally = new Map<number, { parts: number; revisions: number }>();
    for (const row of partCreators) {
      const e = tally.get(row.createdById) ?? { parts: 0, revisions: 0 };
      e.parts += row._count._all;
      tally.set(row.createdById, e);
    }
    for (const row of revisionCreators) {
      const e = tally.get(row.createdById) ?? { parts: 0, revisions: 0 };
      e.revisions += row._count._all;
      tally.set(row.createdById, e);
    }
    for (const reviewerId of already) tally.delete(reviewerId);

    const candidates = await prisma.user.findMany({
      where: { id: { in: [...tally.keys()] } },
      select: { id: true, name: true, email: true, role: true },
    });
    if (candidates.length === 0) {
      /*
       * Answered WITHOUT calling the model. There is nothing to summarise, the call would cost
       * money, and a model given an empty list writes a paragraph about how it cannot help.
       */
      res.json({
        suggestions: [],
        reasoning: 'Nobody outside the current reviewers has created these parts or revisions.',
        evidence: [],
        model: null,
        // Stated rather than omitted. No model ran, so nobody paid — and a field the type
        // declares as always present must not simply be missing on one path, or the next
        // caller to trust the type throws on exactly this answer.
        paidBy: null,
        advisory: true,
      });
      return;
    }

    const evidence = candidates.map((c) => ({
      userId: c.id,
      name: c.name,
      role: c.role,
      partsCreated: tally.get(c.id)?.parts ?? 0,
      revisionsCreated: tally.get(c.id)?.revisions ?? 0,
    }));

    const prompt = [
      `Change order ${ecn.ecnNumber}: ${ecn.title}`,
      `Affected parts: ${ecn.items.map((i) => i.part.partNumber).join(', ')}`,
      '',
      'People, and what they did to those parts:',
      ...evidence.map(
        (e) =>
          `- ${e.name} (${e.role}): created ${e.partsCreated} of the affected part(s) and ` +
          `${e.revisionsCreated} of their revision(s)`
      ),
      '',
      'Answer as JSON only: {"suggestions": [{"name": string, "why": string}], "reasoning": string}',
    ].join('\n');

    const result = await aiComplete(
      { system: REVIEWER_SYSTEM, user: prompt, maxTokens: 600 },
      credential
    );

    let parsed: { suggestions?: unknown; reasoning?: unknown } = {};
    try {
      const start = result.text.indexOf('{');
      const end = result.text.lastIndexOf('}');
      parsed = JSON.parse(start >= 0 ? result.text.slice(start, end + 1) : result.text);
    } catch {
      console.error('ai: suggest-reviewers did not return JSON');
      throw new HttpError(502, 'The AI service returned an answer this could not read — try again');
    }

    /*
     * Names are resolved back to real users here. The model is given names and returns names;
     * only a name that matches somebody in the evidence becomes a suggestion, so a confidently
     * invented colleague is dropped rather than offered as a reviewer.
     */
    const byName = new Map(evidence.map((e) => [e.name.toLowerCase(), e]));
    const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
      .map((s) => s as { name?: unknown; why?: unknown })
      .map((s) => ({ match: byName.get(String(s.name ?? '').toLowerCase()), why: String(s.why ?? '') }))
      .filter((s): s is { match: (typeof evidence)[number]; why: string } => s.match !== undefined)
      .slice(0, 4)
      .map((s) => ({ userId: s.match.userId, name: s.match.name, why: s.why.slice(0, 300) }));

    res.json({
      suggestions,
      reasoning: String(parsed.reasoning ?? '').slice(0, 1000),
      // The counts the suggestion was made from, so a reader can disagree with it on the facts.
      evidence,
      model: result.model,
      paidBy: result.source,
      advisory: true,
    });
  })
);

export default router;
