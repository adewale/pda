/**
 * The checks and trace predicates behind scenarios H (handoff), DC (Direct
 * Conversation), W (browser Session join) and CM (the Company fetches the
 * agent's client_id and keys).
 */
import { describe, expect, it } from "vitest";
import { withWebPage } from "../runner/cell.ts";
import {
  browserSessionResponseChecks,
  directParentChecks,
  handoffChecks,
  metadataFetchChecks,
  setCookies,
  traceChecks
} from "../runner/checks.ts";
import { assertTrace, browserJoined, clientFetched } from "../runner/traces.ts";
import { API, CLIENT_ID, jti, jwt, NOW, recording, sessionStart, type Spec } from "./helpers.ts";

const ids = (checks: { id: string; severity: string }[]) => checks.map((check) => `${check.id}:${check.severity}`);

const SITE = "https://acme.company.interop.test";
const ENDPOINT = `${SITE}/poppy/browser-session`;
const POPPY_JSON: Spec = {
  url: `${SITE}/.well-known/poppy.json`,
  response: { protocol_version: "0.3", organization: { name: "Acme", domain: "acme.company.interop.test" }, web: { browser_session_endpoint: ENDPOINT } }
};

const COOKIE = "sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax";
/** 0.3's join (6): the page with its code, the agent's authorize, then the browser's form with the code alone. */
const page: Spec = { url: ENDPOINT, method: "GET", status: 200, responseHeaders: { "set-cookie": "__Host-poppy_join=j1; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Strict" } };
function join(response: Partial<Spec> = {}): Spec {
  return { url: ENDPOINT, form: { code: "bc_1" }, status: 303, responseHeaders: { location: `${SITE}/`, "set-cookie": COOKIE }, ...response };
}

describe("browser Session joins (spec 6, scenario W)", () => {
  it("find nothing wrong with a correct join and its answer", () => {
    const all = recording(POPPY_JSON, page, join(), { url: `${SITE}/`, headers: { cookie: "sid=abc" } });
    expect(traceChecks(all)).toEqual([]);
    expect(browserJoined(all)).toEqual({ kind: "ok", result: { exchange: 2, return_to: `${SITE}/`, followed: true } });
  });

  it("hold an accepted form to a redirect with a Secure, HttpOnly cookie (Guides); SameSite=Strict is allowed now, and a 400 refusal is the Company's to make", () => {
    const answer = (responseHeaders: Record<string, string>, status = 303) => browserSessionResponseChecks(recording(POPPY_JSON, page, join({ status, responseHeaders })));
    expect(ids(answer({ location: `${SITE}/`, "set-cookie": COOKIE }, 200))).toEqual(["company.browser-session-response:error"]);
    expect(ids(answer({ location: `${SITE}/` }))).toEqual(["company.browser-session-response:error"]);
    for (const [cookie, detail] of [
      ["sid=abc; Path=/; HttpOnly; SameSite=Lax", "cookie sid: no Secure"],
      ["sid=abc; Path=/; Secure; SameSite=Lax", "cookie sid: no HttpOnly"]
    ]) {
      expect(answer({ location: `${SITE}/`, "set-cookie": cookie! })).toEqual([expect.objectContaining({ id: "company.browser-cookie", severity: "warning", detail })]);
    }
    expect(answer({ location: `${SITE}/`, "set-cookie": "sid=abc; Path=/; Secure; HttpOnly; SameSite=Strict" })).toEqual([]);
    expect(answer({}, 400)).toEqual([]);
  });

  it("split Set-Cookie lines the recording joined, without splitting an Expires date", () => {
    const [x] = recording({ url: ENDPOINT, responseHeaders: { "set-cookie": "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure, b=2; HttpOnly" } });
    expect(setCookies(x!)).toEqual(["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure", "b=2; HttpOnly"]);
  });

  it("browser_joined: inapplicable without an endpoint, failed without an accepted form, and says whether the cookie came back", () => {
    expect(browserJoined(recording({ ...POPPY_JSON, response: { protocol_version: "0.3" } })).kind).toBe("inapplicable");
    expect(browserJoined(recording(POPPY_JSON)).kind).toBe("failed");
    // The page's GET sets the join's own cookie: it is never the join.
    expect(browserJoined(recording(POPPY_JSON, page)).kind).toBe("failed");
    expect(browserJoined(recording(POPPY_JSON, page, join({ status: 400, responseHeaders: {} }))).kind).toBe("failed");
    expect(browserJoined(recording(POPPY_JSON, page, join(), { url: `${SITE}/orders` }))).toMatchObject({ kind: "ok", result: { followed: false } });
    expect(assertTrace(recording(POPPY_JSON, page, join()), { check: "browser_joined" }).kind).toBe("ok");
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

describe("the Company's fetches of the agent's documents (4.1, scenario CM)", () => {
  const JWKS = "https://pda.agent.interop.test/poppy/jwks.json";
  const metadata = (at: number, headers: Record<string, string> = {}): Spec => ({ url: CLIENT_ID, at, headers, response: { client_id: CLIENT_ID, jwks_uri: JWKS } });
  const keys = (at: number, kid = "k1"): Spec => ({ url: JWKS, at, response: { keys: [{ kty: "EC", kid }] } });
  const grant = (at: number): Spec => ({ ...sessionStart(at), time: 100 });

  it("client_fetched: the client_id document and the key that signed the client assertion, both before the token was granted", () => {
    expect(clientFetched(recording(grant(0), metadata(10), keys(20)))).toMatchObject({ kind: "ok", result: { client_id: CLIENT_ID, metadata: 1, jwks: 2 } });
  });

  it("client_fetched: or the key that signed the delegation of the first Session JWT the Company accepted (5.3, step 1)", () => {
    const delegation = jwt({ alg: "ES256", kid: "k1", typ: "pap-delegation+jwt" }, { iss: CLIENT_ID, cnf: { jwk: { kty: "EC" } }, iat: NOW, exp: NOW + 3600, jti: jti() });
    const session = jwt({ alg: "ES256", kid: "thumb", typ: "poppy-session+jwt", pap_dlg: delegation }, { iss: CLIENT_ID, aud: "https://auth.acme.company.interop.test", sid: "s1", sub: "usr_1", htm: "GET", htu: `${API}/products`, iat: NOW, jti: jti() });
    const request: Spec = { url: `${API}/products`, at: 0, time: 100, headers: { "poppy-session": session } };
    expect(clientFetched(recording(request, metadata(10), keys(20)))).toMatchObject({ kind: "ok", result: { client_id: CLIENT_ID, metadata: 1, jwks: 2 } });
    expect(clientFetched(recording(request, metadata(10), keys(20, "k-old"))).kind).toBe("failed");
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
