import { describe, expect, it } from "vitest";
import { basisOf, VIOLATION_IDS, type ViolationId } from "../../test/mock-company/violations.ts";
import {
  assertionChecks,
  authorizationResponseChecks,
  companyChecks,
  dpopChecks,
  redirectChecks,
  retryAfterChecks,
  TRACE_CHECKS,
  tokenInUrlChecks,
  traceChecks,
  unlistedHostChecks
} from "../runner/checks.ts";
import { API, clientAssertion, jti, jwt, NOW, proof, recording, sessionStart, TOKEN } from "./helpers.ts";

const ids = (checks: { id: string; severity: string }[]) => checks.map((check) => `${check.id}:${check.severity}`);

/** poppy.json and metadata for acme, naming its API host. */
const DISCOVERY = [
  {
    url: "https://acme.company.interop.test/.well-known/poppy.json",
    response: { protocol_version: "0.1", organization: { name: "Acme", domain: "acme.company.interop.test" }, auth: { issuer: "https://auth.acme.company.interop.test" }, apis: [{ type: "openapi", url: `${API}/openapi.json`, description: "x" }] }
  },
  { url: "https://auth.acme.company.interop.test/.well-known/oauth-authorization-server", response: { issuer: "https://auth.acme.company.interop.test", token_endpoint: TOKEN } }
];

describe("trace checks", () => {
  it("names checks with the mock Company's violation ids where it says so", () => {
    for (const [id, spec] of Object.entries(TRACE_CHECKS)) {
      if (spec.mock) expect(VIOLATION_IDS, id).toContain(id);
      else expect(VIOLATION_IDS, id).not.toContain(id);
      if (spec.side === "company") expect(id.startsWith("company."), id).toBe(true);
    }
  });

  it("rest on the mock's basis where they share its id, so the grid and the mock agree on each level", () => {
    const disagree = Object.entries(TRACE_CHECKS).filter(([id, spec]) => spec.mock && basisOf(id as ViolationId) !== spec.basis);
    expect(disagree.map(([id]) => id)).toEqual([]);
  });

  it("finds nothing wrong with a correct Session start", () => {
    expect(traceChecks(recording(...DISCOVERY, sessionStart()))).toEqual([]);
  });

  it("warns about an assertion without typ or living too long (readings), and errors on one reused (a rule)", () => {
    const reused = clientAssertion();
    const checks = assertionChecks(
      recording(
        sessionStart(0, { client: clientAssertion({ header: { typ: undefined } }) }),
        sessionStart(1, { client: reused }),
        sessionStart(2, { client: reused }),
        sessionStart(3, { client: clientAssertion({ payload: { exp: NOW + 120 } }) }),
        sessionStart(4, { client: clientAssertion({ payload: { exp: NOW + 600 } }) })
      )
    );
    expect(ids(checks)).toEqual([
      "client-assertion.typ:warning",
      "client-assertion.jti-reused:error",
      "client-assertion.lifetime:warning",
      "client-assertion.lifetime:warning"
    ]);
  });

  it("checks a Session assertion's audience and issuer", () => {
    const assertion = jwt({ alg: "ES256", kid: "k1", typ: "JWT" }, { iss: "https://other.example/c.json", sub: "usr_1", aud: [TOKEN], iat: NOW, exp: NOW + 60, jti: jti() });
    expect(ids(assertionChecks(recording(sessionStart(0, { assertion }))))).toEqual(["session-assertion.aud:error", "session-assertion.iss:error"]);
  });

  it("checks a client assertion's iss, sub and aud form", () => {
    const client = clientAssertion({ payload: { sub: "someone", aud: [TOKEN] } });
    expect(ids(assertionChecks(recording(sessionStart(0, { client }))))).toEqual(["client-assertion.aud-array:warning", "client-assertion.iss-sub:error"]);
  });

  it("checks DPoP proofs: htm, htu, iat, typ, ath and jti", () => {
    const url = `${API}/orders`;
    const token = "at_session_token_1";
    const reused = proof("GET", url, { token });
    const checks = dpopChecks(
      recording(
        { url: `${url}?page=2`, headers: { authorization: `DPoP ${token}`, dpop: proof("GET", url, { token }) } },
        { url, headers: { authorization: `DPoP ${token}`, dpop: proof("POST", url, { token }) } },
        { url, headers: { authorization: `DPoP ${token}`, dpop: proof("GET", `${url}?page=2`, { token }) } },
        { url, headers: { authorization: `DPoP ${token}`, dpop: proof("GET", url, { token, payload: { iat: NOW - 600 } }) } },
        { url, headers: { authorization: `DPoP ${token}`, dpop: proof("GET", url, { token, header: { typ: "JWT" } }) } },
        { url, headers: { authorization: `DPoP ${token}`, dpop: proof("GET", url, { token: "another" }) } },
        { url, headers: { authorization: `DPoP ${token}`, dpop: reused } },
        { url, headers: { authorization: `DPoP ${token}`, dpop: reused } }
      )
    );
    expect(ids(checks)).toEqual(["dpop.htm:error", "dpop.htu:error", "dpop.iat:error", "dpop.typ:error", "dpop.ath:error", "dpop.jti-reused:error"]);
  });

  it("finds a token in a URL", () => {
    const checks = tokenInUrlChecks(recording(sessionStart(), { url: `${API}/orders?token=at_session_token_1` }, { url: `${API}/orders?access_token=x` }));
    expect(ids(checks)).toEqual(["secret.token-in-url:error", "secret.token-in-url:error"]);
  });

  it("finds a Session Token sent to a host the Company didn't list", () => {
    const send = (url: string) => ({ url, headers: { authorization: "DPoP at_session_token_1", dpop: proof("GET", url, { token: "at_session_token_1" }) } });
    const checks = unlistedHostChecks(recording(...DISCOVERY, sessionStart(), send(`${API}/orders`), send("https://cdn.acme.company.interop.test/x"), send("https://evil.company.interop.test/x")));
    expect(checks.map((check) => check.detail)).toEqual([
      "a token from acme sent to cdn.acme.company.interop.test",
      "a token from acme sent to evil.company.interop.test"
    ]);
  });

  it("finds a redirect followed with credentials", () => {
    const url = `${API}/orders`;
    const checks = redirectChecks(
      recording(
        { url, headers: { authorization: "DPoP t" }, status: 302, responseHeaders: { location: "https://elsewhere.company.interop.test/orders" } },
        { url: "https://elsewhere.company.interop.test/orders", headers: { authorization: "DPoP t" } }
      )
    );
    expect(ids(checks)).toEqual(["redirect.credentials-followed:warning"]);
  });

  it("finds a request sent before Retry-After elapsed, allowing for the proxy's clock", () => {
    const limited = { url: `${API}/products`, at: 0, time: 10, status: 429, responseHeaders: { "retry-after": "1" } };
    expect(retryAfterChecks(recording(limited, { url: `${API}/products`, at: 500 }))).toHaveLength(1);
    expect(retryAfterChecks(recording(limited, { url: `${API}/products`, at: 950 }))).toEqual([]);
    expect(retryAfterChecks(recording(limited, { url: "https://api.other.company.interop.test/x", at: 20 }))).toEqual([]);
  });

  it("checks Company responses: WWW-Authenticate, Retry-After, OAuth errors, token responses", () => {
    const checks = companyChecks(
      recording(
        { url: `${API}/orders`, headers: { authorization: "DPoP t" }, status: 401, response: { error: "invalid_token" } },
        { url: `${API}/orders`, status: 429 },
        { url: TOKEN, form: { grant_type: "refresh_token" }, status: 400, response: "Bad Request" },
        { url: TOKEN, form: { grant_type: "refresh_token" }, response: { access_token: "a", token_type: "DPoP" } }
      )
    );
    expect(ids(checks)).toEqual(["company.www-authenticate:error", "company.retry-after:error", "company.oauth-error-body:error", "company.token-response:error"]);
  });

  it("checks the shapes of events: JSON pages and streamed ids", () => {
    const events = `${API}/poppy/conversations/c1/events`;
    const checks = companyChecks(
      recording(
        { url: events, response: { events: [{ id: "e1" }], has_more: "no" } },
        { url: events, responseHeaders: { "content-type": "text/event-stream" }, response: "event: message\ndata: {}\n\n" },
        { url: events, responseHeaders: { "content-type": "text/event-stream" }, response: "event: text-delta\ndata: {}\n\nid: e2\nevent: message\ndata: {}\n\n" }
      )
    );
    expect(ids(checks)).toEqual(["company.events-shape:error", "company.sse-event-id:error"]);
  });

  it("needs iss on every authorization response", () => {
    const checks = authorizationResponseChecks(
      ["https://dpa.agent.interop.test/poppy/callback?code=c&state=s&iss=https%3A%2F%2Fauth.acme", "https://dpa.agent.interop.test/poppy/callback?error=access_denied&state=s"],
      []
    );
    expect(ids(checks)).toEqual(["company.iss-missing:error"]);
  });

  it("ignores the runner's own probes", () => {
    const checks = traceChecks(recording({ url: `${API}/orders?access_token=x`, headers: { "x-interop-probe": "1" } }));
    expect(checks).toEqual([]);
  });
});
