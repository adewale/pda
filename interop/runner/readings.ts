/**
 * Readings (spec section 7): each side's answer to an open question in the
 * draft. The runner checks an agent's declared readings against what it
 * sent, and attribution rule 3 asks whether two declared readings can work
 * together. Pure functions.
 */
import { decodeJwt, form, jsonBody, type Exchange } from "./har.ts";
import type { Check } from "./types.ts";

export const QUESTIONS = {
  S1: { question: "Client assertion aud", values: ["issuer", "token-endpoint", "endpoint", "either"] },
  S2: { question: "Assertion typ and lifetime", values: ["jwt-60s", "any"] },
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
 * Can an agent with one reading work with a Company with another? An agent
 * states what it sends; a Company what it accepts or does. "either" and
 * "any" on the accepting side accept everything.
 */
export function compatible(question: string, agent: string | undefined, company: string | undefined): boolean {
  if (!agent || !company) return true;
  switch (question) {
    case "S2":
      // A strict Company needs typ JWT and 60 s; an agent that sends "any" may not.
      return !(company === "jwt-60s" && agent === "any");
    case "S23":
      // An agent that keeps a nonce per origin copes with one per Company; not the converse.
      return !(company === "per-origin" && agent === "per-company");
    default:
      return agent === company || agent === "either" || company === "either";
  }
}

function warning(id: QuestionId, x: Exchange, detail: string): Check {
  return { id: `reading.${id}`, side: "agent", severity: "warning", exchange: x.index, detail, source: "trace" };
}

/** The OAuth endpoints a client assertion goes to, in a Company's server metadata (RFC 8414). */
const ASSERTION_ENDPOINTS = ["token_endpoint", "device_authorization_endpoint", "revocation_endpoint", "pushed_authorization_request_endpoint"] as const;

/**
 * The agent's declared readings against its OAuth requests (S1, S2, S4).
 * S1 is checked wherever a client assertion goes: `issuer` wants the
 * issuer as `aud`, `token-endpoint` the token endpoint even at the device
 * and revocation endpoints, `endpoint` the endpoint the assertion is sent to.
 */
export function readingChecks(all: readonly Exchange[], readings: Readonly<Record<string, string>>): Check[] {
  const found: Check[] = [];
  /** Each endpoint a Company's metadata names, with its issuer and token endpoint. */
  const endpoints = new Map<string, { issuer: string; token: string }>();
  for (const x of all) {
    if (x.direction !== "to-company" || !x.url.pathname.startsWith("/.well-known/oauth-authorization-server")) continue;
    const metadata = jsonBody(x.responseBody) as Record<string, unknown> | undefined;
    if (typeof metadata?.issuer !== "string" || typeof metadata.token_endpoint !== "string") continue;
    for (const name of ASSERTION_ENDPOINTS) {
      const value = metadata[name];
      if (typeof value === "string") endpoints.set(value, { issuer: metadata.issuer, token: metadata.token_endpoint });
    }
  }
  for (const x of all) {
    if (x.direction !== "to-company" || x.probe) continue;
    const fields = form(x);
    if (!fields) continue;
    const called = `${x.url.origin}${x.url.pathname}`;
    const endpoint = endpoints.get(called);
    const client = decodeJwt(fields.get("client_assertion") ?? "");
    if (client && endpoint && readings.S1 && readings.S1 !== "either") {
      const want = readings.S1 === "issuer" ? endpoint.issuer : readings.S1 === "endpoint" ? called : endpoint.token;
      if (client.payload.aud !== want) found.push(warning("S1", x, `declared ${readings.S1}, sent aud ${JSON.stringify(client.payload.aud)} to ${called}`));
    }
    if (!fields.has("grant_type")) continue;
    if (readings.S2 === "jwt-60s") {
      for (const jwt of [fields.get("client_assertion"), fields.get("assertion")]) {
        const decoded = decodeJwt(jwt ?? "");
        if (!decoded) continue;
        const lifetime = Number(decoded.payload.exp) - Number(decoded.payload.iat);
        if (decoded.header.typ !== "JWT" || !(lifetime <= 60)) {
          found.push(warning("S2", x, `declared jwt-60s, sent typ ${JSON.stringify(decoded.header.typ)} and a ${lifetime} s lifetime`));
        }
      }
    }
    if (fields.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && readings.S4 && readings.S4 !== "either") {
      const scope = fields.get("scope");
      const ok = readings.S4 === "omit" ? scope === null : scope === "poppy:read";
      if (!ok) found.push(warning("S4", x, `declared ${readings.S4}, sent scope ${JSON.stringify(scope)}`));
    }
  }
  return found;
}
