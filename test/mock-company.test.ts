import { env } from "cloudflare:workers";
import {
  base64url,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK
} from "jose";
import { describe, expect, it } from "vitest";
import { hostsFor, type MockCompany } from "./mock-company";

/**
 * Smoke tests for the mock Company itself, driven by hand-made requests
 * (not the Personal Agent client), so a broken mock shows up here first.
 */

const mocks = (env as unknown as { MOCK_COMPANY: DurableObjectNamespace<MockCompany> }).MOCK_COMPANY;
const CLIENT_ID = "https://agent.test/poppy/client.json";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

function company() {
  const id = `c${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const stub = mocks.getByName(id);
  const hosts = hostsFor(id);
  const call = (url: string, init?: RequestInit) => stub.fetch(new Request(url, init));
  return { id, stub, hosts, call };
}

function jti(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(16)));
}

async function agentKey() {
  const [first] = JSON.parse(env.POPPY_SIGNING_JWKS) as JWK[];
  return { kid: first!.kid!, key: (await importJWK(first!, "ES256")) as CryptoKey };
}

async function assertion(aud: string, sub = CLIENT_ID, extra: Record<string, unknown> = {}) {
  const { kid, key } = await agentKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...extra })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(CLIENT_ID)
    .setSubject(sub)
    .setAudience(aud)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(jti())
    .sign(key);
}

async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk) };
}

async function proof(
  key: Awaited<ReturnType<typeof dpopKey>>,
  method: string,
  url: string,
  accessToken?: string
) {
  const claims: Record<string, unknown> = { htm: method, htu: url.split("?")[0] };
  if (accessToken) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
    claims.ath = base64url.encode(new Uint8Array(digest));
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: key.jwk })
    .setIssuedAt()
    .setJti(jti())
    .sign(key.privateKey);
}

async function startSession(c: ReturnType<typeof company>, key: Awaited<ReturnType<typeof dpopKey>>) {
  const form = new URLSearchParams({
    grant_type: JWT_BEARER,
    assertion: await assertion(c.hosts.tokenEndpoint, "usr_Q7c1vKx9TzLw3NdR5mHa2B"),
    client_id: CLIENT_ID,
    client_assertion_type: ASSERTION_TYPE,
    client_assertion: await assertion(c.hosts.tokenEndpoint)
  });
  return c.call(c.hosts.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      DPoP: await proof(key, "POST", c.hosts.tokenEndpoint)
    },
    body: form
  });
}

describe("the mock Company", () => {
  it("publishes poppy.json and OAuth server metadata that check out", async () => {
    const c = company();
    const document = (await (await c.call(`https://${c.hosts.domain}/.well-known/poppy.json`)).json()) as {
      protocol_version: string;
      organization: { domain: string };
      auth: { issuer: string; mediated: { endpoint: string } };
      apis: { type: string }[];
    };
    expect(document.protocol_version).toBe("0.1");
    expect(document.organization.domain).toBe(c.hosts.domain);
    expect(document.auth.issuer).toBe(c.hosts.issuer);
    expect(document.apis.map((api) => api.type)).toEqual(["graphql", "openapi", "mcp"]);
    const alt = (await (await c.call(`https://www.${c.hosts.altDomain}/.well-known/poppy.json`)).json()) as {
      organization: { domain: string };
      auth: { issuer: string };
    };
    expect(alt.organization.domain).toBe(c.hosts.altDomain);
    expect(alt.auth.issuer).toBe(c.hosts.issuer);
    const metadata = (await (
      await c.call(`${c.hosts.issuer}/.well-known/oauth-authorization-server`)
    ).json()) as { issuer: string; poppy_domains: string[]; token_endpoint: string };
    expect(metadata.issuer).toBe(c.hosts.issuer);
    expect(metadata.poppy_domains).toEqual([c.hosts.domain, c.hosts.altDomain]);
    expect(metadata.token_endpoint).toBe(c.hosts.tokenEndpoint);
  });

  it("refuses a token request without a client assertion, and records it", async () => {
    const c = company();
    const response = await c.call(c.hosts.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER, client_id: CLIENT_ID })
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
    expect((await c.stub.state()).violations).toEqual([`no client assertion at ${c.hosts.tokenEndpoint}`]);
  });

  it("starts a signed-out Session for a correct request, with no violations", async () => {
    const c = company();
    const key = await dpopKey();
    const response = await startSession(c, key);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const token = (await response.json()) as Record<string, unknown>;
    expect(token).toMatchObject({ token_type: "DPoP", signed_in: false, scope: "" });
    expect(token.session_id).toMatch(/^ses_/);
    const state = await c.stub.state();
    expect(state.violations).toEqual([]);
    expect(state.userIds).toEqual(["usr_Q7c1vKx9TzLw3NdR5mHa2B"]);
  });

  it("asks for a DPoP nonce when configured, and records a proof that ignores it", async () => {
    const c = company();
    await c.stub.configure({ requireNonce: true });
    const key = await dpopKey();
    const first = await startSession(c, key);
    expect(first.status).toBe(400);
    expect(await first.json()).toMatchObject({ error: "use_dpop_nonce" });
    expect(first.headers.get("DPoP-Nonce")).toBeTruthy();
    await startSession(c, key);
    expect((await c.stub.state()).violations.some((v) => v.includes("nonce"))).toBe(true);
  });

  it("runs a conversation, Direct Sign-In and a confirmed operation end to end", async () => {
    const c = company();
    const key = await dpopKey();
    const session = (await (await startSession(c, key)).json()) as { access_token: string; session_id: string };
    const conversations = `${c.hosts.api}/poppy/conversations`;
    const post = async (url: string, body: unknown, token: string) =>
      c.call(url, {
        method: "POST",
        headers: {
          Authorization: `DPoP ${token}`,
          DPoP: await proof(key, "POST", url, token),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    const started = await post(
      `${conversations}?wait=1`,
      { message: { id: `msg_${jti()}`, sender: "agent", text: "The user wants to exchange order 1042." } },
      session.access_token
    );
    expect(started.status).toBe(201);
    const read = (await started.json()) as { conversation_id: string; events: { type: string }[] };
    expect(read.events.map((event) => event.type)).toEqual(["message", "authorization", "message"]);

    // Direct Sign-In, with the test as the User.
    const verifier = jti() + jti();
    const challenge = base64url.encode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
    );
    const authorize = new URL(c.hosts.authorizationEndpoint);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: "https://agent.test/poppy/callback",
      scope: "poppy:read poppy:write",
      state: "st_1",
      code_challenge: challenge,
      code_challenge_method: "S256"
    })) {
      authorize.searchParams.set(name, value);
    }
    const back = new URL(await c.stub.approveAuthorization(authorize.toString(), { approve: true }));
    expect(back.searchParams.get("iss")).toBe(c.hosts.issuer);
    expect(back.searchParams.get("state")).toBe("st_1");
    const exchange = await c.call(c.hosts.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        DPoP: await proof(key, "POST", c.hosts.tokenEndpoint)
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        redirect_uri: "https://agent.test/poppy/callback",
        code_verifier: verifier,
        session_id: session.session_id,
        client_id: CLIENT_ID,
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: await assertion(c.hosts.tokenEndpoint)
      })
    });
    const signedIn = (await exchange.json()) as { access_token: string; refresh_token: string; signed_in: boolean };
    expect(signedIn.signed_in).toBe(true);
    expect(signedIn.refresh_token).toMatch(/^pat_/);

    const again = await post(
      `${conversations}/${read.conversation_id}/messages?wait=1`,
      { message: { id: `msg_${jti()}`, sender: "agent", text: "Signed in. Please exchange the jacket." } },
      signedIn.access_token
    );
    expect(again.status).toBe(202);
    const events = (await again.json()) as { events: { type: string; message?: { operation?: { operation_id: string } } }[] };
    const operation = events.events.find((event) => event.message?.operation)?.message?.operation;
    expect(operation?.operation_id).toMatch(/^exc_/);

    const confirm = await post(
      `${c.hosts.operationsEndpoint}/${operation!.operation_id}/confirm`,
      { revision: 1, approved_by: "user" },
      signedIn.access_token
    );
    expect(await confirm.json()).toMatchObject({ state: "succeeded", confirmation: { approved_by: "user" } });
    const repeat = await post(
      `${c.hosts.operationsEndpoint}/${operation!.operation_id}/confirm`,
      { revision: 1, approved_by: "user" },
      signedIn.access_token
    );
    expect(await repeat.json()).toMatchObject({ state: "succeeded" });

    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.violations).toEqual([]);
  });
});

describe("the mock Company's other surfaces", () => {
  async function signedOut(c: ReturnType<typeof company>) {
    const key = await dpopKey();
    const session = (await (await startSession(c, key)).json()) as { access_token: string; session_id: string };
    return { key, session };
  }

  async function form(c: ReturnType<typeof company>, url: string, fields: Record<string, string>, key?: Awaited<ReturnType<typeof dpopKey>>) {
    return c.call(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(key ? { DPoP: await proof(key, "POST", url) } : {})
      },
      body: new URLSearchParams({
        ...fields,
        client_id: CLIENT_ID,
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: await assertion(c.hosts.tokenEndpoint)
      })
    });
  }

  it("signs in with Device Sign-In, then gets an MCP Bearer token", async () => {
    const c = company();
    await c.stub.configure({ deviceInterval: 1 });
    const { key, session } = await signedOut(c);
    const device = (await (await form(c, c.hosts.deviceEndpoint, { scope: "poppy:read poppy:write" })).json()) as {
      device_code: string;
      user_code: string;
      interval: number;
    };
    expect(device.interval).toBe(1);
    const poll = () =>
      form(c, c.hosts.tokenEndpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        session_id: session.session_id
      }, key);
    expect(await (await poll()).json()).toMatchObject({ error: "authorization_pending" });
    await c.stub.approveDevice(device.user_code, { scopes: ["poppy:read"] });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const signedIn = (await (await poll()).json()) as { refresh_token: string; scope: string };
    expect(signedIn.scope).toBe("poppy:read");

    const bearer = (await (
      await form(c, c.hosts.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: signedIn.refresh_token,
        session_id: session.session_id,
        resource: c.hosts.mcpUrl
      })
    ).json()) as { token_type: string; access_token: string };
    expect(bearer.token_type).toBe("Bearer");
    const mcp = await c.call(c.hosts.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer.access_token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    const tools = (await mcp.json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(["search_products", "exchange_item"]);
    expect((await c.stub.state()).violations).toEqual([]);
  });

  it("signs in with Mediated Sign-In and a one-time code", async () => {
    const c = company();
    const { key, session } = await signedOut(c);
    const signIn = `${c.hosts.issuer}/poppy/sign-in`;
    const call = async (url: string, body: unknown) =>
      (await c.call(url, {
        method: "POST",
        headers: {
          Authorization: `DPoP ${session.access_token}`,
          DPoP: await proof(key, "POST", url, session.access_token),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      })).json() as Promise<Record<string, unknown>>;
    const first = await call(signIn, {
      scope: "poppy:read",
      credentials: { email: "grace@example.com", password: "battery staple" }
    });
    expect(first.status).toBe("code_required");
    const code = await c.stub.lastOneTimeCode();
    const done = await call(`${signIn}/${String(first.sign_in_id)}`, { code });
    expect(done).toMatchObject({ status: "complete", signed_in: true, scope: "poppy:read" });
    expect((await c.stub.state()).violations).toEqual([]);
  });

  it("streams events with text-delta, joins a browser, and records a token in a URL", async () => {
    const c = company();
    const { key, session } = await signedOut(c);
    const url = `${c.hosts.api}/poppy/conversations`;
    const started = (await (await c.call(url, {
      method: "POST",
      headers: {
        Authorization: `DPoP ${session.access_token}`,
        DPoP: await proof(key, "POST", url, session.access_token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: { id: `msg_${jti()}`, sender: "agent", text: "hello" } })
    })).json()) as { conversation_id: string };
    const events = `${url}/${started.conversation_id}/events`;
    const stream = await c.call(events, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `DPoP ${session.access_token}`,
        DPoP: await proof(key, "GET", events, session.access_token)
      }
    });
    const text = await stream.text();
    expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
    expect(text).toContain("event: text-delta");
    expect(text).toMatch(/id: evt_/);

    const { kid, key: signingKey } = await agentKey();
    const now = Math.floor(Date.now() / 1000);
    const browserAssertion = await new SignJWT({ session_id: session.session_id, return_to: `https://${c.hosts.domain}/orders` })
      .setProtectedHeader({ alg: "ES256", kid, typ: "poppy-browser+jwt" })
      .setIssuer(CLIENT_ID)
      .setSubject("usr_Q7c1vKx9TzLw3NdR5mHa2B")
      .setAudience(c.hosts.browserSessionEndpoint)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(jti())
      .sign(signingKey);
    const join = await c.call(c.hosts.browserSessionEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ assertion: browserAssertion }),
      redirect: "manual"
    });
    expect(join.status).toBe(303);
    expect(join.headers.get("Set-Cookie")).toMatch(/Secure; HttpOnly; SameSite=Lax/);
    expect((await c.stub.state()).violations).toEqual([]);

    await c.call(`${c.hosts.api}/products?access_token=${session.access_token}`);
    expect((await c.stub.state()).violations.some((v) => v.startsWith("token sent in URL"))).toBe(true);
  });

  it("revokes an Account Token and leaves the Session signed out", async () => {
    const c = company();
    const { key, session } = await signedOut(c);
    const signIn = `${c.hosts.issuer}/poppy/sign-in`;
    const done = (await (await c.call(signIn, {
      method: "POST",
      headers: {
        Authorization: `DPoP ${session.access_token}`,
        DPoP: await proof(key, "POST", signIn, session.access_token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ scope: "poppy:read", credentials: { email: "ada@example.com", password: "correct horse" } })
    })).json()) as { refresh_token: string; access_token: string };
    expect((await c.stub.state()).accountTokens).toBe(1);
    const revoke = await form(c, c.hosts.revocationEndpoint, {
      token: done.refresh_token,
      token_type_hint: "refresh_token"
    });
    expect(revoke.status).toBe(200);
    const state = await c.stub.state();
    expect(state.accountTokens).toBe(0);
    expect(state.sessions[0]).toMatchObject({ signedIn: false, ended: false });
    const orders = `${c.hosts.api}/orders`;
    const after = await c.call(orders, {
      headers: { Authorization: `DPoP ${done.access_token}`, DPoP: await proof(key, "GET", orders, done.access_token) }
    });
    expect(after.status).toBe(403);
    expect(after.headers.get("WWW-Authenticate")).toContain("sign_in_required");
    expect(state.violations).toEqual([]);
  });
});
