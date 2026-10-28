/**
 * What a change actually reaches, computed from your own data.
 *
 * The question an engineer asks before releasing a change is "what does this break?", and
 * answering it meant opening five screens and holding the result in your head: where-used for
 * the products, the BOM tab for which released assemblies use the part, build units for what
 * has already shipped, traceability for the requirements, and quality for whatever is open
 * against the part. This joins them once.
 *
 * EVERY FIGURE HERE IS RETRIEVED, NOT INFERRED (rule CB1). That is the whole contract of this
 * file and the reason the AI narrative built on top of it is allowed to exist: the model is
 * given this brief and asked to explain it, never to supply a fact. Where this file cannot
 * answer something it says so — `truncated`, a null, an empty list — in the same spirit as the
 * cost roll-up going null rather than smaller when one contributor's cost is unknown.
 *
 * Item-level access control is honoured throughout, and the direction matters: a change brief
 * that silently DROPPED a restricted product would report a change as safe when it is not,
 * which is the one error this screen must not make. So restricted things are counted and
 * redacted, never omitted — `redactedProducts` exists for exactly that, and it is the same
 * rule every other traversal here follows (rule X4).
 */
import { BuildStatus, Lifecycle } from '@prisma/client';
import { prisma } from './prisma';
import { AclUser, REDACTED, visibleIds } from './acl';
import { walkWhereUsed } from './whereUsed';

export interface BriefPartRef {
  id: number;
  partNumber: string;
  name: string;
}

export interface BriefProduct extends BriefPartRef {
  /** How far above the changed part this product sits. 1 = it uses it directly. */
  level: number;
  /** The route from the changed part up to it, for reading the chain back. */
  path: string[];
}

export interface BriefReleasedAssembly {
  part: BriefPartRef;
  revision: string;
  lifecycle: Lifecycle;
}

export interface BriefBuiltUnit {
  /** The serial or lot number, whichever this unit is — see `BuildUnit.kind`. */
  identifier: string;
  status: BuildStatus;
}

export interface ChangeBriefItem {
  part: BriefPartRef;
  fromRevision: string | null;
  toRevision: string | null;
  /** Top-level assemblies the part reaches — the things a customer actually receives. */
  products: BriefProduct[];
  /** Products reached but not readable by this caller. Counted so the total stays honest. */
  redactedProducts: number;
  /**
   * Released or in-review assembly revisions whose BOM uses this part. These are the ones
   * whose structure is already committed to something, as against a draft still being
   * edited — so they are the rework this change creates.
   */
  releasedAssemblies: BriefReleasedAssembly[];
  /** Serialised units already built from this part, newest first. */
  builtUnits: BriefBuiltUnit[];
  /** How many of those have shipped — the expensive discovery, so it is its own number. */
  shippedCount: number;
  /** Requirements traced to this part, which a change may invalidate. */
  requirements: { id: number; reqNumber: string; title: string }[];
  /** Open nonconformances against this part. */
  openNcrs: { id: number; ncrNumber: string; title: string }[];
  /** True when the upward walk hit its depth cap, so `products` may be short. */
  truncated: boolean;
}

export interface ChangeBrief {
  ecn: { id: number; ecnNumber: string; title: string; status: string; priority: string };
  items: ChangeBriefItem[];
  /** Totals across every item, deduplicated — what the change reaches as a whole. */
  totals: {
    affectedParts: number;
    products: number;
    redactedProducts: number;
    releasedAssemblies: number;
    builtUnits: number;
    shippedUnits: number;
    requirements: number;
    openNcrs: number;
  };
  /** Anything the brief could not answer completely, in words, for a human and the model. */
  notes: string[];
}

const UNITS_PER_ITEM = 25;
/*
 * And a cap on the committed assemblies, for the same reason and with the same disclosure.
 *
 * This one is easy to miss. In the multi-tenant build the equivalent query was narrowed to a
 * single `childRevisionId`, which bounded it implicitly; asking about the PART instead (see the
 * comment on the query) removed that bound and nothing replaced it. The row count is now
 * (parents using this part) x (their RELEASED/IN_REVIEW revisions), and several revisions of one
 * parent can be released at once because going OBSOLETE is a separate manual step. A common
 * fastener reaches hundreds, and `briefToPrompt` emits every one — which pushes the prompt past
 * its character cap, and the truncation falls on the END of the prompt, which is exactly where
 * the incompleteness notes live. So an unbounded list here does not merely bloat a payload: it
 * silently drops the disclosures that tell the reader the brief is partial.
 */
const ASSEMBLIES_PER_ITEM = 25;

function toBriefPart(
  part: { id: number; partNumber: string; name: string },
  visible: ReadonlySet<number>
): BriefPartRef {
  return visible.has(part.id)
    ? { id: part.id, partNumber: part.partNumber, name: part.name }
    : { id: part.id, partNumber: REDACTED.partNumber, name: REDACTED.name };
}

/**
 * Build the brief for one ECN. The caller has already resolved the ECN through the ACL
 * filter, so this is about the parts it touches rather than about the ECN's own visibility.
 */
export async function buildChangeBrief(
  ecn: {
    id: number;
    ecnNumber: string;
    title: string;
    status: string;
    priority: string;
    items: {
      partId: number;
      part: { id: number; partNumber: string; name: string };
      fromRevision: { id: number; revision: string } | null;
      toRevision: { id: number; revision: string } | null;
    }[];
  },
  user: AclUser
): Promise<ChangeBrief> {
  const notes: string[] = [];
  const items: ChangeBriefItem[] = [];

  for (const item of ecn.items) {
    /*
     * The upward walk is the BROAD question — every assembly above the part, whatever its
     * lifecycle — and that is deliberate (rule CB2).
     *
     * The narrow question, "which assemblies are already committed to this part", is a
     * different one and is reported separately below as `releasedAssemblies`. Answering only
     * the narrow one would silently omit every draft product, which on a change being
     * assessed BEFORE release is most of them: an unreleased assembly using this part has
     * not escaped the change, it just has not met it yet.
     */
    const tree = await walkWhereUsed(item.partId, user);
    const products = tree.topLevel;
    const visibleProductIds = await visibleIds(
      'PART',
      products.map((p) => p.parentPart.id),
      user
    );

    const readable = products.filter((p) => visibleProductIds.has(p.parentPart.id));
    const redactedProducts = products.length - readable.length;

    /*
     * RELEASED and IN_REVIEW only, and the two things that excludes are opposite.
     *
     * IN_WORK is excluded because a draft parent is still being edited: whoever is working on
     * it will see the new revision as they go, so it is not rework this change creates.
     * OBSOLETE is excluded because a retired parent is history — listing it would pad the
     * brief with assemblies nobody is going to touch again.
     *
     * Asked about the PART and not about `fromRevision`, because a BOM line here names a
     * part: there is no stored pin saying which child revision a released parent was built
     * against. So this is NOT "the assemblies holding the old revision", and neither the
     * field name nor the prompt built from it may imply that it is — rule CB2 forbids the
     * brief reporting a figure the database does not hold. What it is instead is honest and
     * useful: the committed assemblies this part is in.
     */
    const releasedRows = await prisma.bomLine.findMany({
      where: {
        childPartId: item.partId,
        parentRevision: { lifecycle: { in: [Lifecycle.RELEASED, Lifecycle.IN_REVIEW] } },
      },
      orderBy: { id: 'desc' },
      take: ASSEMBLIES_PER_ITEM + 1,
      select: {
        parentRevision: {
          select: {
            revision: true,
            lifecycle: true,
            part: { select: { id: true, partNumber: true, name: true } },
          },
        },
      },
    });
    if (releasedRows.length > ASSEMBLIES_PER_ITEM) {
      notes.push(
        `${item.part.partNumber} is used in more than ${ASSEMBLIES_PER_ITEM} released or ` +
          'in-review assemblies; only some are listed. Treat the list as a sample, not a count.'
      );
    }
    const released = releasedRows.slice(0, ASSEMBLIES_PER_ITEM);
    const releasedVisible = await visibleIds(
      'PART',
      released.map((p) => p.parentRevision.part.id),
      user
    );

    /*
     * Units already built from this part. SCRAPPED is excluded: it was built and thrown away,
     * so it is not something a change has to be reconciled against, and including it would
     * inflate the one number most likely to stop a release.
     */
    const units = await prisma.buildUnit.findMany({
      where: { partId: item.partId, status: { not: BuildStatus.SCRAPPED } },
      orderBy: { id: 'desc' },
      take: UNITS_PER_ITEM + 1,
      select: { identifier: true, status: true },
    });
    if (units.length > UNITS_PER_ITEM) {
      notes.push(
        `${item.part.partNumber} has more than ${UNITS_PER_ITEM} built units; only the most ` +
          'recent are listed. The shipped count below is complete.'
      );
    }
    // Counted separately rather than from the truncated list above, so the number that
    // decides whether a change needs a field action is never a sample (rule CB3).
    const shippedCount = await prisma.buildUnit.count({
      where: { partId: item.partId, status: BuildStatus.SHIPPED },
    });

    const requirementLinks = await prisma.requirementLink.findMany({
      where: { partId: item.partId },
      select: {
        requirement: { select: { id: true, reqNumber: true, title: true } },
      },
    });

    const ncrs = await prisma.nonconformance.findMany({
      where: { partId: item.partId, status: { not: 'CLOSED' } },
      select: { id: true, ncrNumber: true, title: true },
      orderBy: { id: 'desc' },
      take: 10,
    });

    if (tree.notes.length > 0) notes.push(...tree.notes.map((n) => `${item.part.partNumber}: ${n}`));

    items.push({
      part: { id: item.part.id, partNumber: item.part.partNumber, name: item.part.name },
      fromRevision: item.fromRevision?.revision ?? null,
      toRevision: item.toRevision?.revision ?? null,
      products: readable.map((p) => ({
        id: p.parentPart.id,
        partNumber: p.parentPart.partNumber,
        name: p.parentPart.name,
        level: p.level,
        path: p.path,
      })),
      redactedProducts,
      releasedAssemblies: released.map((p) => ({
        part: toBriefPart(p.parentRevision.part, releasedVisible),
        revision: releasedVisible.has(p.parentRevision.part.id)
          ? p.parentRevision.revision
          : REDACTED.name,
        lifecycle: p.parentRevision.lifecycle,
      })),
      builtUnits: units.slice(0, UNITS_PER_ITEM).map((u) => ({
        identifier: u.identifier,
        status: u.status,
      })),
      shippedCount,
      requirements: requirementLinks.map((l) => l.requirement),
      openNcrs: ncrs,
      truncated: tree.notes.length > 0,
    });
  }

  /*
   * Totals are DEDUPLICATED across items (rule CB4). Two parts on one ECN usually share
   * products, and an engineer reading "12 products affected" when it is the same three
   * products counted four times would either discount the number or panic at it.
   */
  const productIds = new Set<number>();
  const assemblyKeys = new Set<string>();
  const unitSerials = new Set<string>();
  const requirementIds = new Set<number>();
  const ncrIds = new Set<number>();
  let redactedProducts = 0;
  let shippedUnits = 0;
  for (const item of items) {
    item.products.forEach((p) => productIds.add(p.id));
    redactedProducts += item.redactedProducts;
    item.releasedAssemblies.forEach((p) => assemblyKeys.add(`${p.part.id}:${p.revision}`));
    item.builtUnits.forEach((u) => unitSerials.add(u.identifier));
    shippedUnits += item.shippedCount;
    item.requirements.forEach((r) => requirementIds.add(r.id));
    item.openNcrs.forEach((n) => ncrIds.add(n.id));
  }

  return {
    ecn: {
      id: ecn.id,
      ecnNumber: ecn.ecnNumber,
      title: ecn.title,
      status: ecn.status,
      priority: ecn.priority,
    },
    items,
    totals: {
      affectedParts: items.length,
      products: productIds.size,
      redactedProducts,
      releasedAssemblies: assemblyKeys.size,
      builtUnits: unitSerials.size,
      shippedUnits,
      requirements: requirementIds.size,
      openNcrs: ncrIds.size,
    },
    notes,
  };
}
