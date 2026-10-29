import { describe, expect, it } from "vitest";
import { redirectChecks, tokenInUrlChecks, traceChecks, unlistedHostChecks } from "../runner/checks.ts";
import { assertTrace } from "../runner/traces.ts";
import { API, CLIENT_ID, jwt, NOW, recording, type Spec } from "./helpers.ts";

const ISSUER = "https://auth.acme.company.interop.test";
const SINK = "https://runner.interop.test/stolen";
const discovery: Spec[] = [
  { url: "https://acme.company.interop.test/.well-known/poppy.json", response: { protocol_version: "0.3", organization: { domain: "acme.company.interop.test" }, apis: [{ type: "openapi", url: `${API}/openapi.json` }] } },
  { url: "https://acme.company.interop.test/.well-known/oauth-protected-resource", response: { resource: "https://acme.company.interop.test", authorization_servers: [ISSUER] } },
  { url: `${ISSUER}/.well-known/oauth-authorization-server`, response: { issuer: ISSUER, token_endpoint: `${ISSUER}/oauth/token` } }
];

// The runner reads claim evidence, not signatures. Actual signature verification is the Company's check.
const session = (url = `${API}/products`, extra: Record<string, unknown> = {}) => jwt(
  { alg: "ES256", typ: "poppy-session+jwt" },
  { iss: CLIENT_ID, aud: ISSUER, sub: "usr_pairwise", sid: "sid_one", htm: "GET", htu: url, iat: NOW, jti: "jti_unique", ...extra }
);
const sent = (token = session()): Spec => ({ url: `${API}/products`, headers: { "poppy-session": token } });

describe("0.3 Session JWT leakage evidence", () => {
  it("accepts signed-out requests on the Company's listed API host without OAuth tokens", () => {
    const all = recording(...discovery, sent());
    expect(traceChecks(all)).toEqual([]);
    expect(assertTrace(all, { check: "token_not_sent_to", host: "runner.interop.test" }).kind).toBe("ok");
    expect(assertTrace(all, { check: "no_secret_in" }).kind).toBe("ok");
  });

  it("finds a signed-out Session header followed unchanged to a redirect sink", () => {
    const token = session();
    const all = recording(...discovery, { ...sent(token), status: 307, responseHeaders: { location: SINK } }, { url: SINK, headers: { "poppy-session": token } });
    expect(redirectChecks(all)).toMatchObject([{ id: "redirect.credentials-followed", severity: "error", basis: "MUST" }]);
    expect(unlistedHostChecks(all).map(check => check.id)).toEqual(["token.unlisted-host"]);
    expect(traceChecks(all).map(check => check.id)).toContain("token.unlisted-host");
    expect(assertTrace(all, { check: "token_not_sent_to", host: "runner.interop.test" }).kind).toBe("failed");
    expect(assertTrace(all, { check: "no_secret_in" }).kind).toBe("failed");
  });

  it("allows fresh request-bound Session JWTs on direct requests to listed hosts", () => {
    const next = `${API}/products-next`;
    const all = recording(...discovery, sent(), { url: next, headers: { "poppy-session": session(next, { jti: "jti_fresh" }) } });
    expect(traceChecks(all)).toEqual([]);
    expect(assertTrace(all, { check: "no_secret_in" }).kind).toBe("ok");
  });

  it("rejects a Session JWT on a protocol redirect even when it is freshly signed for a listed target", () => {
    const next = `${API}/products-next`;
    const all = recording(...discovery, { ...sent(), status: 307, responseHeaders: { location: next } }, { url: next, headers: { "poppy-session": session(next, { jti: "jti_fresh" }) } });
    expect(redirectChecks(all)).toMatchObject([{ id: "redirect.credentials-followed", severity: "error", basis: "MUST" }]);
  });

  it.each(["query", "body", "other-header"])("finds a Session JWT copied into the sink's %s", place => {
    const token = session();
    const leak: Spec = place === "query" ? { url: `${SINK}?proof=${encodeURIComponent(token)}` }
      : place === "body" ? { url: SINK, body: JSON.stringify({ proof: token }) }
      : { url: SINK, headers: { "x-leaked-proof": token } };
    const all = recording(...discovery, sent(token), leak);
    expect(unlistedHostChecks(all).map(check => check.id)).toEqual(["token.unlisted-host"]);
    expect(assertTrace(all, { check: "token_not_sent_to", host: "runner.interop.test" }).kind).toBe("failed");
    expect(assertTrace(all, { check: "no_secret_in" }).kind).toBe("failed");
    expect(tokenInUrlChecks(all).length).toBe(place === "query" ? 1 : 0);
  });

  it("finds a typed Session JWT first observed in a URL, with no earlier request or token issuance", () => {
    const all = recording(...discovery, { url: `${SINK}?proof=${session()}` });
    expect(tokenInUrlChecks(all).map(check => check.id)).toEqual(["secret.token-in-url"]);
    expect(unlistedHostChecks(all).map(check => check.id)).toEqual(["token.unlisted-host"]);
  });

  it("attributes the claimed issuer to its Company, not to the host receiving the JWT", () => {
    const all = recording(...discovery, { url: "https://api.other.company.interop.test/products", headers: { "poppy-session": session() } });
    expect(unlistedHostChecks(all)).toMatchObject([{ side: "agent", detail: "a token from acme sent to api.other.company.interop.test" }]);
  });

  it("uses protected-resource metadata when the issuer metadata was not recorded", () => {
    const all = recording(...discovery.slice(0, 2), { url: SINK, headers: { "poppy-session": session() } });
    expect(unlistedHostChecks(all).map(check => check.id)).toEqual(["token.unlisted-host"]);
  });

  it.each(["probe", "injected"])("does not blame the honest side for a %s leak", kind => {
    const token = session();
    const leaked: Spec = { url: `${SINK}?proof=${token}`, ...(kind === "injected" ? { injected: true } : { headers: { "x-interop-probe": "1" } }) };
    const all = recording(...discovery, { ...sent(token), status: 307, responseHeaders: { location: leaked.url } }, leaked);
    expect(redirectChecks(all)).toEqual([]);
    expect(unlistedHostChecks(all)).toEqual([]);
    expect(tokenInUrlChecks(all)).toEqual([]);
    expect(assertTrace(all, { check: "token_not_sent_to", host: "runner.interop.test" }).kind).toBe("ok");
  });
});
