import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, base64url as joseBase64url, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import { clientAssertion, delegate, dpopProof, htu, newDpopKey, randomId, sessionJwt, sha256, type Delegated, type DpopKey } from "../../src/poppy/jwt";
import { currentKey, readIdentity, readSigningKeys } from "../../src/poppy/keys";
import { clientMetadata } from "../../src/poppy/routes";
import { Company, HttpError, type Inbound } from "../mock-company/core";
import { DEFAULT_CONFIG, type MockConfig } from "../mock-company/types";
import { violationId } from "../mock-company/violations";
import { gs, propertyAsync } from "./hegel";

/**
 * Our client's JWTs against the mock Company's checks, in both directions.
 * Accept: every client assertion (4.1), Session JWT and delegation (5.2) and
 * DPoP proof (4.5) our client builds is checked under every reading the mock
 * can take. Reject: a proof, assertion, Session JWT or delegation with one
 * thing wrong is refused, and the mock records exactly the violation that
 * names it.
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

/** The mock's readings of the draft's open questions (S2, S23), drawn like any other input. 0.3 settles S1: the audience is the issuer (4.1). */
const readings = gs.record({
  strictAssertions: gs.booleans(),
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
    "a client assertion, its audience the issuer, at whichever endpoint is called, under each strictness reading (4.1, S2)",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      // PoppyClient's audience: the issuer, as a single string, whatever endpoint is called.
      const result = await attempt(async () => company.authenticateClient(form(await clientAssertion(signing, identity.clientId, company.hosts.issuer)), endpoint));
      expect(result).toMatchObject({ ok: true, value: { clientId: identity.clientId } });
      expect(company.recorded).toEqual([]);
    })
  );

  it(
    "a Session JWT, for any method and URL, with or without an access token, for the User ID and Session our client makes (5.2, 5.3)",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      // PoppyClient's generators for the User ID and sid; their randomness is the client's, not drawn.
      const userId = randomId("usr_");
      const sid = randomId();
      const delegated = await delegate(signing, identity.clientId, await newDpopKey());
      const method = tc.draw(methods);
      const url = tc.draw(resourceUrl(company));
      const token = tc.draw(gs.optional(gs.fromRegex("[A-Za-z0-9._~+/-]{1,60}=*", { fullmatch: true }))) ?? undefined;
      const jwt = await sessionJwt(delegated, { clientId: identity.clientId, issuer: company.hosts.issuer, sid, userId, method, url, ...(token !== undefined ? { accessToken: token } : {}) });
      const result = await attempt(() => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": jwt }), token ?? null));
      expect(result).toMatchObject({ ok: true, value: { client: { clientId: identity.clientId }, session: { userId } } });
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

/** A User's delegated key and a delegation for it, signed by `key` under `kid` with `alg`, as a Personal Agent signing blindly would (5.2, 10.7). */
async function delegationWith(alg: string, kid: string, key: CryptoKey, claims: Claims = {}): Promise<Delegated> {
  const delegated = await newDpopKey();
  const issuedAt = Math.floor(Date.now() / 3_600_000) * 3600;
  const expiresAt = issuedAt + 4 * 3600;
  const delegation = await new SignJWT({ cnf: { jwk: delegated.publicJwk }, ...claims })
    .setProtectedHeader({ alg, typ: "pap-delegation+jwt", kid })
    .setIssuer(identity.clientId).setIssuedAt(issuedAt).setExpirationTime(expiresAt).setJti(randomId()).sign(key);
  return { key: delegated, delegation, expiresAt };
}

/** A Session JWT our client would send for `method url`, with no access token. */
const sessionHeaderFor = (delegated: Delegated, company: Company, method: string, url: string, userId = randomId("usr_")) =>
  sessionJwt(delegated, { clientId: identity.clientId, issuer: company.hosts.issuer, sid: randomId(), userId, method, url });

/** DPoP proofs: the Company advertises ES256 and RS256; our own signer remains ES256. */
for (const alg of ["ES256", "RS256"] as const) {
  const pair = await generateKeyPair(alg, { extractable: true });
  const published = { ...await exportJWK(pair.publicKey), alg };

  describe(`Company verifier accepts ${alg} DPoP proofs`, () => {
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

    it("refuses a DPoP proof signed by another key after accepting its correctly signed baseline", propertyAsync(async (tc) => {
      const other = await generateKeyPair(alg);
      const config = tc.draw(readings);
      const company = await companyWith(config);
      const tokenRequest = tc.draw(gs.booleans());
      const method = tokenRequest ? "POST" : tc.draw(methods);
      const url = tokenRequest ? company.hosts.tokenEndpoint : tc.draw(resourceUrl(company));
      const token = tokenRequest ? undefined : tc.draw(gs.text({ alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", minSize: 1, maxSize: 60 }));
      const target = new URL(url);
      const proof = async (key: CryptoKey) => new SignJWT({
        htm: method, htu: `${target.origin}${target.pathname}`, iat: Math.floor(Date.now() / 1000), jti: randomId(),
        ...(token === undefined ? {} : { ath: await sha256(token) }),
        ...(config.requireNonce ? { nonce: company.nonceFor(target.origin) } : {})
      }).setProtectedHeader({ alg, typ: "dpop+jwt", jwk: published }).sign(key);
      expect(await company.verifyDpop(inbound(method, url, { DPoP: await proof(pair.privateKey) }), token))
        .toBe(await calculateJwkThumbprint(published));
      expect(company.recorded).toEqual([]);
      expect(await attempt(async () => company.verifyDpop(inbound(method, url, { DPoP: await proof(other.privateKey) }), token)))
        .toEqual({ ok: false, error: "invalid_dpop_proof" });
      expect(company.recorded.map(violationId)).toEqual(["dpop.signature"]);
    }));
  });
}

/** Client assertions: Companies MUST accept ES256 and PS384 (4.1), and the Guides add RS256. */
for (const alg of ["ES256", "PS384", "RS256"] as const) {
  const pair = await generateKeyPair(alg, { extractable: true });
  const other = await generateKeyPair(alg);
  const kid = `accepted-${alg}`;
  const published = { ...await exportJWK(pair.publicKey), kid, alg, use: "sig" };
  const assertion = (aud: string, lifetime: number, key = pair.privateKey) => {
    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({}).setProtectedHeader({ alg, typ: "JWT", kid })
      .setIssuer(identity.clientId).setSubject(identity.clientId).setAudience(aud)
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + lifetime).setJti(randomId()).sign(key);
  };

  describe(`Company verifier accepts ${alg} client assertions`, () => {
    it("authenticates fresh client assertions using the matching published key under generated readings", propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      company.served.set(identity.jwksUri, { status: 200, body: JSON.stringify({ keys: [published] }) });
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      const lifetime = tc.draw(gs.integers({ minValue: 1, maxValue: company.config.strictAssertions ? 60 : 300 }));
      const result = await attempt(() => assertion(company.hosts.issuer, lifetime).then((jwt) => company.authenticateClient(form(jwt), endpoint)));
      expect(result).toMatchObject({ ok: true, value: { clientId: identity.clientId, jwks: { keys: [published] } } });
      expect(company.recorded).toEqual([]);
    }));

    it("refuses a client assertion signed by another key after accepting its correctly signed baseline", propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      company.served.set(identity.jwksUri, { status: 200, body: JSON.stringify({ keys: [published] }) });
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      expect(await company.authenticateClient(form(await assertion(company.hosts.issuer, 60)), endpoint)).toMatchObject({ clientId: identity.clientId, jwks: { keys: [published] } });
      expect(company.recorded).toEqual([]);
      expect(await attempt(async () => company.authenticateClient(form(await assertion(company.hosts.issuer, 60, other.privateKey)), endpoint)))
        .toEqual({ ok: false, error: "invalid_client" });
      expect(company.recorded.map(violationId)).toEqual(["client-assertion.signature"]);
    }));
  });
}

/** Delegations: Companies MUST accept ES256 and PS384 (5.2). */
for (const alg of ["ES256", "PS384"] as const) {
  const pair = await generateKeyPair(alg, { extractable: true });
  const other = await generateKeyPair(alg);
  const kid = `delegating-${alg}`;
  const published = { ...await exportJWK(pair.publicKey), kid, alg, use: "sig" };

  describe(`Company verifier accepts ${alg} delegations`, () => {
    it("accepts a Session JWT whose delegation the matching published key signed, for any request", propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      company.served.set(identity.jwksUri, { status: 200, body: JSON.stringify({ keys: [published] }) });
      const method = tc.draw(methods);
      const url = tc.draw(resourceUrl(company));
      const userId = randomId("usr_");
      const jwt = await sessionHeaderFor(await delegationWith(alg, kid, pair.privateKey), company, method, url, userId);
      expect(await attempt(() => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": jwt }), null)))
        .toMatchObject({ ok: true, value: { session: { userId } } });
      expect(company.recorded).toEqual([]);
    }));

    it("refuses a delegation signed by another key after accepting its correctly signed baseline", propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      company.served.set(identity.jwksUri, { status: 200, body: JSON.stringify({ keys: [published] }) });
      const method = tc.draw(methods);
      const url = tc.draw(resourceUrl(company));
      const baseline = await sessionHeaderFor(await delegationWith(alg, kid, pair.privateKey), company, method, url);
      expect((await attempt(() => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": baseline }), null))).ok).toBe(true);
      expect(company.recorded).toEqual([]);
      const forged = await sessionHeaderFor(await delegationWith(alg, kid, other.privateKey), company, method, url);
      expect(await attempt(() => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": forged }), null))).toEqual({ ok: false, error: "invalid_session" });
      expect(company.recorded.map(violationId)).toEqual(["delegation.signature"]);
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

/** Algorithms a Company must refuse: anything but those it accepts for that kind of JWT. */
const badAlgs = (accepted: readonly string[]) =>
  gs.oneOf(gs.sampledFrom(["none", "None", "NONE", "", "ES256", "ES384", "ES512", "RS256", "RS384", "RS512", "PS256", "PS384", "EdDSA", "HS384"]), gs.text({ maxSize: 8 })).filter((alg) => !accepted.includes(alg));

/** Wrong algs, one generator each so a oneOf draws each as often as any other mutation: HS256 really signed with a shared secret, `none` unsigned, or any other with a junk signature. */
function algMutations<T>(accepted: readonly string[], as: (name: string, mutation: Mutation) => T): gs.Generator<T>[] {
  return [
    gs.just(as("alg HS256", { header: { alg: "HS256" }, key: SHARED_SECRET })),
    gs.just(as("alg none, unsigned", { header: { alg: "none" }, signature: "" })),
    gs.tuples(badAlgs(accepted), gs.binary({ maxSize: 64 })).map(([alg, bytes]) => as(`alg ${JSON.stringify(alg)}`, { header: { alg }, signature: joseBase64url.encode(bytes) }))
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

/** The protocol's other JWTs, by their `typ` (4.5, 5.2). */
const OTHER_JWT_TYPS = ["dpop+jwt", "poppy-session+jwt", "pap-delegation+jwt"];

/**
 * One thing wrong with a client assertion (4.1): header, signature, key,
 * lifetime, jti, audience, issuer and subject, and text that isn't a JWT at
 * all. Each is named by its own violation, `client-assertion.<check>`, and
 * is its own generator, so each is drawn as often.
 */
const assertionMutations = (company: Company) =>
  gs.oneOf<Wrong>(
    gs.oneOf(gs.text({ maxSize: 10 }), gs.just("poppy-browser+jwt")).filter((typ) => !["JWT", ...OTHER_JWT_TYPS].includes(typ)).map((typ) => ({ name: "typ", mutation: { header: { typ } }, violation: "client-assertion.typ", strictOnly: true })),
    // Explicit typing (RFC 8725 3.11): another of the protocol's JWTs is never a client assertion, strict or not.
    gs.sampledFrom(OTHER_JWT_TYPS).map((typ) => ({ name: "wrong typ", mutation: { header: { typ } }, violation: "client-assertion.wrong-typ" })),
    // A kid that names no published key: strict Companies say so; lenient ones find no key to verify with.
    gs.text({ minSize: 1, maxSize: 10 }).filter((kid) => !realKids.includes(kid)).map((kid) => ({ name: "kid", mutation: { header: { kid } }, violation: "client-assertion.kid", lenient: "client-assertion.signature" })),
    gs.just({ name: "no kid", mutation: { header: { kid: undefined } }, violation: "client-assertion.kid", strictOnly: true }),
    ...algMutations(["ES256", "PS384", "RS256"], (name, mutation) => ({ name, mutation, violation: "client-assertion.alg" })),
    gs.sampledFrom(["jwk", "jku", "x5u"]).map((member) => ({
      name: `embedded ${member}`,
      mutation: { header: { [member]: member === "jwk" ? strangerJwk : "https://keys.attacker.example/jwks.json" } },
      violation: "client-assertion.embedded-key",
      recordedOnly: true
    })),
    gs.just({ name: "another key", mutation: { key: strangerKey }, violation: "client-assertion.signature" }),
    gs.integers({ minValue: 31, maxValue: 100_000 }).map((ago) => ({ name: "expired", mutation: { claims: { iat: seconds() - ago - 60, exp: seconds() - ago } }, violation: "client-assertion.signature" })),
    gs.sampledFrom(["iat", "exp"]).map((field) => ({ name: `no ${field}`, mutation: { claims: { [field]: undefined } }, violation: "client-assertion.iat-exp-missing" })),
    gs.integers({ minValue: 301, maxValue: 1_000_000 }).map((span) => ({ name: "lifetime", mutation: { claims: { exp: seconds() + span } }, violation: "client-assertion.lifetime" })),
    gs.integers({ minValue: 61, maxValue: 300 }).map((span) => ({ name: "strict lifetime", mutation: { claims: { exp: seconds() + span } }, violation: "client-assertion.lifetime", strictOnly: true })),
    gs.just({ name: "no jti", mutation: { claims: { jti: undefined } }, violation: "client-assertion.jti-missing" }),
    // A weak jti is recorded but not refused: the draft asks for 128 bits, and a Company can't tell.
    gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789-_", minSize: 1, maxSize: 21 }).map((jti) => ({ name: "weak jti", mutation: { claims: { jti } }, violation: "client-assertion.jti-weak", recordedOnly: true })),
    gs.text({ maxSize: 30 }).map((raw) => ({ name: "not a JWT", mutation: { raw: raw.replace(/\./g, "") || "x" }, violation: "client-assertion.not-jwt" })),
    gs.just({ name: "aud array", mutation: { claims: { aud: [company.hosts.issuer] } }, violation: "client-assertion.aud-array" }),
    // 4.1: the issuer, never an endpoint: 0.2's token-endpoint audience is refused too.
    gs.oneOf(gs.just(company.hosts.tokenEndpoint), gs.just(company.hosts.revocationEndpoint), gs.just(`${company.hosts.issuer}/`), gs.urls())
      .filter((aud) => aud !== company.hosts.issuer)
      .map((aud) => ({ name: "aud", mutation: { claims: { aud } }, violation: "client-assertion.aud" })),
    gs.sampledFrom(["iss", "sub"]).flatMap((field) => gs.urls().map((value) => ({ name: field, mutation: { claims: { [field]: value } }, violation: "client-assertion.iss-sub" })))
  );

/** Our assertion, as the client signs it, with one thing wrong. */
async function wrongAssertion(mutation: Mutation, claims: Claims): Promise<string> {
  return mutation.raw ?? (await sign({ alg: "ES256", typ: "JWT", kid: signing.kid, ...mutation.header }, { ...claims, ...mutation.claims }, mutation.key ?? signing.privateKey, mutation.signature));
}

describe("the mock Company refuses each thing wrong with a client assertion, naming it", () => {
  it(
    "a client assertion with one thing wrong",
    propertyAsync(async (tc) => {
      const strict = tc.draw(gs.booleans());
      const company = await companyWith({ strictAssertions: strict });
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      const wrong = tc.draw(assertionMutations(company));
      tc.assume(!wrong.strictOnly || strict);
      tc.note(wrong.name);
      const now = seconds();
      const assertion = await wrongAssertion(wrong.mutation, { iss: identity.clientId, sub: identity.clientId, aud: company.hosts.issuer, iat: now, exp: now + 60, jti: jtis() });
      const result = await attempt(() => company.authenticateClient(form(assertion), endpoint));
      expect(result.ok, wrong.name).toBe(wrong.recordedOnly === true);
      expect(company.recorded.map(violationId)).toEqual([strict ? wrong.violation : (wrong.lenient ?? wrong.violation)]);
    })
  );

  it(
    "a client assertion used twice",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const endpoint = company.hosts[tc.draw(gs.sampledFrom(endpointNames))];
      const assertion = await clientAssertion(signing, identity.clientId, company.hosts.issuer);
      expect(await attempt(() => company.authenticateClient(form(assertion), endpoint)))
        .toMatchObject({ ok: true, value: { clientId: identity.clientId } });
      expect((await attempt(() => company.authenticateClient(form(assertion), endpoint))).ok).toBe(false);
      expect(company.recorded.map(violationId)).toEqual(["client-assertion.jti-reused"]);
    })
  );
});

/** One thing wrong with a Session JWT (5.2, 5.3), as a Company checks it, in its header, claims, key or text. */
type SessionWrong = { readonly name: string; readonly mutation: Mutation | { readonly header: "missing" }; readonly violation: string; readonly recordedOnly?: boolean };

function sessionMutations(company: Company, delegated: Delegated, method: string, url: string, token: string | undefined) {
  const target = `${new URL(url).origin}${new URL(url).pathname}`;
  return gs.oneOf<SessionWrong>(
    gs.just({ name: "missing", mutation: { header: "missing" as const }, violation: token === undefined ? "session-jwt.missing" : "session-jwt.missing-with-token" }),
    // Header values can't hold control characters and lose surrounding spaces, so the junk is visible ASCII.
    gs.text({ alphabet: VISIBLE.replace(/\./g, ""), minSize: 1, maxSize: 30 }).map((raw) => ({ name: "not a JWT", mutation: { raw }, violation: "session-jwt.not-jwt" })),
    gs.oneOf(gs.text({ maxSize: 20 }), gs.sampledFrom(["dpop+jwt", "pap-delegation+jwt", "JWT"])).filter((typ) => typ !== "poppy-session+jwt").map((typ) => ({ name: "typ", mutation: { header: { typ } }, violation: "session-jwt.typ" })),
    ...algMutations(["ES256"], (name, mutation) => ({ name, mutation, violation: "session-jwt.alg" })),
    gs.oneOf<unknown>(gs.just(undefined), gs.integers()).map((pap_dlg) => ({ name: "no delegation", mutation: { header: { pap_dlg } }, violation: "session-jwt.no-delegation" })),
    gs.just({ name: "no iss", mutation: { claims: { iss: undefined } }, violation: "session-jwt.iss" }),
    gs.oneOf(gs.just(undefined), gs.text({ maxSize: 43 })).filter((kid) => kid !== delegated.key.thumbprint).map((kid) => ({ name: "kid", mutation: { header: { kid } }, violation: "session-jwt.kid" })),
    gs.just({ name: "another key", mutation: { key: strangerKey }, violation: "session-jwt.signature" }),
    gs.just({ name: "no iat", mutation: { claims: { iat: undefined } }, violation: "session-jwt.iat" }),
    // Outside the window (5.3: "such as one minute", plus skew), but before the delegation's exp, which is at least three hours away.
    gs.oneOf(gs.integers({ minValue: 91, maxValue: 10_000_000 }).map((off) => -off), gs.integers({ minValue: 91, maxValue: 3 * 3600 }))
      .map((offset) => ({ name: "iat", mutation: { claims: { iat: seconds() + offset } }, violation: "session-jwt.iat" })),
    gs.integers({ minValue: 1, maxValue: 10_000_000 }).map((after) => ({ name: "after its delegation", mutation: { claims: { iat: delegated.expiresAt + after } }, violation: "session-jwt.after-delegation" })),
    gs.oneOf<string | string[]>(gs.just([company.hosts.issuer]), gs.just(company.hosts.tokenEndpoint), gs.just(company.hosts.api), gs.just(`${company.hosts.issuer}/`), gs.urls())
      .filter((aud) => aud !== company.hosts.issuer)
      .map((aud) => ({ name: "aud", mutation: { claims: { aud } }, violation: "session-jwt.aud" })),
    methods.filter((other) => other !== method).map((htm) => ({ name: "htm", mutation: { claims: { htm } }, violation: "session-jwt.htm" })),
    gs.oneOf(gs.just(url), gs.just(`${target}?q=1`), gs.urls()).filter((htu) => htu !== target).map((htu) => ({ name: "htu", mutation: { claims: { htu } }, violation: "session-jwt.htu" })),
    gs.oneOf(gs.just(undefined), gs.just("")).map((jti) => ({ name: "no jti", mutation: { claims: { jti } }, violation: "session-jwt.jti-missing" })),
    // A weak jti is recorded but not refused: a Company can't tell.
    gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789-_", minSize: 1, maxSize: 21 }).map((jti) => ({ name: "weak jti", mutation: { claims: { jti } }, violation: "session-jwt.jti-weak", recordedOnly: true })),
    gs.oneOf(gs.just(undefined), gs.just(""), gs.just("s".repeat(257)), gs.text({ minSize: 1, maxSize: 20 }).filter((sid) => !/^[A-Za-z0-9_-]+$/.test(sid)))
      .map((sid) => ({ name: "sid", mutation: { claims: { sid } }, violation: "session-jwt.sid" })),
    gs.oneOf(gs.just(undefined), gs.just("")).map((sub) => ({ name: "no sub", mutation: { claims: { sub } }, violation: "session-jwt.sub" })),
    gs.oneOf<unknown>(gs.just(""), gs.integers(), gs.just(null)).map((agent_id) => ({ name: "agent_id", mutation: { claims: { agent_id } }, violation: "session-jwt.sub" })),
    token === undefined
      ? gs.text({ minSize: 1, maxSize: 60 }).map((other) => ({ name: "ath without a token", mutation: { claims: { ath: `hash:${other}` } }, violation: "session-jwt.ath-without-token" }))
      : gs.oneOf<SessionWrong>(
          gs.just({ name: "no ath", mutation: { claims: { ath: undefined } }, violation: "session-jwt.ath" }),
          gs.text({ minSize: 1, maxSize: 60 }).filter((other) => other !== token).map((other) => ({ name: "ath of another token", mutation: { claims: { ath: `hash:${other}` } }, violation: "session-jwt.ath" }))
        ),
    // A personal User ID is recorded but not refused: the Company has nothing to refuse it with.
    gs.just({ name: "personal User ID", mutation: { claims: { sub: "ada@example.com" } }, violation: "user-id.personal", recordedOnly: true })
  );
}

/** One thing wrong with a delegation (5.2), which a Company checks before the Session JWT it vouches for. */
function delegationMutations() {
  const hour = Math.floor(seconds() / 3600) * 3600;
  return gs.oneOf<Wrong>(
    gs.text({ alphabet: VISIBLE.replace(/\./g, ""), minSize: 1, maxSize: 30 }).map((raw) => ({ name: "not a JWT", mutation: { raw }, violation: "delegation.not-jwt" })),
    gs.oneOf(gs.just(undefined), gs.text({ maxSize: 20 }), gs.sampledFrom(["JWT", "poppy-session+jwt", "dpop+jwt"])).filter((typ) => typ !== "pap-delegation+jwt").map((typ) => ({ name: "typ", mutation: { header: { typ } }, violation: "delegation.typ" })),
    ...algMutations(["ES256", "PS384"], (name, mutation) => ({ name, mutation, violation: "delegation.alg" })),
    gs.oneOf(gs.just(undefined), gs.text({ maxSize: 10 })).filter((kid) => kid === undefined || !realKids.includes(kid)).map((kid) => ({ name: "kid", mutation: { header: { kid } }, violation: "delegation.kid" })),
    gs.just({ name: "another key", mutation: { key: strangerKey }, violation: "delegation.signature" }),
    gs.oneOf(gs.just(undefined), gs.urls()).map((iss) => ({ name: "iss", mutation: { claims: { iss } }, violation: "delegation.iss" })),
    gs.sampledFrom(["iat", "exp"]).map((field) => ({ name: `no ${field}`, mutation: { claims: { [field]: undefined } }, violation: "delegation.lifetime" })),
    gs.integers({ minValue: 24 * 3600 + 1, maxValue: 10_000_000 }).map((span) => ({ name: "longer than a day", mutation: { claims: { iat: hour, exp: hour + span } }, violation: "delegation.lifetime" })),
    // Expired beyond the skew the Company allows, however long it lasted.
    gs.tuples(gs.integers({ minValue: 31, maxValue: 10_000_000 }), gs.integers({ minValue: 1, maxValue: 24 * 3600 }))
      .map(([ago, span]) => ({ name: "expired", mutation: { claims: { iat: seconds() - ago - span, exp: seconds() - ago } }, violation: "delegation.expired" })),
    gs.oneOf<unknown>(gs.just(undefined), gs.integers(), gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789-_", maxSize: 21 })).map((jti) => ({ name: "jti", mutation: { claims: { jti } }, violation: "delegation.jti" })),
    gs.oneOf<unknown>(gs.just(undefined), gs.just({}), gs.just({ jwk: "not a key" })).map((cnf) => ({ name: "cnf", mutation: { claims: { cnf } }, violation: "delegation.cnf" })),
    gs.just({ name: "private key", mutation: { claims: { cnf: "private" } }, violation: "delegation.private-key" }),
    // 5.2: nothing about the User or the Company, so a claim of any other name.
    gs.tuples(gs.oneOf(gs.sampledFrom(["sub", "aud", "agent_id", "sid", "user_id", "issuer"]), gs.text({ minSize: 1, maxSize: 12 })), jsonLeaf)
      .filter(([name]) => !["iss", "cnf", "iat", "exp", "jti", "nbf"].includes(name))
      .map(([name, value]) => ({ name: `claim ${name}`, mutation: { claims: { [name]: value } }, violation: "delegation.names-user" }))
  );
}

/** A JSON value with no structure, for a claim a delegation mustn't have. */
const jsonLeaf = gs.oneOf<unknown>(gs.just(null), gs.booleans(), gs.integers(), gs.text({ maxSize: 20 }));

/** Build a JWT from a baseline header and claims with one thing changed; `hash:` in `ath` becomes that text's hash. */
async function mutated(header: Header, claims: Claims, key: CryptoKey | Uint8Array, mutation: Mutation): Promise<string> {
  if (mutation.raw !== undefined) return mutation.raw;
  const merged = { ...claims, ...mutation.claims };
  if (typeof merged.ath === "string" && merged.ath.startsWith("hash:")) merged.ath = await sha256(merged.ath.slice(5));
  return sign({ ...header, ...mutation.header }, merged, mutation.key ?? key, mutation.signature);
}

describe("the mock Company refuses each thing wrong with a Session JWT or its delegation, naming it", () => {
  it(
    "a Session JWT with one thing wrong",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const delegated = await delegate(signing, identity.clientId, await newDpopKey());
      const method = tc.draw(methods);
      const url = tc.draw(resourceUrl(company));
      const token = tc.draw(gs.optional(gs.fromRegex("[A-Za-z0-9._~+/-]{1,60}", { fullmatch: true }))) ?? undefined;
      const wrong = tc.draw(sessionMutations(company, delegated, method, url, token));
      tc.note(wrong.name);
      const claims: Claims = { iss: identity.clientId, aud: company.hosts.issuer, sid: randomId(), sub: randomId("usr_"), htm: method, htu: htu(url), iat: seconds(), jti: jtis(), ...(token !== undefined ? { ath: await sha256(token) } : {}) };
      const header: Header = { typ: "poppy-session+jwt", alg: "ES256", kid: delegated.key.thumbprint, pap_dlg: delegated.delegation };
      const headers: Record<string, string> = "header" in wrong.mutation && wrong.mutation.header === "missing" ? {} : { "Poppy-Session": await mutated(header, claims, delegated.key.privateKey, wrong.mutation as Mutation) };
      const result = await attempt(() => company.verifySessionHeader(inbound(method, url, headers), token ?? null));
      expect(result.ok ? result : result.error).toEqual(wrong.recordedOnly ? expect.objectContaining({ ok: true }) : "invalid_session");
      expect(company.recorded.map(violationId)).toEqual([wrong.violation]);
    })
  );

  it(
    "a Session JWT whose delegation has one thing wrong",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const key = await newDpopKey();
      const privateJwk = await exportJWK((await generateKeyPair("ES256", { extractable: true })).privateKey);
      const wrong = tc.draw(delegationMutations());
      tc.note(wrong.name);
      const hour = Math.floor(seconds() / 3600) * 3600;
      const claims: Claims = { iss: identity.clientId, cnf: { jwk: key.publicJwk }, iat: hour, exp: hour + 4 * 3600, jti: jtis() };
      const mutation: Mutation = wrong.mutation.claims?.cnf === "private" ? { claims: { cnf: { jwk: privateJwk } } } : wrong.mutation;
      const delegation = await mutated({ alg: "ES256", typ: "pap-delegation+jwt", kid: signing.kid }, claims, signing.privateKey, mutation);
      const method = tc.draw(methods);
      const url = tc.draw(resourceUrl(company));
      const jwt = await sessionHeaderFor({ key, delegation, expiresAt: hour + 4 * 3600 }, company, method, url);
      expect(await attempt(() => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": jwt }), null))).toEqual({ ok: false, error: "invalid_session" });
      expect(company.recorded.map(violationId)).toEqual([wrong.violation]);
    })
  );

  it(
    "a Session JWT used twice",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const method = tc.draw(methods);
      const url = tc.draw(resourceUrl(company));
      const jwt = await sessionHeaderFor(await delegate(signing, identity.clientId, await newDpopKey()), company, method, url);
      expect((await attempt(() => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": jwt }), null))).ok).toBe(true);
      expect(await attempt(() => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": jwt }), null))).toEqual({ ok: false, error: "invalid_session" });
      expect(company.recorded.map(violationId)).toEqual(["session-jwt.jti-reused"]);
    })
  );

  it(
    "a Session's sid sent again with another User ID",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const sid = randomId();
      const send = async (userId: string) => {
        const method = tc.draw(methods);
        const url = tc.draw(resourceUrl(company));
        // A delegated key per User ID, as our client keeps them, so only the Session's sid is shared.
        const jwt = await sessionJwt(await delegate(signing, identity.clientId, await newDpopKey()), { clientId: identity.clientId, issuer: company.hosts.issuer, sid, userId, method, url });
        return attempt(() => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": jwt }), null));
      };
      expect((await send(randomId("usr_"))).ok).toBe(true);
      expect(await send(randomId("usr_"))).toEqual({ ok: false, error: "invalid_session" });
      expect(company.recorded.map(violationId)).toEqual(["session-jwt.sub-changed"]);
    })
  );

  it(
    "a delegated key that signs for a second User ID",
    propertyAsync(async (tc) => {
      const company = await companyWith(tc.draw(readings));
      const delegated = await delegate(signing, identity.clientId, await newDpopKey());
      for (const userId of [randomId("usr_"), randomId("usr_")]) {
        const method = tc.draw(methods);
        const url = tc.draw(resourceUrl(company));
        // Recorded, not refused: each request alone is a valid Session JWT.
        expect((await attempt(async () => company.verifySessionHeader(inbound(method, url, { "Poppy-Session": await sessionHeaderFor(delegated, company, method, url, userId) }), null))).ok).toBe(true);
      }
      expect(company.recorded.map(violationId)).toEqual(["delegation.key-shared"]);
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
    ...algMutations(["ES256", "RS256"], (name, mutation) => ({ name, mutation, violation: "dpop.alg" as string | null })),
    gs.just({ name: "no jwk", mutation: { header: { jwk: undefined } }, violation: "dpop.no-jwk" }),
    gs.just({ name: "private jwk", mutation: { header: { jwk: "private" } }, violation: "dpop.private-jwk" }),
    gs.just({ name: "another key", mutation: { key: strangerKey }, violation: "dpop.signature" }),
    methods.filter((other) => other !== method).map((htm) => ({ name: "htm", mutation: { claims: { htm } }, violation: "dpop.htm" })),
    gs.oneOf(gs.just(url), gs.just(`${url.split(/[?#]/)[0]}?q=1`), gs.urls()).filter((htu) => htu !== `${new URL(url).origin}${new URL(url).pathname}`).map((htu) => ({ name: "htu", mutation: { claims: { htu } }, violation: "dpop.htu" })),
    gs.integers({ minValue: 91, maxValue: 10_000_000 }).flatMap((off) => gs.sampledFrom([off, -off])).map((offset) => ({ name: "iat", mutation: { claims: { iat: seconds() + offset } }, violation: "dpop.iat" })),
    // At the token endpoint there is no token, so no ath to get wrong (RFC 9449 4.3).
    ...(atTokenEndpoint
      ? []
      : [gs.oneOf<{ name: string; mutation: Mutation; violation: string }>(
          gs.just({ name: "no ath", mutation: { claims: { ath: undefined } }, violation: "dpop.ath" }),
          gs.text({ minSize: 1, maxSize: 60 }).filter((other) => other !== token).map((other) => ({ name: "ath of another token", mutation: { claims: { ath: `hash:${other}` } }, violation: "dpop.ath" }))
        )]),
    // Header values can't hold control characters and lose surrounding spaces, so the junk is visible ASCII.
    gs.text({ alphabet: VISIBLE.replace(/[.,]/g, ""), minSize: 1, maxSize: 30 }).map((raw) => ({ name: "not a JWT", mutation: { raw }, violation: "dpop.not-jwt" }))
  );
}

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
      expect(result.ok, name).toBe(false);
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
