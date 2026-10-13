/**
 * How often the agent goes back to a Company when nothing is happening:
 * conversation reads (`nextRead` in conversations.ts) and operation tracking
 * (`trackOperation` in operations.ts). The Guides ask Personal Agents to
 * "check for changes no more often than the task needs"; a Company's word
 * that it is busy, or a short `Retry-After`, is no reason to check every
 * second for ever (interop scenarios XR and XT).
 */

/** A quarter of the quiet time, at least `floorMs`, at most 15 minutes, or an hour once it has been quiet a day. */
export function backoff(quietForMs: number, floorMs: number): number {
  const ceiling = quietForMs >= 24 * 60 * 60_000 ? 60 * 60_000 : 15 * 60_000;
  return Math.min(ceiling, Math.max(floorMs, quietForMs / 4));
}
