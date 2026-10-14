/**
 * The checks and trace predicates behind scenarios H (handoff), DC (Direct
 * Conversation), W (browser Session join), O2 (confirmed twice, performed
 * once) and CM (the Company fetches the agent's client_id and keys).
 */
import { describe, expect, it } from "vitest";
import { withWebPage } from "../runner/cell.ts";
import {
  browserAssertionChecks,
  browserSessionResponseChecks,
  confirmRepeatChecks,
  directParentChecks,
  handoffChecks,
  metadataFetchChecks,
  setCookies,
  traceChecks
} from "../runner/checks.ts";
import { assertTrace, browserJoined, clientFetched, confirmRepeated } from "../runner/traces.ts";
import { API, CLIENT_ID, jti, jwt, NOW, recording, sessionStart, type Spec } from "./helpers.ts";

const ids = (checks: { id: string; severity: string }[]) => checks.map((check) => `${check.id}:${check.severity}`);

const SITE = "https://acme.company.interop.test";
const ENDPOINT = `${SITE}/poppy/browser-session`;
const POPPY_JSON: Spec = {
  url: `${SITE}/.well-known/poppy.json`,
  response: { protocol_version: "0.1", organization: { name: "Acme", domain: "acme.company.interop.test" }, auth: { issuer: "https://auth.acme.company.interop.test" }, web: { browser_session_endpoint: ENDPOINT } }
};

function browserAssertion(overrides: { header?: Record<string, unknown>; payload?: Record<string, unknown> } = {}): string {
  return jwt(
    { alg: "ES256", kid: "k1", typ: "poppy-browser+jwt", ...overrides.header },
    { iss: CLIENT_ID, sub: "usr_1", aud: ENDPOINT, session_id: "ses_1", return_to: `${SITE}/orders`, iat: NOW, exp: NOW + 60, jti: jti(), ...overrides.payload }
  );
}

const COOKIE = "sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax";
function join(assertion = browserAssertion(), response: Partial<Spec> = {}): Spec {
  return { url: ENDPOINT, form: { assertion }, status: 303, responseHeaders: { location: `${SITE}/orders`, "set-cookie": COOKIE }, ...response };
}

describe("browser Session joins (spec 5, scenario W)", () => {
  it("find nothing wrong with a correct join and its answer", () => {
    const all = recording(POPPY_JSON, join(), { url: `${SITE}/orders`, headers: { cookie: "sid=abc" } });
    expect(traceChecks(all)).toEqual([]);
    expect(browserJoined(all)).toEqual({ kind: "ok", result: { exchange: 1, return_to: `${SITE}/orders`, followed: true } });
  });

  it("judge the agent's assertion by the mock's ids and bases: typ, aud, lifetime, return_to, jti, and never in the URL", () => {
    const reused = browserAssertion();
    const checks = browserAssertionChecks(
      recording(
        POPPY_JSON,
        join(browserAssertion({ header: { typ: "JWT" } })),
        join(browserAssertion({ payload: { aud: "https://auth.acme.company.interop.test/oauth/token" } })),
        join(browserAssertion({ payload: { exp: NOW + 120 } })),
        join(browserAssertion({ payload: { return_to: "https://evil.company.interop.test/" } })),
        join(reused),
        join(reused),
        { url: `${ENDPOINT}?assertion=${browserAssertion()}`, method: "POST", body: "", status: 400 }
      )
    );
    expect(ids(checks)).toEqual([
      "browser-assertion.typ:error",
      "browser-assertion.aud:error",
      "browser-assertion.lifetime:error",
      "browser-assertion.return-to-off-domain:error",
      "browser-assertion.jti-reused:error",
      "browser-assertion.in-url:error",
      "browser-assertion.content-type:error"
    ]);
  });

  it("know a browser assertion sent anywhere by its typ, even without poppy.json in the recording", () => {
    const checks = browserAssertionChecks(recording({ ...join(), url: `${SITE}/elsewhere` }));
    expect(ids(checks)).toEqual(["browser-assertion.aud:error"]);
  });

  it("hold an accepted join to 303, return_to and a Secure, HttpOnly, not Strict cookie; a 400 refusal is the Company's to make", () => {
    const answer = (responseHeaders: Record<string, string>, status = 303) => browserSessionResponseChecks(recording(POPPY_JSON, join(undefined, { status, responseHeaders })));
    expect(ids(answer({ location: `${SITE}/orders`, "set-cookie": COOKIE }, 200))).toEqual(["company.browser-session-response:error"]);
    expect(ids(answer({ location: `${SITE}/`, "set-cookie": COOKIE }))).toEqual(["company.browser-session-response:error"]);
    expect(ids(answer({ location: `${SITE}/orders` }))).toEqual(["company.browser-session-response:error"]);
    expect(ids(answer({ location: `${SITE}/orders`, "set-cookie": "sid=abc; Path=/; SameSite=Strict" }))).toEqual(["company.browser-cookie:error"]);
    expect(answer({ location: `${SITE}/orders`, "set-cookie": "sid=abc; Path=/; Secure; HttpOnly; SameSite=None" })).toEqual([]);
    expect(answer({}, 400)).toEqual([]);
  });

  it("split Set-Cookie lines the recording joined, without splitting an Expires date", () => {
    const [x] = recording({ url: ENDPOINT, responseHeaders: { "set-cookie": "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure, b=2; HttpOnly" } });
    expect(setCookies(x!)).toEqual(["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure", "b=2; HttpOnly"]);
  });

  it("browser_joined: inapplicable without an endpoint, failed without an accepted join, and says whether the cookie came back", () => {
    expect(browserJoined(recording({ ...POPPY_JSON, response: { protocol_version: "0.1" } })).kind).toBe("inapplicable");
    expect(browserJoined(recording(POPPY_JSON)).kind).toBe("failed");
    expect(browserJoined(recording(POPPY_JSON, join(undefined, { status: 400, responseHeaders: {} }))).kind).toBe("failed");
    expect(browserJoined(recording(POPPY_JSON, join(), { url: `${SITE}/orders` }))).toMatchObject({ kind: "ok", result: { followed: false } });
    expect(assertTrace(recording(POPPY_JSON, join()), { check: "browser_joined" }).kind).toBe("ok");
  });

  it("the runner gives W the Company's home page when its fixture names no web_page", () => {
    expect(withWebPage({ accounts: [] }, "acme.company.interop.test")).toEqual({ accounts: [], web_page: `${SITE}/` });
    expect(withWebPage({ web_page: `${SITE}/shop` }, "acme.company.interop.test")).toEqual({ web_page: `${SITE}/shop` });
    expect(withWebPage(null, "acme.company.interop.test")).toEqual({ web_page: `${SITE}/` });
  });
});

const CONVERSATIONS = `${API}/poppy/conversations`;
const post = (url: string, status: number, response: unknown, body: unknown = {}): Spec => ({ url, method: "POST", body: JSON.stringify(body), status, response });

describe("handoff (7.9, scenario H)", () => {
  it("an accepted handoff answers 202 with status and responder; a refusal isn't judged here", () => {
    const url = `${CONVERSATIONS}/c1/handoff`;
    expect(handoffChecks(recording(post(url, 202, { conversation_id: "c1", status: "queued", responder: "agent" })))).toEqual([]);
    expect(ids(handoffChecks(recording(post(url, 200, { status: "queued", responder: "agent" }))))).toEqual(["company.handoff-response:error"]);
    expect(ids(handoffChecks(recording(post(url, 202, { conversation_id: "c1" }))))).toEqual(["company.handoff-response:error"]);
    expect(handoffChecks(recording(post(url, 409, { error: "conversation_closed" })))).toEqual([]);
  });
});

describe("Direct Conversations (7.10, scenario DC)", () => {
  const open = post(CONVERSATIONS, 201, { conversation_id: "d1", status: "idle", responder: "agent" }, { parent_conversation_id: "p1", message: { id: "m1", sender: "human", text: "Hi" } });

  it("the parent refuses messages and handoffs while its Direct Conversation is open, naming it", () => {
    expect(directParentChecks(recording(open, post(`${CONVERSATIONS}/p1/messages`, 409, { error: "direct_conversation_open", conversation_id: "d1" })))).toEqual([]);
    expect(ids(directParentChecks(recording(open, post(`${CONVERSATIONS}/p1/messages`, 202, { conversation_id: "p1" }))))).toEqual(["company.direct-parent-open:error"]);
    expect(ids(directParentChecks(recording(open, post(`${CONVERSATIONS}/p1/handoff`, 202, { status: "queued", responder: "agent" }))))).toEqual(["company.direct-parent-open:error"]);
    expect(ids(directParentChecks(recording(open, post(`${CONVERSATIONS}/p1/messages`, 409, { error: "direct_conversation_open", conversation_id: "p1" }))))).toEqual(["company.direct-parent-open:error"]);
  });

  it("the parent takes messages again once the Direct Conversation closes, by a close or a direct_closed event", () => {
    const after = post(`${CONVERSATIONS}/p1/messages`, 202, { conversation_id: "p1" });
    expect(directParentChecks(recording(open, post(`${CONVERSATIONS}/d1/close`, 200, { status: "closed", responder: "agent" }), after))).toEqual([]);
    const closedEvent = { url: `${CONVERSATIONS}/p1/events`, response: { events: [{ id: "e9", type: "direct_closed", conversation_id: "d1" }], cursor: "e9", has_more: false, status: "idle", responder: "agent" } };
    expect(directParentChecks(recording(open, closedEvent, after))).toEqual([]);
    const streamed = { url: `${CONVERSATIONS}/p1/events`, responseHeaders: { "content-type": "text/event-stream" }, response: `id: e9\ndata: ${JSON.stringify({ id: "e9", type: "direct_closed", conversation_id: "d1" })}\n\n` };
    expect(directParentChecks(recording(open, streamed, after))).toEqual([]);
  });
});

describe("a repeated confirm (Operations 5.2 and 6, scenario O2)", () => {
  const confirm = `${API}/poppy/operations/exc_1/confirm`;
  const confirmation = { revision: 1, approved_by: "user", confirmed_at: "2026-10-12T12:00:00Z" };
  const answer = (status: number, response: unknown, at: number): Spec => ({ ...post(confirm, status, response, { revision: 1, approved_by: "user" }), at });

  it("returns the operation as it is: the same confirmation, whatever its state now", () => {
    const all = recording(answer(200, { operation_id: "exc_1", state: "in_progress", confirmation }, 0), answer(200, { operation_id: "exc_1", state: "succeeded", confirmation }, 10));
    expect(confirmRepeatChecks(all)).toEqual([]);
    expect(confirmRepeated(all)).toEqual({ kind: "ok", result: { operations: ["exc_1"], confirms: 2 } });
  });

  it("fails a second confirmation, or an error that isn't about the token, its scopes or a limit", () => {
    const first = answer(200, { operation_id: "exc_1", state: "succeeded", confirmation }, 0);
    const again = recording(first, answer(200, { operation_id: "exc_1", state: "succeeded", confirmation: { ...confirmation, confirmed_at: "2026-10-12T12:00:05Z" } }, 10));
    expect(ids(confirmRepeatChecks(again))).toEqual(["company.confirm-repeated:error"]);
    expect(confirmRepeated(again).kind).toBe("failed");
    expect(ids(confirmRepeatChecks(recording(first, answer(409, { error: "operation_not_proposed" }, 10))))).toEqual(["company.confirm-repeated:error"]);
    expect(confirmRepeatChecks(recording(first, answer(403, { error: "insufficient_scope" }, 10)))).toEqual([]);
    expect(confirmRepeated(recording(first, answer(403, { error: "insufficient_scope" }, 10))).kind).toBe("failed");
  });

  it("is inapplicable without a second confirm, and judges nothing before the first was answered", () => {
    expect(confirmRepeated(recording(answer(200, { state: "succeeded", confirmation }, 0))).kind).toBe("inapplicable");
    expect(confirmRepeatChecks(recording(answer(503, { error: "server_error" }, 0), answer(200, { state: "succeeded", confirmation }, 10)))).toEqual([]);
  });
});

describe("the Company's fetches of the agent's documents (4.1, scenario CM)", () => {
  const JWKS = "https://pda.agent.interop.test/poppy/jwks.json";
  const metadata = (at: number, headers: Record<string, string> = {}): Spec => ({ url: CLIENT_ID, at, headers, response: { client_id: CLIENT_ID, jwks_uri: JWKS } });
  const keys = (at: number, kid = "k1"): Spec => ({ url: JWKS, at, response: { keys: [{ kty: "EC", kid }] } });
  const grant = (at: number): Spec => ({ ...sessionStart(at), time: 100 });

  it("client_fetched: the client_id document and the key that signed the Session assertion, both before the Session was granted", () => {
    expect(clientFetched(recording(grant(0), metadata(10), keys(20)))).toMatchObject({ kind: "ok", result: { client_id: CLIENT_ID, metadata: 1, jwks: 2 } });
  });

  it("client_fetched: an agent that sends no client_id (optional beside a client assertion, RFC 7521 4.2) is known by the assertion's iss", () => {
    const { client_id: _omitted, ...rest } = grant(0).form as Record<string, string>;
    const anonymous: Spec = { ...grant(0), form: rest };
    expect(clientFetched(recording(anonymous, metadata(10), keys(20)))).toMatchObject({ kind: "ok", result: { client_id: CLIENT_ID, jwks: 2 } });
    expect(metadataFetchChecks(recording(anonymous, metadata(10, { cookie: "s=1" }), keys(20)))).toHaveLength(1);
  });

  it("client_fetched: failed when the keys came after, or held another kid; inapplicable when nothing was fetched", () => {
    expect(clientFetched(recording(grant(0), metadata(10), keys(500))).kind).toBe("failed");
    expect(clientFetched(recording(grant(0), metadata(10), keys(20, "k-old"))).kind).toBe("failed");
    expect(clientFetched(recording(grant(0), keys(20))).kind).toBe("failed");
    expect(clientFetched(recording(grant(0))).kind).toBe("inapplicable");
  });

  it("warns when a fetch carries a cookie, token or other credential (Guides)", () => {
    expect(metadataFetchChecks(recording(grant(0), metadata(10), keys(20)))).toEqual([]);
    const checks = metadataFetchChecks(recording(grant(0), metadata(10, { cookie: "s=1" }), { ...keys(20), headers: { authorization: "Bearer x" } }));
    expect(ids(checks)).toEqual(["company.metadata-fetch-credentials:warning", "company.metadata-fetch-credentials:warning"]);
    expect(checks[0]!.basis).toBe("Guides");
  });
});
