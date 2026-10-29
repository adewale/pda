/** Wire preconditions and refusal oracles for the local raw 0.3 agent probes. */
import { createHash } from "node:crypto";
import { authorization, decodeJwt, form, jsonBody, type Exchange } from "./har.ts";
import type { RunnerReply } from "./cell.ts";

const successful = (x: Exchange) => x.status >= 200 && x.status < 300;
const resourceUrl = (x: Exchange) => `${x.url.origin}${x.url.pathname}`;
const session = (x: Exchange) => decodeJwt(x.requestHeaders.get("poppy-session") ?? "");
const proof = (x: Exchange) => decodeJwt(x.requestHeaders.get("dpop") ?? "");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const stable = (claims: Record<string, unknown>, ignored: string[]) => Object.fromEntries(Object.entries(claims).filter(([key]) => !["iat", "jti", ...ignored].includes(key)));
function fresh(jwt: ReturnType<typeof decodeJwt>, x: Exchange): boolean {
  return !!jwt && typeof jwt.payload.jti === "string" && typeof jwt.payload.iat === "number" && jwt.payload.iat <= x.started / 1000 && jwt.payload.iat >= x.started / 1000 - 60;
}
/** Our probes deliberately mint 60-second assertions; expiry is a second rejection cause. */
function freshAssertion(jwt: ReturnType<typeof decodeJwt>, x: Exchange): boolean {
  return fresh(jwt, x) && typeof jwt!.payload.exp === "number" && jwt!.payload.exp > x.started / 1000 && jwt!.payload.exp > Number(jwt!.payload.iat) && jwt!.payload.exp - Number(jwt!.payload.iat) <= 60;
}
function boundSession(x: Exchange, ignore: string[] = []): boolean {
  const s = session(x), token = authorization(x)?.token;
  const ath = token ? createHash("sha256").update(token).digest("base64url") : undefined;
  return fresh(s, x) && s!.header.typ === "poppy-session+jwt" && s!.payload.htm === x.method && (ignore.includes("htu") || s!.payload.htu === resourceUrl(x)) && s!.payload.ath === ath;
}
function boundProof(x: Exchange): boolean {
  const p = proof(x), token = authorization(x)?.token;
  return fresh(p, x) && p!.header.typ === "dpop+jwt" && p!.payload.htm === x.method && p!.payload.htu === resourceUrl(x) && p!.payload.ath === (token ? createHash("sha256").update(token).digest("base64url") : undefined);
}
function equivalentSession(a: Exchange, b: Exchange, ignored: string[] = []): boolean {
  const x = session(a), y = session(b);
  return boundSession(a) && boundSession(b, ignored) && x!.payload.jti !== y!.payload.jti && canonical(x!.header) === canonical(y!.header) && canonical(stable(x!.payload, ignored)) === canonical(stable(y!.payload, ignored));
}
function sameToken(a: Exchange, b: Exchange): boolean {
  const first = a.requestHeaders.get("authorization");
  return !!first && first === b.requestHeaders.get("authorization");
}
function sameProofKey(a: Exchange, b: Exchange): boolean {
  const x = proof(a), y = proof(b);
  return !!x && !!y && canonical(x.header.jwk) === canonical(y.header.jwk);
}
function sameBody(a: Exchange, b: Exchange): boolean {
  return a.method === b.method && resourceUrl(a) === resourceUrl(b) && a.requestBody === b.requestBody;
}

/** Find both the accepted control and the precise mutation, never just a marker or an arbitrary 4xx. */
export function agentAttackEvidence(all: readonly Exchange[], marker: string): readonly [Exchange, Exchange] | undefined {
  const freshBinding = marker === "YR-fresh" || marker === "YD-fresh";
  const id = freshBinding ? marker.slice(0, 2) : marker;
  const requests = all.filter((x) => x.direction === "to-company" && !x.probe && !x.injected);
  for (const attack of requests.filter((x) => x.requestHeaders.get("x-interop-attack") === marker)) {
    const prior = requests.filter((x) => x.index < attack.index);
    const accepted = prior.filter(successful);
    for (const baseline of accepted) {
      if (id === "YR" || id === "YD") {
        const target = accepted.some((x) => x.method === attack.method && resourceUrl(x) === resourceUrl(attack) && sameToken(x, attack) && boundSession(x) && boundProof(x));
        if (!target || baseline.method !== attack.method || resourceUrl(baseline) === resourceUrl(attack) || !sameToken(baseline, attack)) continue;
        if (freshBinding) {
          const newSession = session(attack), oldProof = proof(baseline), newProof = proof(attack);
          if (id === "YR" && equivalentSession(baseline, attack, ["htu"]) && newSession!.payload.htu === resourceUrl(baseline) && boundProof(attack) && sameProofKey(baseline, attack) && !prior.some((x) => session(x)?.payload.jti === newSession!.payload.jti)) return [baseline, attack];
          if (id === "YD" && boundProof(baseline) && equivalentSession(baseline, attack, ["htu"]) && fresh(newProof, attack) && newProof!.payload.htm === attack.method && newProof!.payload.htu === resourceUrl(baseline) && canonical(oldProof!.header) === canonical(newProof!.header) && canonical(stable(oldProof!.payload, [])) === canonical(stable(newProof!.payload, [])) && !prior.some((x) => proof(x)?.payload.jti === newProof!.payload.jti)) return [baseline, attack];
          continue;
        }
        if (id === "YR" && boundSession(baseline) && baseline.requestHeaders.get("poppy-session") === attack.requestHeaders.get("poppy-session") && boundProof(attack) && sameProofKey(baseline, attack) && proof(baseline)?.payload.jti !== proof(attack)?.payload.jti) return [baseline, attack];
        if (id === "YD" && boundProof(baseline) && baseline.requestHeaders.get("dpop") === attack.requestHeaders.get("dpop") && equivalentSession(baseline, attack, ["htu"])) return [baseline, attack];
      }
      if (id === "YA" && sameBody(baseline, attack) && !authorization(baseline) && !authorization(attack) && equivalentSession(baseline, attack, ["aud"]) && session(baseline)?.payload.aud !== session(attack)?.payload.aud) return [baseline, attack];
      if (id === "YT" && sameBody(baseline, attack) && sameToken(baseline, attack) && equivalentSession(baseline, attack) && boundProof(baseline) && boundProof(attack) && !sameProofKey(baseline, attack)) return [baseline, attack];
      if (id === "YS" && baseline.method === "GET" && /\/orders$/.test(baseline.url.pathname) && attack.method === "POST" && /\/orders\/[^/]+\/exchanges$/.test(attack.url.pathname) && sameToken(baseline, attack) && equivalentSession(baseline, attack, ["htm", "htu"]) && boundProof(attack)) {
        const issued = accepted.find((x) => {
          const body = jsonBody(x.responseBody) as Record<string, unknown> | undefined;
          const scopes = typeof body?.scope === "string" ? body.scope.split(/\s+/) : [];
          return body?.access_token === authorization(attack)?.token && scopes.includes("orders:read") && !scopes.includes("orders:write");
        });
        if (issued) return [baseline, attack];
      }
      if (id === "YK") {
        const old = form(baseline), next = form(attack), body = jsonBody(baseline.responseBody) as Record<string, unknown> | undefined;
        const first = decodeJwt(old?.get("client_assertion") ?? ""), second = decodeJwt(next?.get("client_assertion") ?? "");
        if (old?.get("grant_type") === "refresh_token" && next?.get("grant_type") === "refresh_token" && sameBody({ ...baseline, requestBody: "" }, { ...attack, requestBody: "" }) && old.get("refresh_token") === next.get("refresh_token") && typeof body?.refresh_token === "string" && body.refresh_token !== old.get("refresh_token") && freshAssertion(first, baseline) && freshAssertion(second, attack) && first!.payload.jti !== second!.payload.jti && canonical(stable(first!.payload, ["exp"])) === canonical(stable(second!.payload, ["exp"])) && boundProof(baseline) && boundProof(attack) && sameProofKey(baseline, attack) && proof(baseline)?.payload.jti !== proof(attack)?.payload.jti) return [baseline, attack];
      }
      if (id === "YU" && baseline.method === "GET" && sameBody(baseline, attack) && boundSession(baseline) && boundSession(attack) && !authorization(baseline) && !authorization(attack) && session(baseline)?.payload.iss === session(attack)?.payload.iss && session(baseline)?.payload.sub !== session(attack)?.payload.sub) {
        const validOther = accepted.some((x) => x.method === "POST" && /\/poppy\/conversations$/.test(x.url.pathname) && session(x)?.payload.sub === session(attack)?.payload.sub && canonical(session(x)?.header) === canonical(session(attack)?.header) && boundSession(x));
        if (validOther) return [baseline, attack];
      }
    }
    if (id === "YM") {
      for (const baseline of prior) {
        const operation = (jsonBody(baseline.responseBody) as { operation?: { operation_id?: string; revision?: string } } | undefined)?.operation;
        const header = attack.requestHeaders.get("poppy-approval") ?? "";
        if (baseline.status === 403 && operation?.operation_id && operation.revision && sameBody(baseline, attack) && sameToken(baseline, attack) && equivalentSession(baseline, attack) && boundProof(attack) && header.includes(`operation_id=${JSON.stringify(operation.operation_id)}`) && !header.includes(`revision=${JSON.stringify(operation.revision)}`) && /revision="invented-/.test(header)) return [baseline, attack];
      }
    }
  }
}

export function agentAttackRejected(all: readonly Exchange[], marker: string): RunnerReply {
  const id = marker.replace(/-fresh$/, "");
  const pair = agentAttackEvidence(all, marker);
  if (!pair) return { kind: "failed", detail: `No accepted control and isolated ${id} mutation to judge` };
  const x = pair[1], body = jsonBody(x.responseBody) as { error?: unknown } | undefined;
  const challenge = x.responseHeaders.get("www-authenticate") ?? "";
  const correct = id === "YR" || id === "YA" ? x.status === 400 && body?.error === "invalid_session"
    : id === "YD" || id === "YT" ? x.status === 401 && /DPoP/i.test(challenge) && /error="invalid_dpop_proof"/.test(challenge)
    : id === "YS" ? x.status === 403 && /error="insufficient_scope"/.test(challenge)
    : id === "YK" ? x.status === 400 && body?.error === "invalid_grant"
    : id === "YU" ? x.status === 404 && body?.error === "conversation_not_found"
    : id === "YM" ? x.status === 403 && body?.error === "approval_required"
    : false;
  return correct ? { kind: "ok", result: { baseline: pair[0].index, attack: x.index } } : { kind: "failed", detail: `${id} answered HTTP ${x.status} ${String(body?.error ?? challenge)} instead of its required refusal` };
}

/** Exact duplicate of a successfully exchanged one-time authorization code, injected by our proxy. */
export function authorizationCodeReplay(all: readonly Exchange[]): readonly [Exchange, Exchange] | undefined {
  for (const original of all) {
    const fields = form(original), issued = jsonBody(original.responseBody) as { access_token?: unknown } | undefined;
    if (original.probe || original.injected || original.direction !== "to-company" || !successful(original) || fields?.get("grant_type") !== "authorization_code" || !fields.get("code") || typeof issued?.access_token !== "string") continue;
    const replay = all.find((x) => x.injected && x.direction === "to-company" && x.method === original.method && x.url.href === original.url.href && x.requestBody === original.requestBody && x.requestHeaders.get("dpop") === original.requestHeaders.get("dpop"));
    if (replay) return [original, replay];
  }
}
export function authorizationCodeReplayRejected(all: readonly Exchange[]): RunnerReply {
  const pair = authorizationCodeReplay(all);
  if (!pair) return { kind: "failed", detail: "No successfully exchanged authorization code followed by its exact injected replay" };
  const replay = pair[1], body = jsonBody(replay.responseBody) as { error?: unknown } | undefined;
  // Early assertion/proof replay rejection is permitted. This oracle proves
  // the duplicate grant minted no token; it doesn't require optional jti policy.
  return [400, 401].includes(replay.status) && ["invalid_grant", "invalid_client", "invalid_dpop_proof"].includes(String(body?.error))
    ? { kind: "ok", result: { original: pair[0].index, replay: replay.index } }
    : { kind: "failed", detail: `An exact authorization-code replay answered HTTP ${replay.status} ${String(body?.error)}` };
}

/** Same consumed authorization code and PKCE verifier, but fresh assertion and proof. */
export function authorizationCodeFreshReplay(all: readonly Exchange[]): readonly [Exchange, Exchange] | undefined {
  const requests = all.filter((x) => x.direction === "to-company" && !x.probe && !x.injected);
  for (const original of requests.filter(successful)) {
    const fields = form(original), issued = jsonBody(original.responseBody) as { access_token?: unknown } | undefined;
    if (fields?.get("grant_type") !== "authorization_code" || !fields.get("code") || typeof issued?.access_token !== "string") continue;
    const oldAssertion = decodeJwt(fields.get("client_assertion") ?? "");
    for (const replay of requests.filter((x) => x.index > original.index && x.requestHeaders.get("x-interop-attack") === "NREP-fresh")) {
      const next = form(replay), assertion = decodeJwt(next?.get("client_assertion") ?? "");
      const stableForm = (f: URLSearchParams) => canonical([...f.entries()].filter(([key]) => key !== "client_assertion").sort(([a], [b]) => a.localeCompare(b)));
      const proofs = !original.requestHeaders.has("dpop") && !replay.requestHeaders.has("dpop") || boundProof(original) && boundProof(replay) && sameProofKey(original, replay) && proof(original)!.payload.jti !== proof(replay)!.payload.jti;
      if (next && original.method === replay.method && original.url.href === replay.url.href && stableForm(fields) === stableForm(next) && freshAssertion(oldAssertion, original) && freshAssertion(assertion, replay) && canonical(oldAssertion!.header) === canonical(assertion!.header) && canonical(stable(oldAssertion!.payload, ["exp"])) === canonical(stable(assertion!.payload, ["exp"])) && oldAssertion!.payload.jti !== assertion!.payload.jti && proofs) return [original, replay];
    }
  }
}
export function authorizationCodeFreshReplayRejected(all: readonly Exchange[]): RunnerReply {
  const pair = authorizationCodeFreshReplay(all);
  if (!pair) return { kind: "failed", detail: "No consumed authorization code replay with fresh assertion and DPoP credentials" };
  const replay = pair[1], body = jsonBody(replay.responseBody) as { error?: unknown } | undefined;
  return replay.status === 400 && body?.error === "invalid_grant" ? { kind: "ok", result: { original: pair[0].index, replay: replay.index } } : { kind: "failed", detail: `Fresh-credential authorization-code replay answered HTTP ${replay.status} ${String(body?.error)}, expected 400 invalid_grant` };
}
