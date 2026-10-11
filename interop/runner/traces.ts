/**
 * `assert_trace` predicates (spec section 6): what a scenario requires the
 * recording so far to show. Each returns ok, failed, or inapplicable when
 * the recording has nothing to judge (a Company that never asked for a
 * nonce can't show the agent retrying with one), which makes the cell
 * unsupported rather than failed. Pure functions.
 */
import { decodeJwt, form, isServerMetadata, jsonBody, type Exchange } from "./har.ts";
import { retryAfterChecks } from "./checks.ts";
import type { RunnerReply } from "./cell.ts";

const agentRequests = (all: readonly Exchange[]) => all.filter((x) => x.direction === "to-company" && !x.probe);

function nonceChallenge(x: Exchange): string | null {
  const nonce = x.responseHeaders.get("dpop-nonce");
  if (!nonce) return null;
  const challenge = /error="use_dpop_nonce"/.test(x.responseHeaders.get("www-authenticate") ?? "");
  const body = jsonBody(x.responseBody) as { error?: unknown } | undefined;
  return challenge || body?.error === "use_dpop_nonce" ? nonce : null;
}

/** Every `use_dpop_nonce` answer is followed by a request to that origin whose proof carries the nonce. */
export function nonceRetry(all: readonly Exchange[]): RunnerReply {
  const requests = agentRequests(all);
  const challenges = requests.filter((x) => nonceChallenge(x) !== null);
  if (challenges.length === 0) return { kind: "inapplicable", detail: "the Company never answered use_dpop_nonce" };
  for (const challenge of challenges) {
    const nonce = nonceChallenge(challenge)!;
    const retried = requests.some(
      (x) => x.index > challenge.index && x.url.origin === challenge.url.origin && decodeJwt(x.requestHeaders.get("dpop") ?? "")?.payload.nonce === nonce
    );
    if (!retried) return { kind: "failed", detail: `no retry with the nonce after exchange ${challenge.index} (${challenge.url.pathname})` };
  }
  return { kind: "ok", result: { challenges: challenges.length } };
}

/** The Company's revocation endpoint was called and answered 200 (spec 4.9). */
export function revoked(all: readonly Exchange[]): RunnerReply {
  const endpoints = new Set<string>();
  for (const x of all) {
    if (x.direction !== "to-company" || !isServerMetadata(x)) continue;
    const metadata = jsonBody(x.responseBody) as { revocation_endpoint?: unknown } | undefined;
    if (typeof metadata?.revocation_endpoint === "string") endpoints.add(metadata.revocation_endpoint);
  }
  const calls = agentRequests(all).filter((x) => x.method === "POST" && endpoints.has(`${x.url.origin}${x.url.pathname}`));
  if (calls.length === 0) return { kind: "failed", detail: "no request to the revocation endpoint" };
  if (!calls.some((x) => x.status === 200)) return { kind: "failed", detail: `revocation answered ${calls.map((x) => x.status).join(", ")}` };
  return { kind: "ok", result: { revocations: calls.length } };
}

/** After the Company rotates an Account Token, the agent uses the new one, never the old (spec 4.8). */
export function refreshRotated(all: readonly Exchange[]): RunnerReply {
  const grants = agentRequests(all).filter((x) => form(x)?.get("grant_type") === "refresh_token");
  if (grants.length < 2) return { kind: "inapplicable", detail: `${grants.length} refresh_token grant(s); the scenario needs two` };
  let current: string | null = null;
  let rotations = 0;
  for (const grant of grants) {
    const sent = form(grant)!.get("refresh_token");
    if (current !== null && sent !== current) {
      return { kind: "failed", detail: `exchange ${grant.index} sent an Account Token the Company had replaced` };
    }
    const body = jsonBody(grant.responseBody) as { refresh_token?: unknown } | undefined;
    if (grant.status === 200 && typeof body?.refresh_token === "string") {
      if (body.refresh_token !== sent) rotations += 1;
      current = body.refresh_token;
    }
  }
  if (rotations === 0) return { kind: "inapplicable", detail: "the Company never rotated the Account Token" };
  return { kind: "ok", result: { grants: grants.length, rotations } };
}

/** A 429 with Retry-After came back, the agent tried again, and waited first. */
export function retryAfterRespected(all: readonly Exchange[]): RunnerReply {
  const requests = agentRequests(all);
  const limited = requests.filter((x) => x.status === 429 && x.responseHeaders.has("retry-after"));
  if (limited.length === 0) return { kind: "inapplicable", detail: "the Company never answered 429 with Retry-After" };
  const last = limited.at(-1)!;
  if (!requests.some((x) => x.index > last.index && x.peer === last.peer)) return { kind: "failed", detail: "the agent never tried again after the 429" };
  const early = retryAfterChecks(all);
  if (early.length > 0) return { kind: "failed", detail: early.map((item) => item.detail).join("; ") };
  return { kind: "ok", result: { limited: limited.length } };
}

/** A request matching `{method?, path, status?}` was recorded. */
export function requestSeen(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  const path = new RegExp(String(params.path ?? "."));
  const match = all.find(
    (x) =>
      !x.probe &&
      (params.method === undefined || x.method === params.method) &&
      path.test(x.url.pathname) &&
      (params.status === undefined || x.status === params.status)
  );
  return match ? { kind: "ok", result: { exchange: match.index } } : { kind: "failed", detail: `no request matching ${JSON.stringify(params)}` };
}

export const TRACE_ASSERTIONS: Record<string, (all: readonly Exchange[], params: Record<string, unknown>) => RunnerReply> = {
  nonce_retry: (all) => nonceRetry(all),
  revoked: (all) => revoked(all),
  refresh_rotated: (all) => refreshRotated(all),
  retry_after_respected: (all) => retryAfterRespected(all),
  request_seen: requestSeen
};

export function assertTrace(all: readonly Exchange[], params: unknown): RunnerReply {
  const input = params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const predicate = TRACE_ASSERTIONS[String(input.check)];
  if (!predicate) return { kind: "failed", detail: `unknown trace check ${JSON.stringify(input.check)}` };
  return predicate(all, input);
}
