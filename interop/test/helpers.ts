/** Recordings for the checker's tests: HAR entries built by hand, and unsigned JWTs. */
import { createHash } from "node:crypto";
import { exchanges, type Exchange, type Har, type HarEntry } from "../runner/har.ts";

export type Spec = {
  method?: string;
  url: string;
  at?: number;
  time?: number;
  headers?: Record<string, string>;
  form?: Record<string, string>;
  body?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  response?: unknown;
  /** Mark the exchange as one the fault-injection proxy created (spec §6). */
  injected?: boolean;
};

const T0 = Date.parse("2026-10-11T12:00:00Z");
export const NOW = Math.floor(T0 / 1000);

export function entry(spec: Spec): HarEntry {
  const headers = { ...(spec.headers ?? {}) };
  let body = spec.body;
  if (spec.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(spec.form).toString();
  }
  const response = typeof spec.response === "string" ? spec.response : spec.response === undefined ? "" : JSON.stringify(spec.response);
  const responseHeaders = { ...(typeof spec.response === "object" ? { "content-type": "application/json" } : {}), ...(spec.responseHeaders ?? {}) };
  return {
    startedDateTime: new Date(T0 + (spec.at ?? 0)).toISOString(),
    time: spec.time ?? 10,
    request: {
      method: spec.method ?? (body ? "POST" : "GET"),
      url: spec.url,
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      ...(body ? { postData: { mimeType: headers["content-type"] ?? "", text: body } } : {})
    },
    response: {
      status: spec.status ?? 200,
      headers: Object.entries(responseHeaders).map(([name, value]) => ({ name, value })),
      content: { mimeType: responseHeaders["content-type"] ?? "", text: response }
    },
    ...(spec.injected ? { _interop: { injected: true } } : {})
  };
}

export function recording(...specs: Spec[]): Exchange[] {
  const har: Har = { log: { entries: specs.map(entry) } };
  return exchanges(har);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An unsigned compact JWS: the checks read headers and claims, never signatures. */
export function jwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${b64(header)}.${b64(payload)}.c2ln`;
}

let counter = 0;
export const jti = () => `jti-${String(++counter).padStart(22, "0")}`;

export const CLIENT_ID = "https://pda.agent.interop.test/poppy/client.json";
export const TOKEN = "https://auth.acme.company.interop.test/oauth/token";
export const API = "https://api.acme.company.interop.test";

export function clientAssertion(overrides: { header?: Record<string, unknown>; payload?: Record<string, unknown> } = {}): string {
  return jwt(
    { alg: "ES256", kid: "k1", typ: "JWT", ...overrides.header },
    { iss: CLIENT_ID, sub: CLIENT_ID, aud: TOKEN, iat: NOW, exp: NOW + 60, jti: jti(), ...overrides.payload }
  );
}

export function proof(method: string, url: string, overrides: { header?: Record<string, unknown>; payload?: Record<string, unknown>; token?: string } = {}): string {
  return jwt(
    { alg: "ES256", typ: "dpop+jwt", jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, ...overrides.header },
    {
      htm: method,
      htu: url,
      iat: NOW,
      jti: jti(),
      ...(overrides.token ? { ath: createHash("sha256").update(overrides.token).digest("base64url") } : {}),
      ...overrides.payload
    }
  );
}

/** A signed-out Session start, as our agent sends it. */
export function sessionStart(at = 0, overrides: { client?: string; assertion?: string } = {}): Spec {
  return {
    url: TOKEN,
    at,
    headers: { dpop: proof("POST", TOKEN) },
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:
        overrides.assertion ??
        jwt({ alg: "ES256", kid: "k1", typ: "JWT" }, { iss: CLIENT_ID, sub: "usr_1", aud: TOKEN, iat: NOW, exp: NOW + 60, jti: jti() }),
      client_id: CLIENT_ID,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: overrides.client ?? clientAssertion()
    },
    response: { access_token: "at_session_token_1", token_type: "DPoP", expires_in: 3600, session_id: "ses_1", signed_in: false },
    responseHeaders: { "cache-control": "no-store" }
  };
}
