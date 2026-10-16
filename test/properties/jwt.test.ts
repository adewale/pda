import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, base64url as joseBase64url, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import { clientAssertion, dpopProof, newDpopKey, randomId, sessionAssertion, sha256, type DpopKey } from "../../src/poppy/jwt";
import { currentKey, readIdentity, readSigningKeys } from "../../src/poppy/keys";
import { clientMetadata } from "../../src/poppy/routes";
import { Company, HttpError, type Inbound } from "../mock-company/core";
import { DEFAULT_CONFIG, type MockConfig } from "../mock-company/types";
import { violationId } from "../mock-company/violations";
import { gs, propertyAsync } from "./hegel";

/**
 * Our client's JWTs against the mock Company's checks, in both directions.
 * Accept: every client assertion, Session assertion and DPoP proof our
 * client builds is checked under every reading the mock can take, including
 * token-endpoint-only S1 refusals at other endpoints. Reject: a proof or
 * assertion with one thing wrong is refused, and the mock records
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
  clientAssertionAud: gs.sampledFrom(["lenient", "exact", "token-endpoint"] as const),
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
  return { request: new Request(url, { method, headers }), url: new URL(url), bodyText: "", bodyBytes: new Uint8Array() };
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

describe("our client's JWTs against the mock Company's readings", () => {
  it(
    "a client assertion matches each audience and strictness reading at the endpoint called (S1, S2)",
    propertyAsync(async (tc) => {
      const config = tc.draw(readings);
      const company = await companyWith(config);
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      const result = await attempt(async () => company.authenticateClient(form(await clientAssertion(signing, identity.clientId, endpoint)), endpoint));
      // S1's token-endpoint-only reading intentionally refuses the PDA's
      // endpoint-specific audience on revocation/device calls (poppy.test.ts).
      if (config.clientAssertionAud === "token-endpoint" && endpoint !== company.hosts.tokenEndpoint) {
        expect(result).toEqual({ ok: false, error: "invalid_client" });
      } else expect(result).toMatchObject({ ok: true, value: { clientId: identity.clientId } });
      expect(company.recorded).toEqual([]);
    })
  );

  it(
    "a Session assertion, for any User ID our client makes",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      // PoppyClient.userId's generator; its randomness is the client's, not drawn.
      const userId = randomId("usr_");
      const client = await company.authenticateClient(form(await clientAssertion(signing, identity.clientId, company.hosts.tokenEndpoint)), company.hosts.tokenEndpoint);
      const verified = await company.verifySessionAssertion(client, await sessionAssertion(signing, identity.clientId, userId, company.hosts.tokenEndpoint));
      expect(verified).toBe(userId);
      expect(company.recorded).toEqual([]);
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
      expect(company.recorded).toEqual([]);
    })
  );
});

/** The Company advertises both algorithms; our own PDA signer remains ES256. */
for (const alg of ["ES256", "RS256"] as const) {
  const pair = await generateKeyPair(alg, { extractable: true });
  const kid = `accepted-${alg}`;
  const published = { ...await exportJWK(pair.publicKey), kid, alg, use: "sig" };
  const assertion = (sub: string, aud: string, lifetime: number) => {
    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({}).setProtectedHeader({ alg, typ: "JWT", kid })
      .setIssuer(identity.clientId).setSubject(sub).setAudience(aud)
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + lifetime).setJti(randomId()).sign(pair.privateKey);
  };

  describe(`Company verifier accepts ${alg}`, () => {
    it("accepts a self-contained DPoP proof with the generated method, target, nonce and token binding", propertyAsync(async (tc) => {
      const config = tc.draw(readings);
      const company = await companyWith(config);
      const tokenRequest = tc.draw(gs.booleans());
      const method = tokenRequest ? "POST" : tc.draw(methods);
      const url = tokenRequest ? company.hosts.tokenEndpoint : tc.draw(resourceUrl(company));
      const token = tokenRequest ? undefined : tc.draw(gs.text({ alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", minSize: 1, maxSize: 60 }));
      const target = new URL(url);
      const claims = { htm: method, htu: `${target.origin}${target.pathname}`, iat: Math.floor(Date.now() / 1000), jti: randomId(),
        ...(token === undefined ? {} : { ath: await sha256(token) }),
        ...(config.requireNonce ? { nonce: company.nonceFor(target.origin) } : {}) };
      const proof = await new SignJWT(claims).setProtectedHeader({ alg, typ: "dpop+jwt", jwk: published }).sign(pair.privateKey);
      const verified = await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: proof }), token));
      expect(verified).toEqual({ ok: true, value: await calculateJwkThumbprint(published) });
      expect(company.recorded).toEqual([]);
    }));

    it("authenticates fresh client assertions using the matching published key under generated readings", propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      company.served.set(identity.jwksUri, { status: 200, body: JSON.stringify({ keys: [published] }) });
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      const lifetime = tc.draw(gs.integers({ minValue: 1, maxValue: company.config.strictAssertions ? 60 : 300 }));
      const audience = company.config.clientAssertionAud === "token-endpoint" ? company.hosts.tokenEndpoint : endpoint;
      const result = await attempt(() => assertion(identity.clientId, audience, lifetime)
        .then((jwt) => company.authenticateClient(form(jwt), endpoint)));
      expect(result).toMatchObject({ ok: true, value: { clientId: identity.clientId, jwks: { keys: [published] } } });
      expect(company.recorded).toEqual([]);
    }));

    it("returns the generated User ID from a Session assertion signed with the matching published key", propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      company.served.set(identity.jwksUri, { status: 200, body: JSON.stringify({ keys: [published] }) });
      const userId = `usr_${tc.draw(gs.text({ alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", minSize: 22, maxSize: 40 }))}`;
      const endpoint = company.hosts.tokenEndpoint;
      const client = await company.authenticateClient(form(await assertion(identity.clientId, endpoint, 60)), endpoint);
      const verified = await company.verifySessionAssertion(client, await assertion(userId, endpoint, 60));
      expect(verified).toBe(userId);
      expect(company.recorded).toEqual([]);
    }));
  });
}

const seconds = () => Math.floor(Date.now() / 1000);
const VISIBLE = String.fromCharCode(...Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => 0x21 + i));
const jtis = () => joseBase64url.encode(crypto.getRandomValues(new Uint8Array(16)));

type Claims = Record<string, unknown>;
type Header = Record<string, unknown>;
/**
 * One thing changed in a JWT: header members, claims, the signing key, the
 * whole text (`raw`), or a signature segment written by hand (`signature`),
 * for an algorithm nothing here signs with, `none` included.
 */
type Mutation = { readonly header?: Header; readonly claims?: Claims; readonly key?: CryptoKey | Uint8Array; readonly raw?: string; readonly signature?: string };

const encodeSegment = (record: Record<string, unknown>) => joseBase64url.encode(JSON.stringify(record));

async function sign(header: Header, claims: Claims, key: CryptoKey | Uint8Array, signature?: string): Promise<string> {
  const defined = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
  if (signature !== undefined) return `${encodeSegment(defined(header))}.${encodeSegment(defined(claims))}.${signature}`;
  return new SignJWT(defined(claims)).setProtectedHeader(defined(header) as { alg: string }).sign(key);
}

const SHARED_SECRET = new TextEncoder().encode("a shared secret of thirty-two bytes!");
/** Our two published kids: any other names no key. */
const realKids = (await readSigningKeys(env)).map((key) => key.kid);
const strangerJwk = await exportJWK((await generateKeyPair("ES256")).publicKey);

/** Algorithms a Company must refuse: anything but ES256 and RS256. */
const badAlgs = gs.oneOf(gs.sampledFrom(["none", "None", "NONE", "", "ES384", "ES512", "RS384", "RS512", "PS256", "EdDSA", "HS384"]), gs.text({ maxSize: 8 })).filter((alg) => alg !== "ES256" && alg !== "RS256");

/** Wrong algs, one generator each so a oneOf draws each as often as any other mutation: HS256 really signed with a shared secret, `none` unsigned, or any other with a junk signature. */
function algMutations<T>(as: (name: string, mutation: Mutation) => T): gs.Generator<T>[] {
  return [
    gs.just(as("alg HS256", { header: { alg: "HS256" }, key: SHARED_SECRET })),
    gs.just(as("alg none, unsigned", { header: { alg: "none" }, signature: "" })),
    gs.tuples(badAlgs, gs.binary({ maxSize: 64 })).map(([alg, bytes]) => as(`alg ${JSON.stringify(alg)}`, { header: { alg }, signature: joseBase64url.encode(bytes) }))
  ];
}

type Wrong = {
  readonly name: string;
  readonly mutation: Mutation;
  /** What a strict Company records. */
  readonly violation: string;
  /** What a lenient one records, where that differs. */
  readonly lenient?: string;
  readonly strictOnly?: boolean;
  /** Recorded, but nothing the Company can refuse. */
  readonly recordedOnly?: boolean;
};

/**
 * One thing wrong with a client or Session assertion that both are checked
 * for (spec 4.1, 4.2): header, signature, key, lifetime, jti, and text that
 * isn't a JWT at all. Each is named by its own violation, `kind.<check>`, and is
 * its own generator, spread into the caller's oneOf so each is drawn as often.
 */
function signedMutations(kind: "client-assertion" | "session-assertion", rightTyps: readonly string[]): gs.Generator<Wrong>[] {
  return [
    gs.text({ maxSize: 10 }).filter((typ) => !rightTyps.includes(typ)).map((typ) => ({ name: "typ", mutation: { header: { typ } }, violation: `${kind}.typ`, strictOnly: true })),
    // A kid that names no published key: strict Companies say so; lenient ones find no key to verify with.
    gs.text({ minSize: 1, maxSize: 10 }).filter((kid) => !realKids.includes(kid)).map((kid) => ({ name: "kid", mutation: { header: { kid } }, violation: `${kind}.kid`, lenient: `${kind}.signature` })),
    gs.just({ name: "no kid", mutation: { header: { kid: undefined } }, violation: `${kind}.kid`, strictOnly: true }),
    ...algMutations((name, mutation) => ({ name, mutation, violation: `${kind}.alg` })),
    gs.sampledFrom(["jwk", "jku", "x5u"]).map((member) => ({
      name: `embedded ${member}`,
      mutation: { header: { [member]: member === "jwk" ? strangerJwk : "https://keys.attacker.example/jwks.json" } },
      violation: `${kind}.embedded-key`,
      recordedOnly: true
    })),
    gs.just({ name: "another key", mutation: { key: strangerKey }, violation: `${kind}.signature` }),
    gs.integers({ minValue: 31, maxValue: 100_000 }).map((ago) => ({ name: "expired", mutation: { claims: { iat: seconds() - ago - 60, exp: seconds() - ago } }, violation: `${kind}.signature` })),
    gs.sampledFrom(["iat", "exp"]).map((field) => ({ name: `no ${field}`, mutation: { claims: { [field]: undefined } }, violation: `${kind}.iat-exp-missing` })),
    gs.integers({ minValue: 301, maxValue: 1_000_000 }).map((span) => ({ name: "lifetime", mutation: { claims: { exp: seconds() + span } }, violation: `${kind}.lifetime` })),
    gs.integers({ minValue: 61, maxValue: 300 }).map((span) => ({ name: "strict lifetime", mutation: { claims: { exp: seconds() + span } }, violation: `${kind}.lifetime`, strictOnly: true })),
    gs.just({ name: "no jti", mutation: { claims: { jti: undefined } }, violation: `${kind}.jti-missing` }),
    // A weak jti is recorded but not refused: the draft asks for 128 bits, and a Company can't tell.
    gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789-_", minSize: 1, maxSize: 21 }).map((jti) => ({ name: "weak jti", mutation: { claims: { jti } }, violation: `${kind}.jti-weak`, recordedOnly: true })),
    gs.text({ maxSize: 30 }).map((raw) => ({ name: "not a JWT", mutation: { raw: raw.replace(/\./g, "") || "x" }, violation: `${kind}.not-jwt` }))
  ];
}

/** One thing wrong with a client assertion for `endpoint`. */
const assertionMutations = (endpoint: string) =>
  gs.oneOf<Wrong>(
    ...signedMutations("client-assertion", ["JWT", "poppy-browser+jwt", "dpop+jwt"]),
    gs.sampledFrom(["poppy-browser+jwt", "dpop+jwt"]).map((typ) => ({ name: "wrong typ", mutation: { header: { typ } }, violation: "client-assertion.wrong-typ" })),
    gs.just({ name: "aud array", mutation: { claims: { aud: [endpoint] } }, violation: "client-assertion.aud-array" }),
    gs.urls().filter((aud) => aud !== endpoint).map((aud) => ({ name: "aud", mutation: { claims: { aud } }, violation: "client-assertion.aud" })),
    gs.sampledFrom(["iss", "sub"]).flatMap((field) => gs.urls().map((value) => ({ name: field, mutation: { claims: { [field]: value } }, violation: "client-assertion.iss-sub" })))
  );

/** One thing wrong with a Session assertion at `company`'s token endpoint. */
const sessionMutations = (company: Company) =>
  gs.oneOf<Wrong>(
    ...signedMutations("session-assertion", ["JWT", "poppy-browser+jwt"]),
    gs.just({ name: "aud array", mutation: { claims: { aud: [company.hosts.tokenEndpoint] } }, violation: "session-assertion.aud" }),
    gs.oneOf(gs.just(company.hosts.issuer), gs.just(company.hosts.revocationEndpoint), gs.urls()).map((aud) => ({ name: "aud", mutation: { claims: { aud } }, violation: "session-assertion.aud" })),
    gs.urls().map((iss) => ({ name: "iss", mutation: { claims: { iss } }, violation: "session-assertion.iss" })),
    gs.oneOf(gs.just(undefined), gs.just("")).map((sub) => ({ name: "no sub", mutation: { claims: { sub } }, violation: "session-assertion.sub" })),
    gs.just({ name: "browser typ", mutation: { header: { typ: "poppy-browser+jwt" } }, violation: "session-assertion.browser-typ" }),
    // A personal User ID is recorded but not refused: the Company has nothing to refuse it with.
    gs.just({ name: "personal User ID", mutation: { claims: { sub: "ada@example.com" } }, violation: "user-id.personal", recordedOnly: true })
  );

/** Our assertion, as the client signs it, with one thing wrong. */
async function wrongAssertion(mutation: Mutation, claims: Claims): Promise<string> {
  return mutation.raw ?? (await sign({ alg: "ES256", typ: "JWT", kid: signing.kid, ...mutation.header }, { ...claims, ...mutation.claims }, mutation.key ?? signing.privateKey, mutation.signature));
}

describe("the mock Company refuses each thing wrong with an assertion, naming it", () => {
  it(
    "a client assertion with one thing wrong",
    propertyAsync(async (tc) => {
      const strict = tc.draw(gs.booleans());
      const company = await companyWith({ strictAssertions: strict, clientAssertionAud: tc.draw(gs.sampledFrom(["lenient", "exact", "token-endpoint"] as const)) });
      const endpoint = company.hosts.tokenEndpoint;
      const wrong = tc.draw(assertionMutations(endpoint));
      tc.assume(!wrong.strictOnly || strict);
      tc.note(wrong.name);
      const now = seconds();
      const assertion = await wrongAssertion(wrong.mutation, { iss: identity.clientId, sub: identity.clientId, aud: endpoint, iat: now, exp: now + 60, jti: jtis() });
      const result = await attempt(() => company.authenticateClient(form(assertion), endpoint));
      expect(result.ok).toBe(wrong.recordedOnly === true);
      expect(company.recorded.map(violationId)).toEqual([strict ? wrong.violation : (wrong.lenient ?? wrong.violation)]);
    })
  );

  it(
    "a client assertion used twice",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      const audience = company.config.clientAssertionAud === "token-endpoint" ? company.hosts.tokenEndpoint : endpoint;
      const assertion = await clientAssertion(signing, identity.clientId, audience);
      expect(await attempt(() => company.authenticateClient(form(assertion), endpoint)))
        .toMatchObject({ ok: true, value: { clientId: identity.clientId } });
      expect((await attempt(() => company.authenticateClient(form(assertion), endpoint))).ok).toBe(false);
      expect(company.recorded.map(violationId)).toEqual(["client-assertion.jti-reused"]);
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
    ...algMutations((name, mutation) => ({ name, mutation, violation: "dpop.alg" as string | null })),
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

describe("the mock Company refuses each thing wrong with a Session assertion, naming it", () => {
  it(
    "a Session assertion with one thing wrong",
    propertyAsync(async (tc) => {
      const config = tc.draw(readings);
      const company = await companyWith(config);
      const client = await company.authenticateClient(form(await clientAssertion(signing, identity.clientId, company.hosts.tokenEndpoint)), company.hosts.tokenEndpoint);
      const wrong = tc.draw(sessionMutations(company));
      tc.assume(!wrong.strictOnly || config.strictAssertions);
      tc.note(wrong.name);
      const now = seconds();
      const assertion = await wrongAssertion(wrong.mutation, { iss: identity.clientId, sub: randomId("usr_"), aud: company.hosts.tokenEndpoint, iat: now, exp: now + 60, jti: jtis() });
      const result = await attempt(() => company.verifySessionAssertion(client, assertion));
      expect(result.ok).toBe(wrong.recordedOnly === true);
      expect(company.recorded.map(violationId)).toEqual([config.strictAssertions ? wrong.violation : (wrong.lenient ?? wrong.violation)]);
    })
  );
});

describe("the mock Company refuses each thing wrong with a DPoP proof, naming it", () => {
  it(
    "a proof with one thing wrong",
    propertyAsync(async (tc) => {
      // Any reading but required nonces, which refuse a nonce-less proof before anything else is checked.
      const company = await companyWith({ ...tc.draw(readings), requireNonce: false });
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
        return sign(header, merged, m.key ?? key.privateKey, m.signature);
      };
      const headers: Record<string, string> = {};
      if ("header" in mutation && mutation.header === "two") headers.DPoP = `${await build({})}, ${await build({})}`;
      else if (!("header" in mutation && mutation.header === "missing")) headers.DPoP = await build(mutation as Mutation);
      const result = await attempt(() => company.verifyDpop(inbound(method, url, headers), token));
      expect(result.ok).toBe(false);
      expect(company.recorded.map(violationId)).toEqual(violation === null ? [] : [violation]);
    })
  );

  it(
    "a proof used twice",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const key = await newDpopKey();
      const method = tc.draw(methods);
      const url = tc.draw(resourceUrl(company));
      const token = tc.draw(gs.fromRegex("[A-Za-z0-9]{8,40}", { fullmatch: true }));
      const nonce = company.config.requireNonce ? company.nonceFor(new URL(url).origin) : undefined;
      const proof = await dpopProof(key, { method, url, accessToken: token, ...(nonce ? { nonce } : {}) });
      expect((await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: proof }), token))).ok).toBe(true);
      expect(await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: proof }), token))).toEqual({ ok: false, error: "invalid_dpop_proof" });
      expect(company.recorded.map(violationId)).toEqual(["dpop.jti-reused"]);
    })
  );

  it(
    "a later proof that drops the nonce its key already used at that server",
    propertyAsync(async (tc) => {
      const at = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(at);
      try {
        const company = await companyWith({ requireNonce: true, nonceScope: tc.draw(gs.sampledFrom(["company", "origin"] as const)) });
        const key = await newDpopKey();
        const method = tc.draw(methods);
        const url = tc.draw(resourceUrl(company));
        const token = tc.draw(gs.fromRegex("[A-Za-z0-9]{8,40}", { fullmatch: true }));
        const proof = await dpopProof(key, { method, url, accessToken: token, nonce: company.nonceFor(new URL(url).origin) });
        expect((await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: proof }), token))).ok).toBe(true);
        // Exercise a later second deterministically, without a one-second wait per case.
        clock.mockReturnValue(at + tc.draw(gs.integers({ minValue: 1, maxValue: 30 })) * 1000);
        const dropped = await dpopProof(key, { method, url, accessToken: token });
        expect(await attempt(() => company.verifyDpop(inbound(method, url, { DPoP: dropped }), token))).toEqual({ ok: false, error: "use_dpop_nonce" });
        expect(company.recorded.map(violationId)).toEqual(["dpop.nonce-ignored"]);
      } finally {
        clock.mockRestore();
      }
    })
  );
});
