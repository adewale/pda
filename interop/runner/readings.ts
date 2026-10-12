/**
 * Readings (spec section 7): each side's answer to an open question in the
 * draft. The runner checks an agent's declared readings against what it
 * sent, and attribution rule 3 asks whether two declared readings can work
 * together. Pure functions.
 */
import { decodeJwt, form, isServerMetadata, jsonBody, type DecodedJwt, type Exchange } from "./har.ts";
import type { Check } from "./types.ts";

export const QUESTIONS = {
  S1: { question: "Client assertion aud", values: ["issuer", "token-endpoint", "endpoint", "either"] },
  S2: { question: "Assertion typ and lifetime", values: ["jwt-60s", "lenient-120s", "lenient-300s", "any"] },
  S3: { question: "Metadata location for an issuer with a path", values: ["insertion", "append", "either"] },
  S4: { question: "scope on a signed-out Session request", values: ["omit", "poppy-read", "either"] },
  S23: { question: "DPoP nonce scope", values: ["per-origin", "per-company"] }
} as const;

export type QuestionId = keyof typeof QUESTIONS;

/**
 * Checks (trace or Company-recorded, by the mock's violation ids) that test
 * nothing but one reading: a strict Company's refusal of a typ-less or
 * long-lived assertion is S2; of a client assertion's aud, S1.
 */
const CHECK_QUESTIONS: Readonly<Record<string, QuestionId>> = {
  "client-assertion.typ": "S2",
  "client-assertion.kid": "S2",
  "client-assertion.lifetime": "S2",
  "session-assertion.typ": "S2",
  "session-assertion.kid": "S2",
  "session-assertion.lifetime": "S2",
  "client-assertion.aud": "S1"
};

/** The section 7 question a check's id belongs to, if any. */
export function questionOf(checkId: string): QuestionId | undefined {
  return CHECK_QUESTIONS[checkId];
}

/**
 * S2 readings from narrowest to widest. An agent's says what it sends; a
 * Company's what it accepts. `jwt-60s`: `typ: "JWT"` and at most 60 s.
 * `lenient-120s`: any `typ`, at most 120 s. `lenient-300s`: any `typ`, at
 * most 300 s. `any`: no limit stated.
 */
const S2_ORDER = ["jwt-60s", "lenient-120s", "lenient-300s", "any"] as const;

/**
 * Can an agent with one reading work with a Company with another? An agent
 * states what it sends; a Company what it accepts or does. "either" and
 * "any" on the accepting side accept everything.
 */
export function compatible(question: string, agent: string | undefined, company: string | undefined): boolean {
  if (!agent || !company) return true;
  switch (question) {
    case "S2": {
      // A Company accepts every agent reading at least as narrow as its own:
      // `jwt-60s` only `jwt-60s`; `lenient-120s` also itself; `lenient-300s`
      // also both lenient readings, but not `any`, which may live past 300 s;
      // `any` everything.
      const sent = S2_ORDER.indexOf(agent as (typeof S2_ORDER)[number]);
      const accepted = S2_ORDER.indexOf(company as (typeof S2_ORDER)[number]);
      return sent < 0 || accepted < 0 || sent <= accepted;
    }
    case "S23":
      // An agent that keeps a nonce per origin copes with one per Company; not the converse.
      return !(company === "per-origin" && agent === "per-company");
    default:
      return agent === company || agent === "either" || company === "either";
  }
}

function warning(id: QuestionId, x: Exchange, detail: string): Check {
  return { id: `reading.${id}`, side: "agent", severity: "warning", basis: "Reading", exchange: x.index, detail, source: "trace" };
}

/** The OAuth endpoints a client assertion goes to, in a Company's server metadata (RFC 8414). */
const ASSERTION_ENDPOINTS = ["token_endpoint", "device_authorization_endpoint", "revocation_endpoint", "pushed_authorization_request_endpoint"] as const;

type AssertionEndpoint = { readonly issuer: string; readonly token: string };

/** Each endpoint a Company's server metadata names that a client assertion goes to, with its issuer and token endpoint. */
function assertionEndpoints(all: readonly Exchange[]): Map<string, AssertionEndpoint> {
  const endpoints = new Map<string, AssertionEndpoint>();
  for (const x of all) {
    if (x.direction !== "to-company" || !isServerMetadata(x)) continue;
    const metadata = jsonBody(x.responseBody) as Record<string, unknown> | undefined;
    if (typeof metadata?.issuer !== "string" || typeof metadata.token_endpoint !== "string") continue;
    for (const name of ASSERTION_ENDPOINTS) {
      const value = metadata[name];
      if (typeof value === "string") endpoints.set(value, { issuer: metadata.issuer, token: metadata.token_endpoint });
    }
  }
  return endpoints;
}

/** The client assertion `aud` an S1 reading wants at the endpoint called; null for `either`. */
function wantedAud(reading: string, endpoint: AssertionEndpoint, called: string): string | null {
  if (reading === "issuer") return endpoint.issuer;
  if (reading === "endpoint") return called;
  if (reading === "token-endpoint") return endpoint.token;
  return null;
}

/**
 * What an S2 reading refuses in an assertion; null when it is accepted, or
 * the reading sets no limit. `jwt-60s`: no `typ: "JWT"`, or a lifetime over
 * 60 s. `lenient-120s`: a lifetime over 120 s. `lenient-300s`: a lifetime
 * over 300 s.
 */
function assertionFault(reading: string | undefined, jwt: DecodedJwt): string | null {
  const lifetime = Number(jwt.payload.exp) - Number(jwt.payload.iat);
  if (reading === "jwt-60s") {
    return jwt.header.typ !== "JWT" || !(lifetime <= 60) ? `typ ${JSON.stringify(jwt.header.typ)} and a ${lifetime} s lifetime` : null;
  }
  const limit = reading === "lenient-120s" ? 120 : reading === "lenient-300s" ? 300 : null;
  if (limit !== null) return !(lifetime <= limit) ? `a ${lifetime} s lifetime` : null;
  return null;
}

/** The assertions an OAuth request carries: the client assertion and, on the jwt-bearer grant, the Session assertion. */
function assertionsOf(fields: URLSearchParams): DecodedJwt[] {
  return [fields.get("client_assertion"), fields.get("assertion")]
    .map((jwt) => decodeJwt(jwt ?? ""))
    .filter((jwt): jwt is DecodedJwt => jwt !== null);
}

/**
 * The agent's declared readings against its OAuth requests (S1, S2, S4).
 * S1 is checked wherever a client assertion goes: `issuer` wants the
 * issuer as `aud`, `token-endpoint` the token endpoint even at the device
 * and revocation endpoints, `endpoint` the endpoint the assertion is sent to.
 */
export function readingChecks(all: readonly Exchange[], readings: Readonly<Record<string, string>>): Check[] {
  const found: Check[] = [];
  const endpoints = assertionEndpoints(all);
  for (const x of all) {
    if (x.direction !== "to-company" || x.probe) continue;
    const fields = form(x);
    if (!fields) continue;
    const called = `${x.url.origin}${x.url.pathname}`;
    const endpoint = endpoints.get(called);
    const client = decodeJwt(fields.get("client_assertion") ?? "");
    const want = client && endpoint && readings.S1 ? wantedAud(readings.S1, endpoint, called) : null;
    if (client && want !== null && client.payload.aud !== want) {
      found.push(warning("S1", x, `declared ${readings.S1}, sent aud ${JSON.stringify(client.payload.aud)} to ${called}`));
    }
    if (!fields.has("grant_type")) continue;
    for (const decoded of assertionsOf(fields)) {
      const fault = assertionFault(readings.S2, decoded);
      if (fault) found.push(warning("S2", x, `declared ${readings.S2}, sent ${fault}`));
    }
    if (fields.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && readings.S4 && readings.S4 !== "either") {
      const scope = fields.get("scope");
      const ok = readings.S4 === "omit" ? scope === null : scope === "poppy:read";
      if (!ok) found.push(warning("S4", x, `declared ${readings.S4}, sent scope ${JSON.stringify(scope)}`));
    }
  }
  return found;
}

/** The OAuth errors a Company refuses an assertion with. */
const ASSERTION_REFUSALS = new Set(["invalid_client", "invalid_grant"]);

/** The id of a refusal check: `reading.<question>.refused`. */
export const REFUSED_READING = /^reading\.(S\d+)\.refused$/;

/**
 * Refusals a Company's own declared readings explain (S1, S2): an OAuth
 * request answered `invalid_client` or `invalid_grant` that carried an
 * assertion the Company's reading doesn't accept: a client assertion `aud`
 * other than the one its S1 reading wants at that endpoint, or, for S2
 * `jwt-60s`, an assertion without `typ: "JWT"` or living over 60 s, and
 * for `lenient-120s` and `lenient-300s`, one living over 120 or 300 s.
 * Attribution reads them as evidence that the cell failed on that question
 * (rule 3). They are warnings and judge neither side.
 */
export function refusedReadingChecks(all: readonly Exchange[], companyReadings: Readonly<Record<string, string>>): Check[] {
  const found: Check[] = [];
  const endpoints = assertionEndpoints(all);
  const refused = (id: QuestionId, x: Exchange, detail: string): Check => ({
    id: `reading.${id}.refused`,
    side: "agent",
    severity: "warning",
    basis: "Reading",
    exchange: x.index,
    detail,
    source: "trace"
  });
  for (const x of all) {
    if (x.direction !== "to-company" || x.probe || (x.status !== 400 && x.status !== 401)) continue;
    const error = (jsonBody(x.responseBody) as { error?: unknown } | undefined)?.error;
    if (typeof error !== "string" || !ASSERTION_REFUSALS.has(error)) continue;
    const fields = form(x);
    if (!fields) continue;
    const called = `${x.url.origin}${x.url.pathname}`;
    const endpoint = endpoints.get(called);
    const client = decodeJwt(fields.get("client_assertion") ?? "");
    const s1 = companyReadings.S1;
    const want = client && endpoint && s1 ? wantedAud(s1, endpoint, called) : null;
    if (client && want !== null && client.payload.aud !== want) {
      found.push(refused("S1", x, `${error} at ${called}: aud ${JSON.stringify(client.payload.aud)}; the Company's S1 reading (${s1}) wants ${JSON.stringify(want)}`));
    }
    const s2 = companyReadings.S2;
    const faults = assertionsOf(fields)
      .map((jwt) => assertionFault(s2, jwt))
      .filter((fault): fault is string => fault !== null);
    if (faults.length > 0) found.push(refused("S2", x, `${error} at ${called}: an assertion with ${faults[0]}, which the Company's S2 reading (${s2}) refuses`));
  }
  return found;
}
