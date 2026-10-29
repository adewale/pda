import { exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { ATTACKS, AttackSetupError, AttackUnsupported, freshCodeReplay, prepareAttack, type AttackId } from "../impls/pda-agent/attacks.ts";
import { agentAttackEvidence, agentAttackRejected, authorizationCodeReplayRejected, authorizationCodeFreshReplayRejected } from "../runner/agent-attacks.ts";
import { assertTrace } from "../runner/traces.ts";
import { runCell, type Driver } from "../runner/cell.ts";
import { loadScenarios } from "../runner/cli.ts";
import { decodeJwt, exchanges, type HarEntry } from "../runner/har.ts";
import type { Company } from "../../src/poppy/discovery.ts";
import { parseIssuer } from "../../src/poppy/issuer.ts";
import { clientAssertion, dpopProof, newDpopKey } from "../../src/poppy/jwt.ts";
import { currentKey } from "../../src/poppy/keys.ts";
import { API, CLIENT_ID, clientAssertion as fixtureAssertion, proof as fixtureProof, recording, TOKEN } from "./helpers.ts";

const company: Company = {
  issuer: parseIssuer("https://auth.acme.company.interop.test")!, name: "Acme", domain: "acme.company.interop.test", protocolVersion: "0.3",
  endpoints: { token: TOKEN, revocation: `${companyIssuer()}/oauth/revoke` },
  signIn: { mediated: { endpoint: TOKEN, scopes: ["orders:read", "orders:write"], fields: [{ name: "email", label: "Email", secret: false }, { name: "password", label: "Password", secret: true }] } },
  dpop: true, apis: [{ type: "openapi", url: `${API}/openapi.json`, description: "Orders" }],
  conversations: { endpoint: `${API}/poppy/conversations` }, customScopes: {}, extensions: { operations: true }
};
function companyIssuer() { return "https://auth.acme.company.interop.test"; }
const params = { fields: { email: "ada@example.com", password: "correct horse" }, read_scopes: ["orders:read"], write_scopes: ["orders:read", "orders:write"] };

/** A deliberately permissive peer is the negative control, never the implementation under test. */
async function fixture(id: AttackId, refuse = true, options: { brokenSetup?: boolean; rotate?: boolean; dpop?: boolean } = {}) {
  const key = await generateKeyPair("ES256", { extractable: true });
  const signingJwks = JSON.stringify([{ ...await exportJWK(key.privateKey), kid: "k1", alg: "ES256" }]);
  const entries: HarEntry[] = [];
  let conversation = 0, performs = 0;
  const fetcher = async (request: Request) => {
    const startedDateTime = new Date().toISOString();
    const body = request.body ? await request.clone().text() : "";
    const url = new URL(request.url), marker = request.headers.get("x-interop-attack");
    let status = 200, response: unknown = {}, headers: Record<string, string> = { "content-type": "application/json" };
    if (url.pathname === "/openapi.json") response = { servers: [{ url: API }] };
    else if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(body);
      response = { access_token: "at-one", refresh_token: form.get("grant_type") === "refresh_token" && options.rotate !== false ? "rt-two" : "rt-one", token_type: options.dpop === false ? "Bearer" : "DPoP", scope: form.get("scope") ?? "orders:read" };
    } else if (url.pathname.endsWith("/exchanges")) {
      const approval = request.headers.get("poppy-approval");
      if (!approval || approval.includes("invented-")) { status = 403; response = { error: "approval_required", operation: { operation_id: "op-one", revision: "revision-one", summary: "Exchange jacket", expires_at: new Date(Date.now() + 60_000).toISOString() } }; }
      else { status = 201; performs = 1; response = { exchange_id: "exchange-one" }; }
    } else if (url.pathname.endsWith("/poppy/conversations") && request.method === "POST") { status = 201; response = { conversation_id: `cnv_${++conversation}` }; }
    else if (request.method === "GET" && ["/orders", "/orders/ord_7Hk2", "/products"].includes(url.pathname)) response = { ok: true };
    else if (request.method === "GET" && /^\/poppy\/conversations\/cnv_\d+\/events$/.test(url.pathname)) response = { events: [] };
    else { status = 404; response = { error: "not_found" }; }
    if (options.brokenSetup && !marker && url.pathname === "/orders") { status = 401; response = { error: "invalid_token" }; }
    if (marker === id || marker === `${id}-fresh`) {
      if (!refuse) { status = 200; response = { compromised: true }; }
      else if (id === "YA" || id === "YR") { status = 400; response = { error: "invalid_session" }; }
      else if (id === "YT" || id === "YD") { status = 401; response = {}; headers["www-authenticate"] = 'DPoP error="invalid_dpop_proof"'; }
      else if (id === "YS") { status = 403; response = { error: "insufficient_scope" }; headers["www-authenticate"] = 'DPoP error="insufficient_scope", scope="orders:write"'; }
      else if (id === "YK") { status = 400; response = { error: "invalid_grant" }; }
      else if (id === "YU") { status = 404; response = { error: "conversation_not_found" }; }
    }
    entries.push({ startedDateTime, time: 1, request: { url: request.url, method: request.method, headers: [...request.headers].map(([name, value]) => ({ name, value })), ...(body ? { postData: { mimeType: request.headers.get("content-type") ?? "", text: body } } : {}) }, response: { status, headers: Object.entries(headers).map(([name, value]) => ({ name, value })), content: { mimeType: "application/json", text: JSON.stringify(response) } } });
    return new Response(JSON.stringify(response), { status, headers });
  };
  const plan = () => prepareAttack({ clientId: CLIENT_ID, signingJwks, fetcher }, { ...company, dpop: options.dpop ?? true }, id, params);
  return { ctx: { clientId: CLIENT_ID, signingJwks, fetcher }, plan, trace: () => exchanges({ log: { entries } }), publicKey: key.publicKey, performs: () => performs };
}

describe("Poppy 0.3 raw adversarial adapter and independent trace oracles", () => {
  for (const id of ATTACKS) {
    it(`${id}: proves an accepted control, the precise mutation and its refusal`, async () => {
      const f = await fixture(id), plan = await f.plan();
      await plan.run();
      const trace = f.trace();
      expect(agentAttackEvidence(trace, id), id).toBeDefined();
      expect(assertTrace(trace, { check: "attack_observed", agent_attack: id }).kind).toBe("ok");
      expect(agentAttackRejected(trace, id)).toMatchObject({ kind: "ok" });
      // A marker and an unrelated refusal cannot masquerade as an attack.
      const forged = trace.map((x) => x.requestHeaders.get("x-interop-attack") === id ? { ...x, requestHeaders: new Map([["x-interop-attack", id]]) } : x);
      expect(agentAttackEvidence(forged, id)).toBeUndefined();
      expect(agentAttackEvidence(trace.filter((x) => x.requestHeaders.get("x-interop-attack") === id), id)).toBeUndefined();
    });
    it(`${id}: fails against a Company that accepts the invalid request`, async () => {
      const f = await fixture(id, false), plan = await f.plan();
      await plan.run();
      expect(agentAttackEvidence(f.trace(), id)).toBeDefined();
      expect(agentAttackRejected(f.trace(), id).kind).toBe("failed");
    });
  }
  for (const id of ["YR", "YD"] as const) {
    it(`${id}: independently rejects an unused jti with wrong htu`, async () => {
      for (const refuse of [true, false]) {
        const f = await fixture(id, refuse), plan = await f.plan();
        await plan.run();
        await plan.run("fresh");
        expect(agentAttackEvidence(f.trace(), `${id}-fresh`)).toBeDefined();
        expect(agentAttackRejected(f.trace(), `${id}-fresh`).kind).toBe(refuse ? "ok" : "failed");
        // A reused jti would hide htu checking behind optional replay policy.
        const pair = agentAttackEvidence(f.trace(), `${id}-fresh`)!;
        const header = id === "YR" ? "poppy-session" : "dpop";
        const reused = f.trace().map((x) => x.index === pair[1].index ? { ...x, requestHeaders: new Map([...x.requestHeaders, [header, pair[0].requestHeaders.get(header)!]]) } : x);
        expect(agentAttackEvidence(reused, `${id}-fresh`)).toBeUndefined();
      }
    });
  }
  it("reuses only the authorization code and verifier, with fresh assertion and DPoP proof", async () => {
    const f = await fixture("YA"), key = await newDpopKey();
    const signing = await currentKey({ POPPY_SIGNING_JWKS: f.ctx.signingJwks });
    const originalAssertion = await clientAssertion(signing, CLIENT_ID, company.issuer);
    const originalProof = await dpopProof(key, { method: "POST", url: TOKEN });
    const form = new URLSearchParams({ grant_type: "authorization_code", code: "consumed-code", code_verifier: "same-verifier", redirect_uri: "https://pda.agent.interop.test/poppy/callback", client_id: CLIENT_ID, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: originalAssertion });
    const request = new Request(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", dpop: originalProof }, body: form });
    const fresh = await freshCodeReplay(f.ctx, company, request, key);
    const next = new URLSearchParams(await fresh.text());
    expect(next.get("code")).toBe(form.get("code"));
    expect(next.get("code_verifier")).toBe(form.get("code_verifier"));
    expect(next.get("client_assertion")).not.toBe(originalAssertion);
    expect(fresh.headers.get("dpop")).not.toBe(originalProof);
    expect(decodeJwt(fresh.headers.get("dpop")!)!.header.jwk).toEqual(decodeJwt(originalProof)!.header.jwk);
    expect(decodeJwt(next.get("client_assertion")!)!.payload.aud).toBe(company.issuer);
    await expect(freshCodeReplay(f.ctx, company, new Request(TOKEN, { method: "POST", body: "grant_type=refresh_token" }), key)).rejects.toBeInstanceOf(AttackSetupError);
  });
  it("signs the real Session JWT and its delegated-key chain, and changes only the audience", async () => {
    const f = await fixture("YA"), plan = await f.plan();
    await plan.run();
    const pair = agentAttackEvidence(f.trace(), "YA")!;
    const jwt = pair[1].requestHeaders.get("poppy-session")!;
    const header = decodeJwt(jwt)!.header;
    const delegation = await jwtVerify(String(header.pap_dlg), f.publicKey);
    expect(delegation.payload.iss).toBe(CLIENT_ID);
    expect(delegation.protectedHeader.typ).toBe("pap-delegation+jwt");
    const delegatedKey = (delegation.payload.cnf as { jwk: JWK }).jwk;
    const verified = await jwtVerify(jwt, await importJWK(delegatedKey, "ES256"));
    expect(verified.protectedHeader.typ).toBe("poppy-session+jwt");
    expect(decodeJwt(jwt)!.payload.aud).toBe("https://foreign.company.interop.test");
    expect(pair[0].url.href).toBe(pair[1].url.href);
  });
  it("broken honest setup is a harness error before an attack can be sent", async () => {
    const f = await fixture("YR", true, { brokenSetup: true });
    await expect(f.plan()).rejects.toBeInstanceOf(AttackSetupError);
    expect(f.trace().some((x) => x.requestHeaders.has("x-interop-attack"))).toBe(false);
  });
  it("a nonrotating Company is unsupported rather than falsely failing a universal rotation requirement", async () => {
    const f = await fixture("YK", true, { rotate: false });
    await expect(f.plan()).rejects.toBeInstanceOf(AttackUnsupported);
  });
  it("a Bearer-only Company is unsupported for stolen DPoP-token and proof attacks", async () => {
    for (const id of ["YT", "YD"] as const) {
      const f = await fixture(id, true, { dpop: false });
      await expect(f.plan()).rejects.toBeInstanceOf(AttackUnsupported);
    }
  });
  it("Operations 2 exposes approval and replay as separate phases for effect-count checks", async () => {
    const f = await fixture("YM"), plan = await f.plan();
    expect((await plan.run()).status).toBe(403);
    expect(f.performs()).toBe(0);
    const approved = await plan.run("approve");
    expect(approved.status).toBe(201);
    expect(f.performs()).toBe(1);
    expect(await plan.run("replay")).toEqual(approved);
    expect(f.performs()).toBe(1);
  });
});

describe("NREP: exact, successfully exchanged authorization-code replay", () => {
  const original = { url: TOKEN, method: "POST", form: { grant_type: "authorization_code", code: "code-once", client_assertion: "assertion" }, response: { access_token: "access-one" } };
  it("accepts invalid_grant or an earlier permitted credential-replay refusal", () => {
    for (const error of ["invalid_grant", "invalid_client", "invalid_dpop_proof"]) {
      const trace = recording(original, { ...original, injected: true, status: 400, response: { error } });
      expect(assertTrace(trace, { check: "attack_observed", authorization_code_replay: true }).kind).toBe("ok");
      expect(authorizationCodeReplayRejected(trace).kind).toBe("ok");
    }
  });
  it("fails when the replay mints a token, or returns an unrelated server error", () => {
    expect(authorizationCodeReplayRejected(recording(original, { ...original, injected: true })).kind).toBe("failed");
    expect(authorizationCodeReplayRejected(recording(original, { ...original, injected: true, status: 503, response: { error: "server_error" } })).kind).toBe("failed");
  });
  it("cannot pass without an accepted first exchange, an exact code replay and an injected exchange", () => {
    for (const trace of [recording(original), recording({ ...original, status: 400 }, { ...original, injected: true, status: 400 }), recording(original, { ...original, injected: true, form: { ...original.form, code: "different-code" }, status: 400 })]) {
      expect(assertTrace(trace, { check: "attack_observed", authorization_code_replay: true }).kind).toBe("failed");
      expect(authorizationCodeReplayRejected(trace).kind).toBe("failed");
    }
  });
});


describe("NREP: consumed code with fresh independent credentials", () => {
  const fields = { grant_type: "authorization_code", code: "consumed-code", code_verifier: "verifier", client_id: CLIENT_ID, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" };
  const original = () => ({ url: TOKEN, method: "POST", form: { ...fields, client_assertion: fixtureAssertion() }, headers: { dpop: fixtureProof("POST", TOKEN) }, response: { access_token: "access-one" } });
  const second = () => ({ url: TOKEN, method: "POST", form: { ...fields, client_assertion: fixtureAssertion() }, headers: { dpop: fixtureProof("POST", TOKEN), "x-interop-attack": "NREP-fresh" }, status: 400, response: { error: "invalid_grant" } });
  it("proves code reuse rejection without relying on optional assertion/proof replay rejection", () => {
    const trace = recording(original(), second());
    expect(assertTrace(trace, { check: "attack_observed", authorization_code_fresh_replay: true }).kind).toBe("ok");
    expect(authorizationCodeFreshReplayRejected(trace).kind).toBe("ok");
  });
  it("fails if code reuse mints another token or rejects an unrelated credential", () => {
    for (const response of [{ status: 200, response: { access_token: "access-two" } }, { status: 400, response: { error: "invalid_client" } }, { status: 400, response: { error: "invalid_dpop_proof" } }]) expect(authorizationCodeFreshReplayRejected(recording(original(), { ...second(), ...response })).kind).toBe("failed");
  });
  it("a different code, verifier, reused assertion or reused DPoP proof cannot satisfy the evidence precondition", () => {
    const first = original(), next = second();
    for (const change of [
      { form: { ...next.form, code: "different-code" } },
      { form: { ...next.form, code_verifier: "different-verifier" } },
      { form: { ...next.form, client_assertion: first.form.client_assertion } },
      { headers: { ...next.headers, dpop: first.headers.dpop } }
    ]) expect(assertTrace(recording(first, { ...next, ...change }), { check: "attack_observed", authorization_code_fresh_replay: true }).kind).toBe("failed");
  });
});


describe("YM: independent effect-count and replay-outcome controls", () => {
  const scenario = loadScenarios().find((item) => item.id === "YM")!;
  async function run(counts: number[], changedReplay = false) {
    const driver: Driver = {
      agent: async (op, value) => {
        if (op === "arm") return { kind: "ok", result: {} };
        const phase = (value as { phase?: string }).phase;
        return { kind: "ok", result: phase ? { status: 201, body: { exchange_id: phase === "replay" && changedReplay ? "exchange-other" : "exchange-one" } } : { status: 403, body: { error: "approval_required" } } };
      },
      company: async (hook) => ({ kind: "ok", result: hook === "performed_count" ? { performed: counts.shift() } : { fields: params.fields } }),
      // Wire preconditions/refusals are independently exercised above.
      runner: async () => ({ kind: "ok" })
    };
    return runCell(scenario, { accounts: ["acct_ada"], scopes: { read: params.read_scopes, write: params.write_scopes } }, driver);
  }
  it("passes with zero effects before approval, one after it, and the same response on replay", async () => {
    expect((await run([0, 0, 1, 1])).outcome).toBe("pass");
  });
  it("fails if the invalid revision performs an action, or replay performs another", async () => {
    expect((await run([0, 1, 1, 1])).outcome).toBe("fail");
    expect((await run([0, 0, 1, 2])).outcome).toBe("fail");
  });
  it("fails if replay returns a different outcome even when the effect count stays one", async () => {
    expect((await run([0, 0, 1, 1], true)).outcome).toBe("fail");
  });
});
