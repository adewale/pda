import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readingChecks } from "../runner/readings.ts";
import { assertTrace, nonceRetry, refreshRotated, retryAfterRespected, revoked } from "../runner/traces.ts";
import { API, clientAssertion, jwt, NOW, proof, recording, sessionStart, TOKEN } from "./helpers.ts";

const challenge = { url: TOKEN, form: { grant_type: "refresh_token" }, status: 400, responseHeaders: { "dpop-nonce": "n1" }, response: { error: "use_dpop_nonce" } };
const withNonce = (nonce: string) => ({ url: TOKEN, form: { grant_type: "refresh_token" }, headers: { dpop: proof("POST", TOKEN, { payload: { nonce } }) } });
const refresh = (sent: string, issued?: string, at = 0) => ({ url: TOKEN, at, form: { grant_type: "refresh_token", refresh_token: sent }, response: { access_token: "a", token_type: "DPoP", expires_in: 60, session_id: "s", ...(issued ? { refresh_token: issued } : {}) } });

describe("assert_trace predicates", () => {
  it("nonce_retry: inapplicable without a challenge, ok after a retry with the nonce, failed without", () => {
    expect(nonceRetry(recording(sessionStart())).kind).toBe("inapplicable");
    expect(nonceRetry(recording(challenge, withNonce("n1"))).kind).toBe("ok");
    expect(nonceRetry(recording(challenge, withNonce("stale"))).kind).toBe("failed");
  });

  it("refresh_rotated: the agent always sends the newest Account Token", () => {
    expect(refreshRotated(recording(refresh("rt1", "rt2"), refresh("rt2", "rt3"))).kind).toBe("ok");
    expect(refreshRotated(recording(refresh("rt1", "rt2"), refresh("rt1", "rt3"))).kind).toBe("failed");
    expect(refreshRotated(recording(refresh("rt1"), refresh("rt1"))).kind).toBe("inapplicable");
    expect(refreshRotated(recording(refresh("rt1", "rt2"))).kind).toBe("inapplicable");
  });

  it("retry_after_respected: needs a 429, a retry, and a wait", () => {
    const limited = { url: `${API}/products`, status: 429, responseHeaders: { "retry-after": "1" } };
    expect(retryAfterRespected(recording({ url: `${API}/products` })).kind).toBe("inapplicable");
    expect(retryAfterRespected(recording(limited)).kind).toBe("failed");
    expect(retryAfterRespected(recording(limited, { url: `${API}/products`, at: 1_100 })).kind).toBe("ok");
    expect(retryAfterRespected(recording(limited, { url: `${API}/products`, at: 200 })).kind).toBe("failed");
  });

  it("revoked: the metadata's revocation endpoint answered 200", () => {
    const metadata = { url: "https://auth.acme.company.interop.test/.well-known/oauth-authorization-server", response: { revocation_endpoint: "https://auth.acme.company.interop.test/oauth/revoke" } };
    expect(revoked(recording(metadata, { url: "https://auth.acme.company.interop.test/oauth/revoke", form: { token: "x" } })).kind).toBe("ok");
    expect(revoked(recording(metadata)).kind).toBe("failed");
  });

  it("revoked: reads metadata where either S3 reading puts it for an issuer with a path", () => {
    const revoke = "https://acme.company.interop.test/poppy/oauth/revoke";
    for (const path of ["/poppy/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/poppy"]) {
      const metadata = { url: `https://acme.company.interop.test${path}`, response: { revocation_endpoint: revoke } };
      expect(revoked(recording(metadata, { url: revoke, form: { token: "x" } })).kind).toBe("ok");
    }
  });

  it("D sees server metadata at either S3 location, and nothing else", () => {
    const d = JSON.parse(readFileSync(new URL("../scenarios/D.json", import.meta.url), "utf8")) as { steps: { runner?: string; params?: Record<string, unknown> }[] };
    const params = d.steps.filter((step) => step.runner === "assert_trace").at(-1)!.params!;
    const seen = (path: string) => assertTrace(recording({ url: `https://acme.company.interop.test${path}` }), params).kind;
    expect(seen("/.well-known/oauth-authorization-server")).toBe("ok");
    expect(seen("/.well-known/oauth-authorization-server/poppy")).toBe("ok");
    expect(seen("/poppy/.well-known/oauth-authorization-server")).toBe("ok");
    expect(seen("/.well-known/oauth-authorization-server-x")).toBe("failed");
    expect(seen("/.well-known/poppy.json")).toBe("failed");
  });

  it("request_seen and unknown checks", () => {
    const all = recording({ url: "https://acme.company.interop.test/.well-known/poppy.json" });
    expect(assertTrace(all, { check: "request_seen", path: "poppy\\.json$", status: 200 }).kind).toBe("ok");
    expect(assertTrace(all, { check: "request_seen", path: "nothing" }).kind).toBe("failed");
    expect(assertTrace(all, { check: "nope" }).kind).toBe("failed");
  });
});

describe("readings against the trace", () => {
  const metadata = { url: "https://auth.acme.company.interop.test/.well-known/oauth-authorization-server", response: { issuer: "https://auth.acme.company.interop.test", token_endpoint: TOKEN } };

  it("accepts an agent that does what it declares", () => {
    expect(readingChecks(recording(metadata, sessionStart()), { S1: "token-endpoint", S2: "jwt-60s", S4: "omit" })).toEqual([]);
  });

  it("warns when the trace contradicts a declared reading", () => {
    const issuerAud = clientAssertion({ payload: { aud: "https://auth.acme.company.interop.test" } });
    const long = jwt({ alg: "ES256", kid: "k1" }, { iss: "x", sub: "u", aud: TOKEN, iat: NOW, exp: NOW + 300, jti: "j".repeat(22) });
    const start = sessionStart(0, { client: issuerAud, assertion: long });
    const scoped = { ...start, form: { ...start.form!, scope: "poppy:read" } };
    const checks = readingChecks(recording(metadata, scoped), { S1: "token-endpoint", S2: "jwt-60s", S4: "omit" });
    expect(checks.map((check) => check.id)).toEqual(["reading.S1", "reading.S2", "reading.S4"]);
    expect(checks.every((check) => check.severity === "warning")).toBe(true);
  });

  it("finds the endpoints in metadata appended to an issuer's path (S3 append)", () => {
    const appended = { url: "https://acme.company.interop.test/poppy/.well-known/oauth-authorization-server", response: { issuer: "https://acme.company.interop.test/poppy", token_endpoint: TOKEN } };
    const issuerAud = clientAssertion({ payload: { aud: "https://acme.company.interop.test/poppy" } });
    const checks = readingChecks(recording(appended, sessionStart(0, { client: issuerAud })), { S1: "token-endpoint" });
    expect(checks.map((check) => check.id)).toEqual(["reading.S1"]);
  });
});
