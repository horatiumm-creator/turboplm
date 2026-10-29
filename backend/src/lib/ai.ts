/**
 * The one place this product talks to a language model.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DO. Everything here is given data that was already
 * retrieved from your own database and asked to EXPLAIN it. It is never asked for an
 * engineering fact, a quantity, a cost, or a judgement that the database could have answered.
 * That is not squeamishness: this codebase's whole character is refusing to produce a number
 * it cannot stand behind — a cost roll-up goes null rather than smaller the moment one
 * contributor's cost is unknown (`sumOrNull` in routes/cost.ts), and a traversal redacts a
 * part the caller may not see rather than dropping it, because a total presented as complete
 * when it is not is the lie that matters (rule X4). A feature that invented an impact
 * assessment would invert all of it on the screen where the stakes are highest.
 * Rule AI1 in CONTRACTS.md.
 *
 * NO SDK, DELIBERATELY (rule AI4). The Messages API is one POST. `@anthropic-ai/sdk` would
 * add a dependency to a container image that every self-hosting deployment has to build, and
 * the OAuth flow next door already speaks to Google with plain `fetch` — which is also what
 * makes it testable, because the suite stubs `fetch` and drives the real route. Same boundary
 * here.
 *
 * SECRET-GATED, like the OAuth providers. With neither a user's own key nor an
 * `ANTHROPIC_API_KEY` the feature does not exist for that person: `GET /ai/capabilities` says
 * so, and the UI renders nothing. An operator turns it on by setting a secret, or a person by
 * bringing their own key — not by shipping a build.
 */
import { AiProvider } from '@prisma/client';
import { HttpError } from './errors';

/**
 * One adapter per provider: where to POST, how to carry the credential, what the request and
 * response look like. Plain `fetch` throughout — see the header for why there is no SDK, and
 * the reason multiplies with a second provider rather than weakening.
 *
 * The endpoint is FIXED per provider and never taken from user input. A bring-your-own-key
 * feature that also accepted a base URL would let a user point the product's server at a host
 * of their choosing, which is a server-side request forgery with a credential attached.
 */
interface Adapter {
  url: string;
  /** The key's documented prefix, used to reject a pasted password before it is ever stored. */
  keyPrefix: string;
  headers: (apiKey: string) => Record<string, string>;
  body: (model: string, system: string, user: string, maxTokens: number) => unknown;
  /** Pull the assistant's text out, or return '' if the shape is not what we expect. */
  text: (body: unknown) => string;
  defaultModel: string;
}

const ADAPTERS: Record<AiProvider, Adapter> = {
  ANTHROPIC: {
    url: 'https://api.anthropic.com/v1/messages',
    keyPrefix: 'sk-ant-',
    headers: (apiKey) => ({
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }),
    body: (model, system, user, maxTokens) => ({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    text: (body) =>
      ((body as { content?: { type: string; text?: string }[] }).content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n')
        .trim(),
    defaultModel: 'claude-sonnet-5-5',
  },
  OPENAI: {
    url: 'https://api.openai.com/v1/chat/completions',
    keyPrefix: 'sk-',
    headers: (apiKey) => ({
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    }),
    // The system prompt is a message rather than a top-level field here; same content, and
    // keeping the two shapes behind this interface is the whole point of the adapter.
    body: (model, system, user, maxTokens) => ({
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    text: (body) => {
      const choices = (body as { choices?: { message?: { content?: string } }[] }).choices ?? [];
      return (choices[0]?.message?.content ?? '').trim();
    },
    defaultModel: 'gpt-5',
  },
};

/**
 * What a key must look like before this product will take custody of it.
 *
 * Checked BEFORE anything is stored or derived, because `aiKeyHint` keeps the last four
 * characters in a plaintext column and puts them on screen: without this, the tail of a
 * mistyped password, or of a pasted `ANTHROPIC_API_KEY=sk-ant-...` line, ends up displayed
 * and stored. It also turns "the feature silently does nothing" into an error at the moment
 * the person is looking at the field.
 */
export function validateKeyFormat(provider: AiProvider, apiKey: string): string | null {
  if (apiKey !== apiKey.trim()) return 'The key has leading or trailing whitespace';
  if (/\s/.test(apiKey)) return 'The key contains a space or newline — paste the key only';
  if (apiKey.includes('=')) {
    return 'That looks like a whole environment line — paste just the key, not NAME=value';
  }
  if (apiKey.length < 20 || apiKey.length > 400) return 'That is not the right length for a key';
  const { keyPrefix } = ADAPTERS[provider];
  if (!apiKey.startsWith(keyPrefix)) {
    return `An ${provider} key starts with "${keyPrefix}"`;
  }
  return null;
}

/** The last four characters, for display. Only ever called on a validated key. */
export function keyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

/**
 * A ceiling on what is sent, measured in characters because that is what we can measure
 * without a tokeniser.
 *
 * A change brief for a part used across a large product line is unbounded in principle, and an
 * unbounded prompt is an unbounded bill. Truncation is REPORTED rather than silent — the caller
 * puts it in the response, so a narrative written from a partial brief never reads as though it
 * saw everything.
 */
const MAX_INPUT_CHARS = 60_000;

/** How long to wait before giving up. A console that hangs is worse than one that says no. */
const TIMEOUT_MS = 60_000;

/** The deployment's own key, when the operator has set one. The fallback, not the default. */
export function deploymentCredential(): AiCredential | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? { provider: AiProvider.ANTHROPIC, apiKey, source: 'deployment' } : null;
}

export function modelFor(provider: AiProvider): string {
  if (provider === AiProvider.ANTHROPIC && process.env.ANTHROPIC_MODEL) {
    return process.env.ANTHROPIC_MODEL;
  }
  if (provider === AiProvider.OPENAI && process.env.OPENAI_MODEL) return process.env.OPENAI_MODEL;
  return ADAPTERS[provider].defaultModel;
}

export interface AiResult {
  text: string;
  model: string;
  /** True when the input was cut to fit, so the caller can say the answer is partial. */
  inputTruncated: boolean;
  /** Whose key paid for it. Reported, so "which account did this bill?" has an answer. */
  source: 'user' | 'deployment';
}

/**
 * Does this key work? Reported, never used to gate.
 *
 * A definite rejection and an unreachable provider are different facts, and collapsing them
 * would mean a provider outage — or a 429 on a busy account — blocking somebody from saving a
 * perfectly good key. So this answers three ways: yes, no, and could-not-tell. The caller
 * stores the key either way and tells the person which they got.
 *
 * Its own short timeout, not `TIMEOUT_MS`. That one is sized for a model writing prose; this
 * runs while somebody is looking at a form with their finger on the paste button, and a
 * minute of nothing is worse than "could not check".
 */
const VERIFY_TIMEOUT_MS = 10_000;

export type Verification =
  | { verified: true }
  /** The provider said no. Definite: the key itself is wrong. */
  | { verified: false; reason: string }
  /** Nobody could tell — a timeout, a rate limit, an outage. The key may be fine. */
  | { verified: null; reason: string };

export async function verifyCredential(credential: AiCredential): Promise<Verification> {
  const adapter = ADAPTERS[credential.provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    // The smallest call each provider accepts: one token, which costs essentially nothing and
    // still exercises authentication, which is the only thing being asked.
    const res = await fetch(adapter.url, {
      method: 'POST',
      headers: adapter.headers(credential.apiKey),
      body: JSON.stringify(adapter.body(modelFor(credential.provider), 'ping', 'ping', 1)),
      signal: controller.signal,
    });
    if (res.ok) return { verified: true };
    if (res.status === 401 || res.status === 403) {
      return { verified: false, reason: `${credential.provider} rejected this key` };
    }
    if (res.status === 429) {
      return {
        verified: null,
        reason: `${credential.provider} is rate-limiting the account, so the key could not be checked`,
      };
    }
    return {
      verified: null,
      reason: `${credential.provider} answered ${res.status}, so the key could not be checked`,
    };
  } catch {
    // A timeout or a network failure. Nothing logged: the inputs are a credential.
    return {
      verified: null,
      reason: `${credential.provider} could not be reached, so the key could not be checked`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Who is paying for this call, and with whose credential. */
export interface AiCredential {
  provider: AiProvider;
  apiKey: string;
  /** 'user' when the caller brought it, 'deployment' when it came from the operator's env. */
  source: 'user' | 'deployment';
}

/**
 * Send one prompt and return the text.
 *
 * Takes the credential rather than reading the environment, because with bring-your-own-key
 * the answer to "whose key is this" is a property of the REQUEST, not of the process.
 *
 * Errors become HttpErrors with sentences the CALLER can act on, and which say whose key
 * failed. The key itself never appears in any of them, nor in a log line, nor does the
 * upstream body — it can quote the request back, and the request carries your product data as
 * well as, in the headers, the credential.
 */
export async function aiComplete(
  options: { system: string; user: string; maxTokens?: number },
  credential: AiCredential
): Promise<AiResult> {
  const adapter = ADAPTERS[credential.provider];
  const model = modelFor(credential.provider);

  const inputTruncated = options.user.length > MAX_INPUT_CHARS;
  const user = inputTruncated
    ? `${options.user.slice(0, MAX_INPUT_CHARS)}\n\n[This brief was truncated to fit. Say so in your answer.]`
    : options.user;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(adapter.url, {
      method: 'POST',
      headers: adapter.headers(credential.apiKey),
      body: JSON.stringify(adapter.body(model, options.system, user, options.maxTokens ?? 1500)),
      signal: controller.signal,
    });
  } catch (err) {
    // Deliberately not `err` into the message: an abort or a DNS failure says nothing a
    // caller can use, and anything echoed from a request carrying an API key is a risk.
    console.error('ai: request failed', err instanceof Error ? err.message : err);
    throw new HttpError(503, `${credential.provider} did not respond — try again in a moment`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Read for the LOG and never for the response.
    const detail = await res.text().catch(() => '');
    console.error(`ai: ${res.status} from ${credential.provider}: ${detail.slice(0, 500)}`);
    if (res.status === 401 || res.status === 403) {
      /*
       * Attributed to whoever owns the key. Telling a user to "check ANTHROPIC_API_KEY" when
       * the rejected credential is the one they pasted into their own profile names a
       * variable they do not control and cannot see — they would go looking for an operator
       * instead of fixing their own key.
       */
      throw new HttpError(
        credential.source === 'user' ? 400 : 502,
        credential.source === 'user'
          ? `${credential.provider} rejected your API key — check it in your profile, or remove it`
          : `This deployment's ${credential.provider} credentials were rejected — an ` +
            'administrator should check ANTHROPIC_API_KEY'
      );
    }
    if (res.status === 429) {
      throw new HttpError(
        503,
        credential.source === 'user'
          ? `${credential.provider} is rate-limiting your account — try again shortly`
          : `${credential.provider} is rate-limiting this deployment — try again shortly`
      );
    }
    throw new HttpError(503, `${credential.provider} could not answer — try again in a moment`);
  }

  const body = (await res.json()) as unknown;
  const text = adapter.text(body);
  if (!text) {
    console.error(`ai: ${credential.provider} returned no text`);
    throw new HttpError(503, `${credential.provider} returned an empty answer — try again`);
  }

  return { text, model, inputTruncated, source: credential.source };
}

/**
 * The instruction every prompt in this product starts from.
 *
 * Written as prohibitions because that is what the failure mode needs: a model asked to
 * assess an engineering change will, left alone, supply plausible numbers and confident
 * conclusions. The data it is given is the only data there is.
 */
export const AI_GROUND_RULES = [
  'You are helping an engineer read data that has already been retrieved from their own PLM',
  'system. You are explaining it, not investigating it.',
  '',
  'Rules you must not break:',
  '- Use ONLY the facts in the data given to you. Never add a part, quantity, cost, date,',
  '  serial number, standard, regulation or person that is not there.',
  '- If the data does not answer something, say that it does not. Never estimate, never',
  '  extrapolate, and never describe what is "likely" or "typically" true of such a change.',
  '- Numbers are quoted exactly as given. Do not round, total, or recompute them.',
  '- Where the data says it is partial or truncated, say so in your answer.',
  '- You are advisory. The engineer decides. Do not instruct, approve, or reject.',
  '- Be brief and plain. No preamble, no restating the question, no headings unless asked.',
].join('\n');
