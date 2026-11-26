/**
 * Readings (spec section 7): each side's answer to an open question in the
 * draft. The runner checks an agent's declared readings against what it
 * sent, and attribution rule 3 asks whether two declared readings can work
 * together. Pure functions.
 */
import { departure, ours, render, show, shown, type Problem, type Shown } from "../../src/diagnostic.ts";
import { decodeJwt, form, isServerMetadata, jsonBody, type DecodedJwt, type Exchange } from "./har.ts";
import type { Check } from "./types.ts";

export const QUESTIONS = {
  S1: { question: "Client assertion aud", values: ["issuer", "token-endpoint", "endpoint", "either"] },
  S2: { question: "Assertion typ and lifetime", values: ["jwt-60s", "jwt-300s", "lenient-120s", "lenient-300s", "any"] },
  S3: { question: "Metadata location for an issuer with a path", values: ["insertion", "append", "either"] },
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
  "client-assertion.aud": "S1"
};

/** The section 7 question a check's id belongs to, if any. */
export function questionOf(checkId: string): QuestionId | undefined {
  return CHECK_QUESTIONS[checkId];
}

/**
 * S2 readings by assertion type and maximum lifetime. An agent states what
 * it sends; a Company states what it accepts. `jwt-60s`: `typ: "JWT"` and at most 60 s.
 * `jwt-300s`: `typ: "JWT"` and at most 300 s. `lenient-120s`: any `typ`,
 * at most 120 s. `lenient-300s`: any `typ`, at most 300 s. `any`: no limit stated.
 */
const S2_LIMITS: Record<string, { jwt: boolean; seconds: number }> = {
  "jwt-60s": { jwt: true, seconds: 60 },
  "jwt-300s": { jwt: true, seconds: 300 },
  "lenient-120s": { jwt: false, seconds: 120 },
  "lenient-300s": { jwt: false, seconds: 300 },
  any: { jwt: false, seconds: Infinity }
};

/**
 * Can an agent with one reading work with a Company with another? An agent
 * states what it sends; a Company what it accepts or does. "either" and
 * "any" on the accepting side accept everything.
 */
export function compatible(question: string, agent: string | undefined, company: string | undefined): boolean {
  if (!agent || !company) return true;
  switch (question) {
    case "S2": {
      // Both restrictions must fit: jwt-300s and lenient-120s are incomparable.
      const sent = S2_LIMITS[agent], accepted = S2_LIMITS[company];
      return !sent || !accepted || (sent.seconds <= accepted.seconds && (!accepted.jwt || sent.jwt));
    }
    case "S23":
      // An agent that keeps a nonce per origin copes with one per Company; not the converse.
      return !(company === "per-origin" && agent === "per-company");
    default:
      return agent === company || agent === "either" || company === "either";
  }
}

function warning(id: QuestionId, x: Exchange, detail: Problem): Check {
  return { id: `reading.${id}`, side: "agent", severity: "warning", basis: "Reading", exchange: x.index, detail: render(detail), source: "trace" };
}

/** A recorded string shown quoted, as written; anything else by its kind. */
const quoted = (value: unknown): Shown => (typeof value === "string" ? show.text(value, 200) : show.kind(value));

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
 * 60 s. `jwt-300s`: no `typ: "JWT"`, or over 300 s. `lenient-120s`:
 * a lifetime over 120 s. `lenient-300s`: a lifetime over 300 s.
 */
function assertionFault(reading: string | undefined, jwt: DecodedJwt): Shown | null {
  const lifetime = Number(jwt.payload.exp) - Number(jwt.payload.iat);
  if (reading === "jwt-60s" || reading === "jwt-300s") {
    return jwt.header.typ !== "JWT" || !(lifetime <= S2_LIMITS[reading]!.seconds) ? shown`${jwt.header.typ === undefined ? ours("no typ") : shown`typ ${show.value(jwt.header.typ)}`} and a ${lifetime} s lifetime` : null;
  }
  const limit = reading === "lenient-120s" ? 120 : reading === "lenient-300s" ? 300 : null;
  if (limit !== null) return !(lifetime <= limit) ? shown`a ${lifetime} s lifetime` : null;
  return null;
}

/** The client assertion an OAuth request carries, as a list. */
function assertionsOf(fields: URLSearchParams): DecodedJwt[] {
  const client = decodeJwt(fields.get("client_assertion") ?? "");
  return client ? [client] : [];
}

/**
 * The agent's declared readings against its OAuth requests (S1, S2).
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
      found.push(warning("S1", x, departure(shown`the client assertion's aud at ${show.url(called)}`, shown`what the agent's declared S1 reading, ${show.name(readings.S1!)}, wants there: ${quoted(want)}`, quoted(client.payload.aud))));
    }
    if (!fields.has("grant_type")) continue;
    for (const decoded of assertionsOf(fields)) {
      const fault = assertionFault(readings.S2, decoded);
      if (fault) found.push(warning("S2", x, departure(ours("the client assertion"), shown`what the agent's declared S2 reading, ${show.name(readings.S2!)}, accepts`, fault)));
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
  const refused = (id: QuestionId, x: Exchange, detail: Problem): Check => ({
    id: `reading.${id}.refused`,
    side: "agent",
    severity: "warning",
    basis: "Reading",
    exchange: x.index,
    detail: render(detail),
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
      found.push(refused("S1", x, departure(shown`the client assertion's aud, refused with ${show.code(error)} at ${show.url(called)}`, shown`what the Company's S1 reading, ${show.name(s1!)}, wants there: ${quoted(want)}`, quoted(client.payload.aud))));
    }
    const s2 = companyReadings.S2;
    const faults = assertionsOf(fields)
      .map((jwt) => assertionFault(s2, jwt))
      .filter((fault): fault is Shown => fault !== null);
    if (faults.length > 0) {
      found.push(refused("S2", x, departure(shown`the client assertion, refused with ${show.code(error)} at ${show.url(called)}`, shown`what the Company's S2 reading, ${show.name(s2 ?? "")}, accepts`, shown`one with ${faults[0]!}`)));
    }
  }
  return found;
}
