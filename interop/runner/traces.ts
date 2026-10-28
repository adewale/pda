/**
 * `assert_trace` predicates (spec section 6): what a scenario requires the
 * recording so far to show. Each returns ok, failed, or inapplicable when
 * the recording has nothing to judge (a Company that never asked for a
 * nonce can't show the agent retrying with one), which makes the cell
 * unsupported rather than failed. Pure functions.
 */
import { authorization, decodeJwt, form, isServerMetadata, jsonBody, type Exchange } from "./har.ts";
import {
  browserJoins,
  browserSessionResponseChecks,
  clientDocuments,
  issuedTokens,
  retryAfterChecks,
  setCookies
} from "./checks.ts";
import type { RunnerReply } from "./cell.ts";

const agentRequests = (all: readonly Exchange[]) => all.filter((x) => x.direction === "to-company" && !x.probe && !x.injected);

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

/**
 * Scenario W (spec 6): the agent's browser loaded the join page and posted
 * its form, and the Company answered with a redirect and the Session's cookie. `followed` says
 * whether the browser then carried that cookie to where it was sent.
 * Inapplicable when the Company lists no browser-session endpoint; failed
 * when no join was accepted.
 */
export function browserJoined(all: readonly Exchange[]): RunnerReply {
  const joins = browserJoins(all);
  if (joins.length === 0) {
    const listed = all.some((x) => x.direction === "to-company" && /poppy\.json$/.test(x.url.pathname) && x.responseBody.includes("browser_session_endpoint"));
    return listed
      ? { kind: "failed", detail: "no browser join was sent to the Company's browser_session_endpoint" }
      : { kind: "inapplicable", detail: "the Company lists no web.browser_session_endpoint" };
  }
  const accepted = joins.find((x) => x.method === "POST" && x.status >= 300 && x.status < 400 && x.responseHeaders.has("location") && setCookies(x).length > 0);
  if (!accepted) {
    const problems = browserSessionResponseChecks(all).map((item) => item.detail);
    return { kind: "failed", detail: `no join answered 303 with a cookie (${joins.map((x) => `HTTP ${x.status}`).join(", ")}${problems.length ? `; ${problems.join("; ")}` : ""})` };
  }
  const target = new URL(accepted.responseHeaders.get("location")!, accepted.url).href;
  const pairs = setCookies(accepted).map((cookie) => cookie.split(";")[0]!.trim());
  const followed = all.some(
    (x) =>
      x.index > accepted.index &&
      !x.probe &&
      x.method === "GET" &&
      x.url.href === target &&
      pairs.every((pair) => (x.requestHeaders.get("cookie") ?? "").split(/;\s*/).includes(pair))
  );
  return { kind: "ok", result: { exchange: accepted.index, return_to: target, followed } };
}

/**
 * Scenario CM (4.1): the Company fetched the agent's client_id document,
 * and the jwks_uri it names with the key that signed the agent's first
 * granted Session assertion, before it granted that Session. Agents' keys
 * are new in every cell (interop spec 5.1), so a Session granted without
 * that fetch was granted on keys the Company never saw. Inapplicable when
 * the Company fetched nothing of the agent's (registered ahead of time, 4.1's MAY).
 */
export function clientFetched(all: readonly Exchange[]): RunnerReply {
  const fetches = all.filter((x) => x.direction === "to-agent" && !x.probe && x.method === "GET");
  if (fetches.length === 0) return { kind: "inapplicable", detail: "the Company fetched none of the agent's documents (registered ahead of time?)" };
  // The first request the Company accepted that needed the agent's keys: one with the Session header,
  // whose delegation a key in jwks_uri signed (5.3, step 1), or a token request with a client assertion (4.1).
  const grant = agentRequests(all)
    .filter((x) => x.status >= 200 && x.status < 300 && (x.requestHeaders.has("poppy-session") || form(x)?.has("client_assertion")))
    .sort((a, b) => a.ended - b.ended)[0];
  if (!grant) return { kind: "failed", detail: "no request that needs the agent's keys was accepted" };
  const header = grant.requestHeaders.get("poppy-session");
  const session = header ? decodeJwt(header) : null;
  const delegation = typeof session?.header.pap_dlg === "string" ? decodeJwt(session.header.pap_dlg) : null;
  const assertion = header ? null : decodeJwt(form(grant)?.get("client_assertion") ?? "");
  const signed = delegation ?? assertion;
  const clientId = (header ? null : form(grant)?.get("client_id")) ?? (typeof signed?.payload.iss === "string" ? signed.payload.iss : null);
  const kid = signed?.header.kid;
  const before = fetches.filter((x) => x.status === 200 && x.ended <= grant.ended);
  const metadata = before.find((x) => x.url.href === clientId);
  if (!metadata) return { kind: "failed", detail: `exchange ${grant.index} was accepted without a fetch of ${clientId} in this cell` };
  const { jwksUris } = clientDocuments(all);
  const jwks = before.find((x) => {
    if (!jwksUris.has(x.url.href)) return false;
    const keys = (jsonBody(x.responseBody) as { keys?: unknown } | undefined)?.keys;
    return Array.isArray(keys) && (typeof kid !== "string" || keys.some((key) => (key as { kid?: unknown } | null)?.kid === kid));
  });
  if (!jwks) return { kind: "failed", detail: `exchange ${grant.index} was accepted without a fetch of the jwks_uri holding kid ${JSON.stringify(kid)}` };
  return { kind: "ok", result: { client_id: clientId, metadata: metadata.index, jwks: jwks.index } };
}

// ---------------------------------------------------------------- Harm oracles (adversarial)

/** Every non-probe request, honest or injected: what the attacker and the honest side both sent. */
const anyRequest = (all: readonly Exchange[]) => all.filter((x) => !x.probe && x.direction !== "other");

/** A host matches when it equals or ends with `host` (`sink.interop.test` matches `evil.sink.interop.test`). */
function hostMatches(url: URL, host: string): boolean {
  const target = host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const name = url.host.toLowerCase();
  return name === target || name.endsWith(`.${target}`);
}

/** No request of the honest side reached `host`: an SSRF or redirect sink the agent must not call (XS). */
export function noRequestTo(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  const host = String(params.host ?? "");
  if (!host) return { kind: "failed", detail: "no_request_to needs a host" };
  const hit = anyRequest(all).find((x) => !x.injected && hostMatches(x.url, host));
  return hit ? { kind: "failed", detail: `a request to ${host} (exchange ${hit.index})` } : { kind: "ok", result: { host } };
}

/** The strings that carry a token, so a leak can be spotted: every issued access and refresh token, plus any `nonce` secret the scenario planted. */
function secrets(all: readonly Exchange[], extra: readonly string[] = []): string[] {
  return [...issuedTokens(all).keys(), ...extra].filter((value) => typeof value === "string" && value.length >= 8);
}

/** No token the Company issued was sent to `host`: a token-theft sink (XH, XM, XS). */
export function tokenNotSentTo(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  const host = String(params.host ?? "");
  if (!host) return { kind: "failed", detail: "token_not_sent_to needs a host" };
  const tokens = secrets(all);
  for (const x of anyRequest(all)) {
    if (x.injected || !hostMatches(x.url, host)) continue;
    const auth = authorization(x);
    const haystack = `${x.url.href} ${x.requestBody} ${auth?.token ?? ""}`;
    const leaked = tokens.find((token) => haystack.includes(token));
    if (leaked) return { kind: "failed", detail: `a token reached ${host} (exchange ${x.index})` };
  }
  return { kind: "ok", result: { host, tokens: tokens.length } };
}

/** An action was performed at most once: at most one 2xx answered a matching request (duplicate/replay idempotency, S9, Ops). */
export function performedAtMostOnce(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  const path = new RegExp(String(params.path ?? "."));
  const method = params.method === undefined ? undefined : String(params.method);
  const matching = anyRequest(all).filter(
    (x) => path.test(x.url.pathname) && (method === undefined || x.method === method) && x.status >= 200 && x.status < 300
  );
  if (matching.length === 0) return { kind: "inapplicable", detail: `no 2xx to ${method ?? ""} ${params.path}` };
  return matching.length <= 1
    ? { kind: "ok", result: { performed: matching.length } }
    : { kind: "failed", detail: `${matching.length} successes for ${method ?? ""} ${params.path} (exchanges ${matching.map((x) => x.index).join(", ")})` };
}

/** No 2xx answered a replayed (injected) request: the Company caught the replay (YR, YD, proxy replay). */
export function no2xxAfter(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  const path = params.path === undefined ? undefined : new RegExp(String(params.path));
  const injected = all.filter((x) => x.injected && x.direction !== "other" && (!path || path.test(x.url.pathname)));
  if (injected.length === 0) return { kind: "inapplicable", detail: "no replayed request was injected" };
  const ok = injected.find((x) => x.status >= 200 && x.status < 300);
  return ok ? { kind: "failed", detail: `a replayed request was accepted (${ok.status} at exchange ${ok.index})` } : { kind: "ok", result: { replays: injected.length } };
}

/** A planted secret or canary never left in an outbound request (XJ injected text, canary exfiltration). */
export function noSecretIn(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  const planted = Array.isArray(params.values) ? params.values.map(String) : params.value !== undefined ? [String(params.value)] : [];
  const tokens = secrets(all, planted);
  if (tokens.length === 0) return { kind: "inapplicable", detail: "no secret to look for" };
  for (const x of anyRequest(all)) {
    if (x.injected) continue;
    const haystack = `${x.url.href} ${x.requestBody} ${authorization(x)?.token ?? ""}`;
    const leaked = tokens.find((secret) => haystack.includes(secret));
    if (leaked) return { kind: "failed", detail: `a secret appeared in a request to ${x.url.host} (exchange ${x.index})` };
  }
  return { kind: "ok", result: { watched: tokens.length } };
}

/** The honest side made at most `max` requests matching `{path, method?}`: a bounded retry, never a loop (XN, XB). */
export function boundedRequests(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  const path = new RegExp(String(params.path ?? "."));
  const method = params.method === undefined ? undefined : String(params.method);
  const max = typeof params.max === "number" ? params.max : 3;
  const matching = agentRequests(all).filter((x) => path.test(x.url.pathname) && (method === undefined || x.method === method));
  if (matching.length === 0) return { kind: "inapplicable", detail: `no request to ${method ?? ""} ${params.path}` };
  return matching.length <= max
    ? { kind: "ok", result: { requests: matching.length, max } }
    : { kind: "failed", detail: `${matching.length} requests to ${method ?? ""} ${params.path}, more than ${max} (exchanges ${matching.map((x) => x.index).join(", ")})` };
}

/**
 * The attack precondition (spec §6): the trace shows the attack happened, or
 * the cell is in error with blame `harness` (cell.ts turns a failed
 * attack_observed into an error). A matching request or response, honest or
 * injected, counts; `injected: true` requires the proxy to have injected one.
 */
export function attackObserved(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  if (params.mutation === "client_audience") {
    const pair = audiencePair(all);
    return pair ? { kind: "ok", result: { baseline: pair[0].index, attack: pair[1].index } }
      : { kind: "failed", detail: "the audience attack wasn't observed: no accepted baseline followed by only a client-audience mutation with fresh credentials" };
  }
  if (params.replay !== undefined) {
    const pair = replayPair(all, params);
    return pair ? { kind: "ok", result: { baseline: pair[0].index, replay: pair[1].index } }
      : { kind: "failed", detail: "the attack wasn't observed: no accepted baseline followed by the intended credential replay" };
  }
  const path = params.path === undefined ? undefined : new RegExp(String(params.path));
  const method = params.method === undefined ? undefined : String(params.method);
  const status = typeof params.status === "number" ? params.status : undefined;
  const wantInjected = params.injected === true;
  const contains = params.body_contains === undefined ? undefined : String(params.body_contains);
  const match = all.find(
    (x) =>
      !x.probe &&
      x.direction !== "other" &&
      (!wantInjected || x.injected) &&
      (!path || path.test(x.url.pathname)) &&
      (method === undefined || x.method === method) &&
      (status === undefined || x.status === status) &&
      (contains === undefined || `${x.requestBody} ${x.responseBody}`.includes(contains))
  );
  return match ? { kind: "ok", result: { exchange: match.index } } : { kind: "failed", detail: `the attack wasn't observed (${JSON.stringify(params)})` };
}

/** Our probes mint 60-second credentials. Expiry, future iat or excessive
 * lifetime would introduce a second rejection cause, independently of the mutation.
 * This is an evidence precondition, not a claim about a peer's clock policy.
 */
function currentAttackCredentials(exchange: Exchange): boolean {
  const fields = form(exchange);
  if (fields?.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return false;
  const at = exchange.started / 1000;
  const valid = (value: string | null | undefined, proof = false) => {
    const claims = value ? decodeJwt(value)?.payload : undefined;
    if (!claims || !Number.isInteger(claims.iat) || typeof claims.iat !== "number" || claims.iat > at || at - claims.iat > 60) return false;
    if (proof && claims.exp === undefined) return true;
    return typeof claims.exp === "number" && Number.isInteger(claims.exp) && claims.exp > at && claims.exp > claims.iat && claims.exp - claims.iat <= 60;
  };
  return valid(fields.get("client_assertion")) && valid(fields.get("assertion")) && valid(exchange.requestHeaders.get("dpop"), true);
}

/** Compare fresh credentials after their validity windows have been checked. */
function freshJwt(a: string | null | undefined, b: string | null | undefined, ignored: readonly string[] = []): boolean {
  const old = a ? decodeJwt(a) : null, next = b ? decodeJwt(b) : null;
  if (!old || !next || typeof old.payload.jti !== "string" || typeof next.payload.jti !== "string" || old.payload.jti === next.payload.jti) return false;
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x.localeCompare(y))) : item);
  const stable = (payload: Record<string, unknown>) => Object.fromEntries(Object.entries(payload)
    .filter(([key]) => !["jti", "iat", "exp", ...ignored].includes(key)));
  return canonical(old.header) === canonical(next.header) && canonical(stable(old.payload)) === canonical(stable(next.payload));
}

function sameOrigin(value: string, url: URL): boolean {
  try {
    return new URL(value).origin === url.origin;
  } catch {
    return false;
  }
}

/** Accepted setup, then a foreign audience with matching stable wire fields and current credentials. */
function audiencePair(all: readonly Exchange[]): readonly [Exchange, Exchange] | undefined {
  const requests = agentRequests(all).filter((x) => x.method === "POST" && form(x)?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && currentAttackCredentials(x));
  for (const baseline of requests) {
    const body = jsonBody(baseline.responseBody) as Record<string, unknown> | undefined;
    if (baseline.status !== 200 || typeof body?.access_token !== "string" || !body.access_token || typeof body.session_id !== "string" || !body.session_id) continue;
    const original = form(baseline)!;
    const oldClient = original.get("client_assertion");
    const originalAud = oldClient ? decodeJwt(oldClient)?.payload.aud : undefined;
    const oldProof = baseline.requestHeaders.get("dpop");
    const nonce = baseline.responseHeaders.get("dpop-nonce") ?? (oldProof ? decodeJwt(oldProof)?.payload.nonce : undefined);
    // The accepted baseline names this Company: the token endpoint (0.1) or the issuer (0.2, same origin).
    if (typeof originalAud !== "string" || !sameOrigin(originalAud, baseline.url)) continue;
    for (const attack of requests) {
      if (attack.index <= baseline.index || attack.url.href !== baseline.url.href) continue;
      const fields = form(attack)!;
      const client = fields.get("client_assertion");
      const aud = client ? decodeJwt(client)?.payload.aud : undefined;
      const proof = attack.requestHeaders.get("dpop");
      if (typeof aud !== "string" || aud === originalAud) continue;
      if (fields.get("client_id") !== original.get("client_id") || fields.get("client_assertion_type") !== original.get("client_assertion_type")) continue;
      if (!freshJwt(oldClient, client, ["aud"]) || !freshJwt(original.get("assertion"), fields.get("assertion"))) continue;
      if (!freshJwt(oldProof, proof, ["nonce"]) || (proof ? decodeJwt(proof)?.payload.nonce : undefined) !== nonce) continue;
      return [baseline, attack];
    }
  }
}

/** An unrelated error or nonce negotiation is not evidence of audience validation. */
export function audienceRejected(all: readonly Exchange[]): RunnerReply {
  const pair = audiencePair(all);
  if (!pair) return { kind: "failed", detail: "no audience mutation to judge" };
  const attack = pair[1];
  if (attack.status === 400 && nonceChallenge(attack)) return { kind: "inapplicable", detail: "audience mutation received only a nonce challenge; audience validation remains untested" };
  const body = jsonBody(attack.responseBody) as { error?: unknown } | undefined;
  return [400, 401].includes(attack.status) && body?.error === "invalid_client"
    ? { kind: "ok", result: { exchange: attack.index, error: "invalid_client" } }
    : { kind: "failed", detail: `audience mutation answered HTTP ${attack.status}, expected 400/401 invalid_client` };
}

/** Wire evidence of one reused credential, with independent one-shot credentials kept fresh. */
function replayPair(all: readonly Exchange[], params: Record<string, unknown>): readonly [Exchange, Exchange] | undefined {
  if (params.replay !== "assertion" && params.replay !== "dpop") return;
  const path = new RegExp(String(params.path ?? "/oauth/token"));
  const requests = agentRequests(all).filter((x) => x.method === "POST" && path.test(x.url.pathname) && form(x)?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && currentAttackCredentials(x));
  for (const baseline of requests) {
    const body = jsonBody(baseline.responseBody) as Record<string, unknown> | undefined;
    if (baseline.status !== 200 || typeof body?.access_token !== "string" || !body.access_token || typeof body.session_id !== "string" || !body.session_id) continue;
    const original = form(baseline)!;
    const originalProof = baseline.requestHeaders.get("dpop");
    const assertion = original.get("assertion");
    const client = original.get("client_assertion");
    if (!originalProof || !assertion || !client) continue;
    const claims = (jwt: string | null | undefined) => jwt ? decodeJwt(jwt) : null;
    for (const replay of requests) {
      if (replay.index <= baseline.index || replay.url.href !== baseline.url.href) continue;
      const fields = form(replay)!;
      const dpop = replay.requestHeaders.get("dpop");
      if (fields.get("client_id") !== original.get("client_id") || !freshJwt(client, fields.get("client_assertion"))) continue;
      const expectedNonce = baseline.responseHeaders.get("dpop-nonce") ?? claims(originalProof)?.payload.nonce;
      if (params.replay === "assertion" ? fields.get("assertion") === assertion && freshJwt(originalProof, dpop, ["nonce"]) && claims(dpop)?.payload.nonce === expectedNonce
        : dpop === originalProof && freshJwt(assertion, fields.get("assertion"))) return [baseline, replay];
    }
  }
}

/** Judge the observed replay, separately from proving it was sent. A nonce refusal proves no replay-cache behavior. */
export function replayRejected(all: readonly Exchange[], params: Record<string, unknown>): RunnerReply {
  const pair = replayPair(all, params);
  if (!pair) return { kind: "failed", detail: "no replay to judge" };
  const replay = pair[1];
  const body = jsonBody(replay.responseBody) as { error?: unknown } | undefined;
  if (replay.status === 400 && nonceChallenge(replay)) return { kind: "inapplicable", detail: "replay received only a nonce challenge; replay-cache protection remains untested" };
  const expected = params.replay === "assertion" ? "invalid_grant" : "invalid_dpop_proof";
  return replay.status === 400 && body?.error === expected
    ? { kind: "ok", result: { exchange: replay.index, error: expected } }
    : { kind: "failed", detail: `replay answered HTTP ${replay.status}, expected 400 ${expected}` };
}

export const TRACE_ASSERTIONS: Record<string, (all: readonly Exchange[], params: Record<string, unknown>) => RunnerReply> = {
  nonce_retry: (all) => nonceRetry(all),
  revoked: (all) => revoked(all),
  refresh_rotated: (all) => refreshRotated(all),
  retry_after_respected: (all) => retryAfterRespected(all),
  request_seen: requestSeen,
  browser_joined: (all) => browserJoined(all),
  client_fetched: (all) => clientFetched(all),
  no_request_to: noRequestTo,
  token_not_sent_to: tokenNotSentTo,
  performed_at_most_once: performedAtMostOnce,
  no_2xx_after: no2xxAfter,
  no_secret_in: noSecretIn,
  bounded_requests: boundedRequests,
  attack_observed: attackObserved,
  replay_rejected: replayRejected,
  audience_rejected: (all) => audienceRejected(all)
};

export function assertTrace(all: readonly Exchange[], params: unknown): RunnerReply {
  const input = params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const predicate = TRACE_ASSERTIONS[String(input.check)];
  if (!predicate) return { kind: "failed", detail: `unknown trace check ${JSON.stringify(input.check)}` };
  return predicate(all, input);
}
