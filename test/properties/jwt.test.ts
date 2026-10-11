import { exportJWK, generateKeyPair, SignJWT, base64url as joseBase64url, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { clientAssertion, dpopProof, newDpopKey, sessionAssertion, sha256, type DpopKey } from "../../src/poppy/jwt";
import { currentKey, readIdentity, readSigningKeys } from "../../src/poppy/keys";
import { clientMetadata } from "../../src/poppy/routes";
import { Company, HttpError, type Inbound } from "../mock-company/core";
import { DEFAULT_CONFIG, type MockConfig } from "../mock-company/types";
import { violationId } from "../mock-company/violations";
import { gs, propertyAsync } from "./hegel";

/**
 * Our client's JWTs against the mock Company's checks, in both directions.
 * Accept: every client assertion, Session assertion and DPoP proof our
 * client builds passes, under every reading the mock can take. Reject: a
 * proof or assertion with one thing wrong is refused, and the mock records
 * exactly the violation that names it.
 */

const ORIGIN = "https://agent.test";

/** Our identity: signing keys made once, as POPPY_SIGNING_JWKS holds them. */
const env = await (async () => {
  const keys: JWK[] = [];
  for (const kid of ["k-current", "k-next"]) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    keys.push({ ...(await exportJWK(privateKey)), kid, alg: "ES256", use: "sig" });
  }
  return {
    PUBLIC_ORIGIN: ORIGIN,
    POPPY_CLIENT_NAME: "Property Agent",
    POPPY_LOGO_URI: `${ORIGIN}/logo.svg`,
    POPPY_SIGNING_JWKS: JSON.stringify(keys)
  } as unknown as Env;
})();
const identity = readIdentity(env);
const signing = await currentKey(env);
const strangerKey = (await generateKeyPair("ES256")).privateKey;

/** A mock Company with this configuration, serving it our client metadata and keys. */
async function companyWith(config: Partial<MockConfig>): Promise<Company> {
  const company = new Company(`c${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, env);
  company.config = { ...DEFAULT_CONFIG, ...config };
  company.served.set(identity.clientId, { status: 200, body: JSON.stringify(clientMetadata(env)) });
  company.served.set(identity.jwksUri, { status: 200, body: JSON.stringify({ keys: (await readSigningKeys(env)).map((key) => key.publicJwk) }) });
  return company;
}

/** The mock's readings of the draft's open questions (S1, S2, S23), drawn like any other input. */
const readings = gs.record({
  strictAssertions: gs.booleans(),
  clientAssertionAud: gs.sampledFrom(["lenient", "exact"] as const),
  requireNonce: gs.booleans(),
  nonceScope: gs.sampledFrom(["company", "origin"] as const)
});

function form(assertion: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    ...extra,
    client_id: identity.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion
  });
}

/** What the mock did with a request: accepted it, or refused it with an HTTP error. */
async function attempt<T>(check: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await check() };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const body = (await error.response.clone().json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `http_${error.response.status}` };
  }
}

function inbound(method: string, url: string, headers: Record<string, string>): Inbound {
  return { request: new Request(url, { method, headers }), url: new URL(url), bodyText: "" };
}

const endpointNames = ["tokenEndpoint", "revocationEndpoint", "deviceEndpoint"] as const;
const methods = gs.sampledFrom(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** A request URL on one of the Company's hosts, with any path, query and fragment. */
function resourceUrl(company: Company) {
  return gs.composite((tc) => {
    const host = tc.draw(gs.sampledFrom([company.hosts.api, company.hosts.web, company.hosts.mcpUrl, company.hosts.issuer]));
    const url = new URL(host);
    url.pathname = tc.draw(gs.fromRegex("(/[A-Za-z0-9._~%-]{1,10}){0,4}", { fullmatch: true }));
    url.search = tc.draw(gs.text({ maxSize: 12 }));
    url.hash = tc.draw(gs.text({ maxSize: 6 }));
    return url.href;
  });
}

describe("our client's JWTs pass the mock Company's checks", () => {
  it(
    "a client assertion for the endpoint called, under every reading of aud and strictness (S1, S2)",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      const result = await attempt(async () => company.authenticateClient(form(await clientAssertion(signing, identity.clientId, endpoint)), endpoint));
      expect(result.ok).toBe(true);
      expect(company.violations).toEqual([]);
    })
  );

  it(
    "a Session assertion, for any User ID our client makes",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const userId = `usr_${joseBase64url.encode(crypto.getRandomValues(new Uint8Array(16)))}`;
      const client = await company.authenticateClient(form(await clientAssertion(signing, identity.clientId, company.hosts.tokenEndpoint)), company.hosts.tokenEndpoint);
      const verified = await company.verifySessionAssertion(client, await sessionAssertion(signing, identity.clientId, userId, company.hosts.tokenEndpoint));
      expect(verified).toBe(userId);
      expect(company.violations).toEqual([]);
    })
  );

  it(
    "a DPoP proof, for any method and URL, with the token's ath and the server's nonce",
    propertyAsync(async (tc) => {
      const config = tc.draw(readings);
      const company = await companyWith(config);
      const key = await newDpopKey();
      const atTokenEndpoint = tc.draw(gs.booleans());
      const method = atTokenEndpoint ? "POST" : tc.draw(methods);
      const url = atTokenEndpoint ? company.hosts.tokenEndpoint : tc.draw(resourceUrl(company));
      const token = atTokenEndpoint ? undefined : tc.draw(gs.fromRegex("[A-Za-z0-9._~+/-]{1,60}=*", { fullmatch: true }));
      const nonce = config.requireNonce ? company.nonceFor(new URL(url).origin) : undefined;
      const proof = await dpopProof(key, { method, url, ...(token !== undefined ? { accessToken: token } : {}), ...(nonce ? { nonce } : {}) });
      const result = await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: proof }), token));
      expect(result).toEqual({ ok: true, value: key.thumbprint });
      expect(company.violations).toEqual([]);
    })
  );
});

const seconds = () => Math.floor(Date.now() / 1000);
const VISIBLE = String.fromCharCode(...Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => 0x21 + i));
const jtis = () => joseBase64url.encode(crypto.getRandomValues(new Uint8Array(16)));

type Claims = Record<string, unknown>;
type Header = Record<string, unknown>;
type Mutation = { readonly header?: Header; readonly claims?: Claims; readonly key?: CryptoKey | Uint8Array; readonly raw?: string };

async function sign(header: Header, claims: Claims, key: CryptoKey | Uint8Array): Promise<string> {
  const defined = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
  return new SignJWT(defined(claims)).setProtectedHeader(defined(header) as { alg: string }).sign(key);
}

/** One thing wrong with a client assertion, and the violation it must be refused with (a strict Company's, where marked). */
const assertionMutations = (endpoint: string) =>
  gs.oneOf<{ name: string; mutation: Mutation; violation: string; strictOnly?: boolean }>(
    gs.text({ maxSize: 10 }).filter((typ) => typ !== "JWT" && typ !== "poppy-browser+jwt" && typ !== "dpop+jwt").map((typ) => ({ name: "typ", mutation: { header: { typ } }, violation: "client-assertion.typ", strictOnly: true })),
    gs.text({ minSize: 1, maxSize: 10 }).filter((kid) => !kid.startsWith("k-")).map((kid) => ({ name: "kid", mutation: { header: { kid } }, violation: "client-assertion.kid", strictOnly: true })),
    gs.sampledFrom(["poppy-browser+jwt", "dpop+jwt"]).map((typ) => ({ name: "wrong typ", mutation: { header: { typ } }, violation: "client-assertion.wrong-typ" })),
    gs.just({ name: "alg", mutation: { header: { alg: "HS256" }, key: new TextEncoder().encode("a shared secret of thirty-two bytes!") }, violation: "client-assertion.alg" }),
    gs.just({ name: "another key", mutation: { key: strangerKey }, violation: "client-assertion.signature" }),
    gs.integers({ minValue: 31, maxValue: 100_000 }).map((ago) => ({ name: "expired", mutation: { claims: { iat: seconds() - ago - 60, exp: seconds() - ago } }, violation: "client-assertion.signature" })),
    gs.just({ name: "aud array", mutation: { claims: { aud: [endpoint] } }, violation: "client-assertion.aud-array" }),
    gs.urls().filter((aud) => aud !== endpoint).map((aud) => ({ name: "aud", mutation: { claims: { aud } }, violation: "client-assertion.aud" })),
    gs.sampledFrom(["iss", "sub"]).flatMap((field) => gs.urls().map((value) => ({ name: field, mutation: { claims: { [field]: value } }, violation: "client-assertion.iss-sub" }))),
    gs.sampledFrom(["iat", "exp"]).map((field) => ({ name: `no ${field}`, mutation: { claims: { [field]: undefined } }, violation: "client-assertion.iat-exp-missing" })),
    gs.integers({ minValue: 301, maxValue: 1_000_000 }).map((span) => ({ name: "lifetime", mutation: { claims: { exp: seconds() + span } }, violation: "client-assertion.lifetime" })),
    gs.integers({ minValue: 61, maxValue: 300 }).map((span) => ({ name: "strict lifetime", mutation: { claims: { exp: seconds() + span } }, violation: "client-assertion.lifetime", strictOnly: true })),
    gs.just({ name: "no jti", mutation: { claims: { jti: undefined } }, violation: "client-assertion.jti-missing" }),
    gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789-_", maxSize: 21 }).filter((jti) => jti !== "").map((jti) => ({ name: "weak jti", mutation: { claims: { jti } }, violation: "client-assertion.jti-weak" })),
    gs.text({ maxSize: 30 }).map((raw) => ({ name: "not a JWT", mutation: { raw: raw.replace(/\./g, "") || "x" }, violation: "client-assertion.not-jwt" }))
  );

describe("the mock Company refuses each thing wrong with an assertion, naming it", () => {
  it(
    "a client assertion with one thing wrong",
    propertyAsync(async (tc) => {
      const strict = tc.draw(gs.booleans());
      const company = await companyWith({ strictAssertions: strict, clientAssertionAud: tc.draw(gs.sampledFrom(["lenient", "exact"] as const)) });
      const endpoint = company.hosts.tokenEndpoint;
      const { name, mutation, violation, strictOnly } = tc.draw(assertionMutations(endpoint));
      tc.assume(!strictOnly || strict);
      tc.note(name);
      const now = seconds();
      const assertion =
        mutation.raw ??
        (await sign(
          { alg: "ES256", typ: "JWT", kid: signing.kid, ...mutation.header },
          { iss: identity.clientId, sub: identity.clientId, aud: endpoint, iat: now, exp: now + 60, jti: jtis(), ...mutation.claims },
          mutation.key ?? signing.privateKey
        ));
      const result = await attempt(() => company.authenticateClient(form(assertion), endpoint));
      // A weak jti is recorded but not refused: the draft asks for 128 bits, and a Company can't tell.
      if (violation !== "client-assertion.jti-weak") expect(result.ok).toBe(false);
      expect(company.violations.map(violationId)).toEqual([violation]);
    })
  );

  it(
    "a client assertion used twice",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      const assertion = await clientAssertion(signing, identity.clientId, endpoint);
      expect((await attempt(() => company.authenticateClient(form(assertion), endpoint))).ok).toBe(true);
      expect((await attempt(() => company.authenticateClient(form(assertion), endpoint))).ok).toBe(false);
      expect(company.violations.map(violationId)).toEqual(["client-assertion.jti-reused"]);
    })
  );
});

/** One thing wrong with a DPoP proof for `method url` with `token`, and the violation that names it (null: refused, nothing recorded). */
function proofMutations(method: string, url: string, token: string | undefined) {
  const atTokenEndpoint = token === undefined;
  return gs.oneOf<{ name: string; mutation: Mutation | { header: "missing" | "two" }; violation: string | null }>(
    gs.just({ name: "missing", mutation: { header: "missing" as const }, violation: "dpop.missing" }),
    gs.just({ name: "two proofs", mutation: { header: "two" as const }, violation: "dpop.multiple" }),
    gs.text({ maxSize: 12 }).filter((typ) => typ !== "dpop+jwt").map((typ) => ({ name: "typ", mutation: { header: { typ } }, violation: "dpop.typ" })),
    gs.just({ name: "alg", mutation: { header: { alg: "HS256" }, key: new TextEncoder().encode("a shared secret of thirty-two bytes!") }, violation: "dpop.alg" }),
    gs.just({ name: "no jwk", mutation: { header: { jwk: undefined } }, violation: "dpop.no-jwk" }),
    gs.just({ name: "private jwk", mutation: { header: { jwk: "private" } }, violation: "dpop.private-jwk" }),
    gs.just({ name: "another key", mutation: { key: strangerKey }, violation: "dpop.signature" }),
    methods.filter((other) => other !== method).map((htm) => ({ name: "htm", mutation: { claims: { htm } }, violation: "dpop.htm" })),
    gs.oneOf(gs.just(url), gs.just(`${url.split(/[?#]/)[0]}?q=1`), gs.urls()).filter((htu) => htu !== `${new URL(url).origin}${new URL(url).pathname}`).map((htu) => ({ name: "htu", mutation: { claims: { htu } }, violation: "dpop.htu" })),
    gs.integers({ minValue: 91, maxValue: 10_000_000 }).flatMap((off) => gs.sampledFrom([off, -off])).map((offset) => ({ name: "iat", mutation: { claims: { iat: seconds() + offset } }, violation: "dpop.iat" })),
    atTokenEndpoint
      ? gs.just({ name: "ath at the token endpoint", mutation: { claims: { ath: "AAAA" } }, violation: "dpop.ath-at-token-endpoint" })
      : gs.oneOf<{ name: string; mutation: Mutation; violation: string }>(
          gs.just({ name: "no ath", mutation: { claims: { ath: undefined } }, violation: "dpop.ath" }),
          gs.text({ minSize: 1, maxSize: 60 }).filter((other) => other !== token).map((other) => ({ name: "ath of another token", mutation: { claims: { ath: `hash:${other}` } }, violation: "dpop.ath" }))
        ),
    // Header values can't hold control characters and lose surrounding spaces, so the junk is visible ASCII.
    gs.text({ alphabet: VISIBLE.replace(/[.,]/g, ""), minSize: 1, maxSize: 30 }).map((raw) => ({ name: "not a JWT", mutation: { raw }, violation: "dpop.not-jwt" }))
  );
}

describe("the mock Company refuses each thing wrong with a DPoP proof, naming it", () => {
  it(
    "a proof with one thing wrong",
    propertyAsync(async (tc) => {
      const company = await companyWith({});
      const key: DpopKey = await newDpopKey();
      const privateJwk = await exportJWK((await generateKeyPair("ES256", { extractable: true })).privateKey);
      const atTokenEndpoint = tc.draw(gs.booleans());
      const method = atTokenEndpoint ? "POST" : tc.draw(methods);
      const url = atTokenEndpoint ? company.hosts.tokenEndpoint : tc.draw(resourceUrl(company));
      const token = atTokenEndpoint ? undefined : tc.draw(gs.fromRegex("[A-Za-z0-9._~+/-]{1,60}", { fullmatch: true }));
      const { name, mutation, violation } = tc.draw(proofMutations(method, url, token));
      tc.note(name);
      const claims: Claims = { jti: jtis(), htm: method, htu: `${new URL(url).origin}${new URL(url).pathname}`, iat: seconds(), ...(token !== undefined ? { ath: await sha256(token) } : {}) };
      const build = async (m: Mutation) => {
        if (m.raw !== undefined) return m.raw;
        const merged = { ...claims, ...m.claims };
        if (typeof merged.ath === "string" && merged.ath.startsWith("hash:")) merged.ath = await sha256(merged.ath.slice(5));
        const header: Header = { alg: "ES256", typ: "dpop+jwt", jwk: key.publicJwk, ...m.header };
        if (header.jwk === "private") header.jwk = privateJwk;
        return sign(header, merged, m.key ?? key.privateKey);
      };
      const headers: Record<string, string> = {};
      if ("header" in mutation && mutation.header === "two") headers.DPoP = `${await build({})}, ${await build({})}`;
      else if (!("header" in mutation && mutation.header === "missing")) headers.DPoP = await build(mutation as Mutation);
      const result = await attempt(() => company.verifyDpop(inbound(method, url, headers), token));
      expect(result.ok).toBe(false);
      expect(company.violations.map(violationId)).toEqual(violation === null ? [] : [violation]);
    })
  );

  it(
    "a proof used twice is refused, and a nonce the key has used must be kept",
    propertyAsync(async (tc) => {
      const company = await companyWith({ requireNonce: true, nonceScope: tc.draw(gs.sampledFrom(["company", "origin"] as const)) });
      const key = await newDpopKey();
      const method = tc.draw(methods);
      const url = tc.draw(resourceUrl(company));
      const token = tc.draw(gs.fromRegex("[A-Za-z0-9]{8,40}", { fullmatch: true }));
      const nonce = company.nonceFor(new URL(url).origin);
      const proof = await dpopProof(key, { method, url, accessToken: token, nonce });
      expect((await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: proof }), token))).ok).toBe(true);
      // The same proof again: refused as a replay.
      expect(await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: proof }), token))).toEqual({ ok: false, error: "invalid_dpop_proof" });
      expect(company.violations.map(violationId)).toEqual(["dpop.jti-reused"]);
      // A later proof from the same key that drops the nonce breaks the rule.
      await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 5));
      const dropped = await dpopProof(key, { method, url, accessToken: token });
      expect(await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: dropped }), token))).toEqual({ ok: false, error: "use_dpop_nonce" });
      expect(company.violations.map(violationId)).toEqual(["dpop.jti-reused", "dpop.nonce-ignored"]);
    }, { testCases: 3 })
  );
});
