/**
 * A fixed-window counter, in process memory.
 *
 * WHY THIS EXISTS. Every other endpoint in this product costs a database query; the AI
 * endpoints cost money, on somebody's metered provider account, per call. With
 * bring-your-own-key that somebody is usually the caller themselves, which makes a runaway
 * loop their bill rather than the operator's — and is exactly why the limit is per user and
 * not per deployment. Nobody's mistake should be payable out of anybody else's account.
 *
 * IN PROCESS, AND THEREFORE PER CONTAINER. With a second API container the effective limit
 * doubles. That is stated rather than hidden: a shared counter needs Redis or a table, and a
 * table write per request is its own cost. The bound that matters is "a stuck retry loop
 * cannot spend a thousand calls", not "exactly twenty".
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/*
 * Expired entries are swept on a timer rather than on a size threshold.
 *
 * The threshold version scanned the whole map on EVERY request once the map was big — and if
 * the entries were big because they were all live, the scan deleted nothing and ran again on
 * the next request. That converts load into more load, which is the wrong shape for a
 * limiter.
 *
 * Nothing further is needed to bound the memory here, because the keys are one per user per
 * feature: the key space is the user table, not the set of addresses that can reach a public
 * endpoint. A limiter keyed on something an attacker can multiply would need a hard cap and
 * an eviction policy as well.
 */
const SWEEP_INTERVAL_MS = 60_000;
let nextSweep = 0;

function prune(now: number): void {
  if (now < nextSweep) return;
  nextSweep = now + SWEEP_INTERVAL_MS;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/**
 * Consume one unit against `key`. Returns false when the window is already full.
 *
 * The window does not slide: it resets `windowMs` after the first request in it. A caller who
 * exhausts a window waits at most that long, and the counter costs one map entry per key.
 */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  prune(now);
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

/** Test seam. The window map is module state, and a suite that shares it is a flaky suite. */
export function resetRateLimits(): void {
  windows.clear();
  nextSweep = 0;
}

/** Test seam: how many windows are being tracked right now. */
export function rateLimitSize(): number {
  return windows.size;
}
