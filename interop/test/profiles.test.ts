/**
 * The fake Personal Agents' network seam (interop/impls/pda-agent/profiles.ts):
 * what the sloppy agent changes on the wire, what the lenient agent accepts,
 * and what the strict agent refuses and records.
 */
import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  changedClaims,
  Endpoints,
  lenientFetch,
  PROFILE_READINGS,
  PROFILES,
  profileFrom,
  sloppyRequest,
  SLOPPY_LIFETIME,
  StrictObserver,
  StrictRefusal,
  type Resign
} from "../impls/pda-agent/profiles.ts";
import { QUESTIONS } from "../runner/readings.ts";
import { loadRegistry } from "../runner/cli.ts";

const ISSUER = "https://auth.acme.company.interop.test";
const TOKEN = `${ISSUER}/oauth/token`;
const REVOKE = `${ISSUER}/oauth/revoke`;
const METADATA = `${ISSUER}/.well-known/oauth-authorization-server`;
const CLIENT = "https://agent.agent.interop.test/poppy/client.json";

const { privateKey } = await generateKeyPair("ES256");
const resign: Resign = async (jwt, change) => {
  const { header, payload } = changedClaims(jwt, change);
  return new SignJWT(payload).setProtectedHeader({ ...header, alg: "ES256" }).sign(privateKey);
};

async function assertion(aud: string, claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ jti: crypto.randomUUID(), ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "JWT" })
    .setIssuer(CLIENT)
    .setSubject(CLIENT)
    .setAudience(aud)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(privateKey);
}

async function knownEndpoints(): Promise<Endpoints> {
  const endpoints = new Endpoints();
  const metadata = { issuer: ISSUER, token_endpoint: TOKEN, revocation_endpoint: REVOKE };
  await endpoints.observe(METADATA, Response.json(metadata));
  return endpoints;
}

const formPost = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });

describe("profiles", () => {
  it("names three profiles, each declaring a reading of every question with a value the spec allows", () => {
    expect([...PROFILES]).toEqual(["lenient", "strict", "sloppy"]);
    for (const profile of PROFILES) {
      for (const [question, { values }] of Object.entries(QUESTIONS)) {
        expect(values as readonly string[], `${profile} ${question}`).toContain(PROFILE_READINGS[profile][question]);
      }
    }
    expect(profileFrom(undefined)).toBeNull();
    expect(() => profileFrom("careless")).toThrow(/Unknown/);
  });

  it("registers each profile as a fake, honest, self-owned agent", () => {
    const agents = loadRegistry().implementations.filter((entry) => entry.role === "agent" && entry.owner === "self");
    for (const profile of PROFILES) {
      const entry = agents.find((found) => found.name === `${profile}-personal-agent`);
      expect(entry, profile).toMatchObject({ fake: true, build: "interop/impls/pda-agent", env: { INTEROP_AGENT_PROFILE: profile } });
      expect(entry?.adversarial).toBeUndefined();
    }
    // The adversarial agent spoke 0.2's wire and waits for a 0.3 port (docs/interop-spec.md).
    const names = loadRegistry().implementations.map((entry) => entry.name);
    expect(names).not.toContain("evil-personal-agent");
    expect(names.filter((name) => /pda-mock|evil-agent$/.test(name))).toEqual([]);
  });
});

describe("the sloppy agent", () => {
  it("drops typ, lives 300 s and names the token endpoint in its client assertion, and changes nothing else", async () => {
    const endpoints = await knownEndpoints();
    const request = formPost(TOKEN, { grant_type: "refresh_token", refresh_token: "rt_1", client_assertion: await assertion(ISSUER) });
    const sent = new URLSearchParams(await (await sloppyRequest(request, endpoints, resign)).text());
    expect(sent.has("scope")).toBe(false);
    expect(sent.get("refresh_token")).toBe("rt_1");
    const jwt = sent.get("client_assertion")!;
    expect(decodeProtectedHeader(jwt).typ).toBeUndefined();
    const claims = decodeJwt(jwt);
    expect(claims.aud).toBe(TOKEN);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(SLOPPY_LIFETIME);
  });

  it("names the token endpoint at the revocation endpoint too, and leaves an unknown endpoint alone", async () => {
    const endpoints = await knownEndpoints();
    const revoke = new URLSearchParams(await (await sloppyRequest(formPost(REVOKE, { token: "t", client_assertion: await assertion(REVOKE) }), endpoints, resign)).text());
    expect(decodeJwt(revoke.get("client_assertion")!).aud).toBe(TOKEN);
    expect(revoke.has("scope")).toBe(false);
    const elsewhere = formPost("https://other.company.interop.test/oauth/token", { client_assertion: await assertion(TOKEN) });
    expect(await sloppyRequest(elsewhere, endpoints, resign)).toBe(elsewhere);
  });
});

describe("the lenient agent", () => {
  it("takes server metadata from the appended location when the inserted one is 404 (S3 either)", async () => {
    const asked: string[] = [];
    const next = async (request: Request) => {
      asked.push(request.url);
      return request.url.endsWith("/tenant/.well-known/oauth-authorization-server") ? Response.json({ issuer: `${ISSUER}/tenant` }) : new Response("", { status: 404 });
    };
    const response = await lenientFetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server/tenant`), next, new Endpoints(), resign);
    expect(response.status).toBe(200);
    expect(asked).toEqual([`${ISSUER}/.well-known/oauth-authorization-server/tenant`, `${ISSUER}/tenant/.well-known/oauth-authorization-server`]);
  });

  it("returns the inserted location's 404 when the appended location has nothing either", async () => {
    const response = await lenientFetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server/tenant`), async () => new Response("", { status: 404 }), new Endpoints(), resign);
    expect(response.status).toBe(404);
  });

  it("sends a refused client assertion again naming the token endpoint, then the issuer, each with a fresh jti", async () => {
    const endpoints = await knownEndpoints();
    const sent: { aud: unknown; jti: unknown }[] = [];
    const next = async (request: Request) => {
      const claims = decodeJwt(new URLSearchParams(await request.text()).get("client_assertion")!);
      sent.push({ aud: claims.aud, jti: claims.jti });
      return claims.aud === ISSUER ? new Response(null, { status: 200 }) : Response.json({ error: "invalid_client" }, { status: 401 });
    };
    const response = await lenientFetch(formPost(REVOKE, { token: "t", client_assertion: await assertion(REVOKE) }), next, endpoints, resign);
    expect(response.status).toBe(200);
    expect(sent.map((one) => one.aud)).toEqual([REVOKE, TOKEN, ISSUER]);
    expect(new Set(sent.map((one) => one.jti)).size).toBe(3);
  });

  it("never sends again a request carrying a DPoP proof, which it can't sign afresh", async () => {
    const endpoints = await knownEndpoints();
    let calls = 0;
    const next = async () => {
      calls++;
      return Response.json({ error: "invalid_client" }, { status: 401 });
    };
    const response = await lenientFetch(formPost(TOKEN, { client_assertion: await assertion(TOKEN) }, { dpop: "proof" }), next, endpoints, resign);
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });
});

describe("the strict agent", () => {
  const request = (url: string, headers: Record<string, string> = {}) => ({ method: "GET", url, headers: new Headers(headers), body: "" });

  it("records nothing for a clean answer", async () => {
    const observer = new StrictObserver();
    const found = await observer.observe(request("https://api.acme.company.interop.test/orders", { authorization: "DPoP abc" }), Response.json({ orders: [] }), Date.now());
    expect(found).toEqual([]);
    expect(observer.refusal).toBeNull();
  });

  it("refuses a 401 without WWW-Authenticate, a failure, and records it with its basis and level", async () => {
    const observer = new StrictObserver();
    const found = await observer.observe(request("https://api.acme.company.interop.test/orders", { authorization: "DPoP abc" }), Response.json({ error: "invalid_token" }, { status: 401 }), Date.now());
    expect(found.map((check) => check.id)).toEqual(["company.www-authenticate"]);
    expect(observer.refusal).toBeInstanceOf(StrictRefusal);
    expect(observer.refusal?.document).toBe(false);
    expect(observer.recorded).toEqual([expect.objectContaining({ id: "company.www-authenticate", basis: "RFC", level: "failure" })]);
  });

  it("refuses what the Guides only recommend: the Company fetching its client metadata with credentials", async () => {
    const observer = new StrictObserver();
    // The Company fetches the metadata while the agent's token request is in flight; the finding shows once that request is recorded.
    await observer.observe(request(CLIENT, { cookie: "session=1" }), Response.json({ client_id: CLIENT }), Date.now());
    expect(observer.recorded).toEqual([]);
    const token = { method: "POST", url: TOKEN, headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }), body: new URLSearchParams({ client_id: CLIENT, client_assertion: await assertion(TOKEN) }).toString() };
    await observer.observe(token, Response.json({ access_token: "a", token_type: "DPoP", expires_in: 300, session_id: "s1" }), Date.now());
    expect(observer.recorded).toEqual([expect.objectContaining({ id: "company.metadata-fetch-credentials", basis: "Guides", level: "warning" })]);
    expect(observer.refusal).toBeInstanceOf(StrictRefusal);
  });

  it("records each finding once, however many exchanges show it again", async () => {
    const observer = new StrictObserver();
    const answer = () => Response.json({ error: "invalid_token" }, { status: 401 });
    await observer.observe(request("https://api.acme.company.interop.test/orders", { authorization: "DPoP abc" }), answer(), Date.now());
    await observer.observe(request("https://api.acme.company.interop.test/other", { authorization: "DPoP abc" }), Response.json({}), Date.now());
    expect(observer.recorded).toHaveLength(1);
  });

  it("in the live lane, takes every host but its own for the Company's", async () => {
    const observer = new StrictObserver("cdn.example");
    await observer.observe(request("https://shop.example/api/orders", { authorization: "DPoP abc" }), Response.json({ error: "invalid_token" }, { status: 401 }), Date.now());
    expect(observer.recorded.map((found) => found.id)).toEqual(["company.www-authenticate"]);
  });

  it("doesn't read a streamed body", async () => {
    const observer = new StrictObserver();
    const stream = new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    expect(await observer.observe(request("https://acme.company.interop.test/conversations/c1/events"), stream, Date.now())).toEqual([]);
  });
});
