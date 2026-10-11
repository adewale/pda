/**
 * Checks on the recording (spec section 8), independent of either side's
 * opinion. Pure functions over a cell's exchanges. Each check is named with
 * the mock Company's violation id (test/mock-company/violations.ts) where one
 * fits; Company-side checks are prefixed `company.`.
 *
 * Severity follows the draft: a MUST broken is an error; behaviour the draft
 * leaves open but strict Companies enforce (S2: assertion `typ` and a 60 s
 * lifetime) is a warning, so a lenient pair isn't failed for it.
 */
import { createHash } from "node:crypto";
import { authorization, decodeJwt, form, jsonBody, type Exchange } from "./har.ts";
import type { Check, Severity, Side } from "./types.ts";

export type CheckSpec = {
  readonly side: Side;
  readonly severity: Severity;
  /** The id is one of the mock Company's violation ids. */
  readonly mock: boolean;
  readonly what: string;
};

export const TRACE_CHECKS = {
  "client-assertion.typ": { side: "agent", severity: "warning", mock: true, what: "Client assertion header typ isn't \"JWT\" (S2)" },
  "client-assertion.kid": { side: "agent", severity: "warning", mock: true, what: "Client assertion has no kid (S2)" },
  "client-assertion.alg": { side: "agent", severity: "error", mock: true, what: "Client assertion alg isn't ES256 or RS256" },
  "client-assertion.iat-exp-missing": { side: "agent", severity: "error", mock: true, what: "Client assertion without iat or exp" },
  "client-assertion.lifetime": { side: "agent", severity: "error", mock: true, what: "Client assertion lifetime over 300 seconds (warning over 60, S2)" },
  "client-assertion.jti-missing": { side: "agent", severity: "error", mock: true, what: "Client assertion without a jti" },
  "client-assertion.jti-reused": { side: "agent", severity: "error", mock: true, what: "Client assertion jti used twice" },
  "client-assertion.aud-array": { side: "agent", severity: "error", mock: true, what: "Client assertion aud is an array" },
  "client-assertion.iss-sub": { side: "agent", severity: "error", mock: true, what: "Client assertion iss and sub aren't both the client_id" },
  "client-assertion.not-jwt": { side: "agent", severity: "error", mock: true, what: "Client assertion is not a JWT" },
  "session-assertion.typ": { side: "agent", severity: "warning", mock: true, what: "Session assertion header typ isn't \"JWT\" (S2)" },
  "session-assertion.kid": { side: "agent", severity: "warning", mock: true, what: "Session assertion has no kid (S2)" },
  "session-assertion.alg": { side: "agent", severity: "error", mock: true, what: "Session assertion alg isn't ES256 or RS256" },
  "session-assertion.iat-exp-missing": { side: "agent", severity: "error", mock: true, what: "Session assertion without iat or exp" },
  "session-assertion.lifetime": { side: "agent", severity: "error", mock: true, what: "Session assertion lifetime over 300 seconds (warning over 60, S2)" },
  "session-assertion.jti-missing": { side: "agent", severity: "error", mock: true, what: "Session assertion without a jti" },
  "session-assertion.jti-reused": { side: "agent", severity: "error", mock: true, what: "Session assertion jti used twice" },
  "session-assertion.aud": { side: "agent", severity: "error", mock: true, what: "Session assertion aud isn't the token endpoint as a single string" },
  "session-assertion.iss": { side: "agent", severity: "error", mock: true, what: "Session assertion iss isn't the client_id" },
  "session-assertion.not-jwt": { side: "agent", severity: "error", mock: true, what: "Session assertion is not a JWT" },
  "dpop.not-jwt": { side: "agent", severity: "error", mock: true, what: "DPoP proof is not a JWT" },
  "dpop.typ": { side: "agent", severity: "error", mock: true, what: "DPoP proof typ isn't dpop+jwt" },
  "dpop.no-jwk": { side: "agent", severity: "error", mock: true, what: "DPoP proof has no jwk in its header" },
  "dpop.htm": { side: "agent", severity: "error", mock: true, what: "DPoP proof htm isn't the request method" },
  "dpop.htu": { side: "agent", severity: "error", mock: true, what: "DPoP proof htu isn't the request URL without query or fragment" },
  "dpop.iat": { side: "agent", severity: "error", mock: true, what: "DPoP proof iat is outside the acceptance window" },
  "dpop.jti-missing": { side: "agent", severity: "error", mock: true, what: "DPoP proof without a jti" },
  "dpop.jti-reused": { side: "agent", severity: "error", mock: true, what: "DPoP proof jti used twice" },
  "dpop.ath": { side: "agent", severity: "error", mock: true, what: "DPoP proof ath isn't the hash of the token sent" },
  "dpop.ath-at-token-endpoint": { side: "agent", severity: "error", mock: true, what: "DPoP proof at the token endpoint carries ath" },
  "secret.token-in-url": { side: "agent", severity: "error", mock: true, what: "A token sent in a URL" },
  "rate-limit.retry-after-ignored": { side: "agent", severity: "error", mock: true, what: "Request sent before an earlier Retry-After elapsed" },
  "token.unlisted-host": { side: "agent", severity: "error", mock: false, what: "A Session Token sent to a host the Company's documents don't list" },
  "redirect.credentials-followed": { side: "agent", severity: "error", mock: false, what: "A redirect followed with the token or proof of the request that got it" },
  "company.www-authenticate": { side: "company", severity: "error", mock: false, what: "401 to a request with a token, without WWW-Authenticate (RFC 6750, RFC 9449)" },
  "company.retry-after": { side: "company", severity: "warning", mock: false, what: "429 without Retry-After" },
  "company.oauth-error-body": { side: "company", severity: "error", mock: false, what: "OAuth endpoint error that isn't JSON with a string error (RFC 6749 5.2)" },
  "company.token-response": { side: "company", severity: "error", mock: false, what: "Token response without access_token, token_type, expires_in or session_id (4.2)" },
  "company.iss-missing": { side: "company", severity: "error", mock: false, what: "Authorization response without iss (RFC 9207, spec 4.5)" },
  "company.events-shape": { side: "company", severity: "error", mock: false, what: "Events response without an events array, string cursor or boolean has_more (7.5)" },
  "company.sse-event-id": { side: "company", severity: "error", mock: false, what: "A streamed event without an id (7.6)" }
} as const satisfies Record<string, CheckSpec>;

export type TraceCheckId = keyof typeof TRACE_CHECKS;

function check(id: TraceCheckId, exchange: Exchange | null, detail: string, severity?: Severity): Check {
  const spec = TRACE_CHECKS[id];
  return { id, side: spec.side, severity: severity ?? spec.severity, exchange: exchange?.index ?? null, detail, source: "trace" };
}

const SIGNING = new Set(["ES256", "RS256"]);
/** RFC 9449 acceptance window plus clock skew, as the mock allows. */
const DPOP_WINDOW_SECONDS = 90;

const withoutQuery = (url: URL) => `${url.origin}${url.pathname}`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("base64url");

/** Requests an agent sent to a Company, excluding the runner's probes. */
const agentRequests = (all: readonly Exchange[]) => all.filter((x) => x.direction === "to-company" && !x.probe);

/** Client and Session assertions: header, lifetime, jti, audience. */
export function assertionChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  const seen = { "client-assertion": new Set<string>(), "session-assertion": new Set<string>() };
  for (const x of agentRequests(all)) {
    const fields = form(x);
    if (!fields) continue;
    const clientId = fields.get("client_id");
    const jwts: ["client-assertion" | "session-assertion", string][] = [];
    const client = fields.get("client_assertion");
    if (client !== null) jwts.push(["client-assertion", client]);
    const assertion = fields.get("assertion");
    if (assertion !== null && fields.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer") jwts.push(["session-assertion", assertion]);
    for (const [kind, jwt] of jwts) {
      const decoded = decodeJwt(jwt);
      if (!decoded) {
        found.push(check(`${kind}.not-jwt`, x, `${kind} at ${withoutQuery(x.url)} isn't a JWT`));
        continue;
      }
      const { header, payload } = decoded;
      if (header.typ !== "JWT") found.push(check(`${kind}.typ`, x, `typ is ${JSON.stringify(header.typ)}`));
      if (typeof header.kid !== "string" || header.kid === "") found.push(check(`${kind}.kid`, x, "no kid in the header"));
      if (!SIGNING.has(String(header.alg))) found.push(check(`${kind}.alg`, x, `alg ${JSON.stringify(header.alg)}`));
      if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
        found.push(check(`${kind}.iat-exp-missing`, x, "no numeric iat and exp"));
      } else {
        const lifetime = payload.exp - payload.iat;
        if (lifetime > 300) found.push(check(`${kind}.lifetime`, x, `lifetime ${lifetime} s`));
        else if (lifetime > 60) found.push(check(`${kind}.lifetime`, x, `lifetime ${lifetime} s, over the 60 strict Companies allow`, "warning"));
      }
      if (typeof payload.jti !== "string" || payload.jti === "") found.push(check(`${kind}.jti-missing`, x, "no jti"));
      else if (seen[kind].has(payload.jti)) found.push(check(`${kind}.jti-reused`, x, `jti ${payload.jti} again`));
      else seen[kind].add(payload.jti);
      if (kind === "client-assertion") {
        if (Array.isArray(payload.aud)) found.push(check("client-assertion.aud-array", x, "aud is an array"));
        if (clientId && (payload.iss !== clientId || payload.sub !== clientId)) {
          found.push(check("client-assertion.iss-sub", x, `iss ${JSON.stringify(payload.iss)}, sub ${JSON.stringify(payload.sub)}, client_id ${clientId}`));
        }
      } else {
        if (payload.aud !== withoutQuery(x.url)) found.push(check("session-assertion.aud", x, `aud ${JSON.stringify(payload.aud)} at ${withoutQuery(x.url)}`));
        if (clientId && payload.iss !== clientId) found.push(check("session-assertion.iss", x, `iss ${JSON.stringify(payload.iss)}, client_id ${clientId}`));
      }
    }
  }
  return found;
}

/** DPoP proofs: typ, jwk, htm, htu, iat, jti and ath (RFC 9449). */
export function dpopChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  const seen = new Set<string>();
  for (const x of agentRequests(all)) {
    const proof = x.requestHeaders.get("dpop");
    if (!proof) continue;
    const decoded = decodeJwt(proof);
    if (!decoded) {
      found.push(check("dpop.not-jwt", x, "DPoP header isn't a JWT"));
      continue;
    }
    const { header, payload } = decoded;
    if (header.typ !== "dpop+jwt") found.push(check("dpop.typ", x, `typ ${JSON.stringify(header.typ)}`));
    if (!header.jwk || typeof header.jwk !== "object") found.push(check("dpop.no-jwk", x, "no jwk"));
    if (payload.htm !== x.method) found.push(check("dpop.htm", x, `htm ${JSON.stringify(payload.htm)} for ${x.method}`));
    if (typeof payload.htu !== "string" || payload.htu !== withoutQuery(x.url)) {
      found.push(check("dpop.htu", x, `htu ${JSON.stringify(payload.htu)} for ${withoutQuery(x.url)}`));
    }
    if (typeof payload.iat !== "number" || Math.abs(payload.iat - x.started / 1000) > DPOP_WINDOW_SECONDS) {
      found.push(check("dpop.iat", x, `iat ${JSON.stringify(payload.iat)}, sent at ${Math.round(x.started / 1000)}`));
    }
    if (typeof payload.jti !== "string" || payload.jti === "") found.push(check("dpop.jti-missing", x, "no jti"));
    else if (seen.has(payload.jti)) found.push(check("dpop.jti-reused", x, `jti ${payload.jti} again`));
    else seen.add(payload.jti);
    const auth = authorization(x);
    if (form(x)?.has("grant_type") && payload.ath !== undefined) found.push(check("dpop.ath-at-token-endpoint", x, "ath at the token endpoint"));
    if (auth?.scheme === "DPoP" && payload.ath !== sha256(auth.token)) found.push(check("dpop.ath", x, "ath isn't the token's hash"));
  }
  return found;
}

/** Every access and refresh token the Companies issued in the cell. */
export function issuedTokens(all: readonly Exchange[]): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const x of all) {
    if (x.direction !== "to-company" || x.status !== 200) continue;
    const body = jsonBody(x.responseBody);
    if (!body || typeof body !== "object") continue;
    for (const field of ["access_token", "refresh_token"]) {
      const value = (body as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length >= 8) tokens.set(value, x.peer ?? "");
    }
  }
  return tokens;
}

/** Tokens in URLs (spec 4.3): a known token or an `access_token` parameter in any request's URL. */
export function tokenInUrlChecks(all: readonly Exchange[]): Check[] {
  const tokens = issuedTokens(all);
  const found: Check[] = [];
  for (const x of all) {
    if (x.probe || x.direction === "other") continue;
    for (const [name, value] of x.url.searchParams) {
      if (name === "access_token" || tokens.has(value)) {
        found.push(check("secret.token-in-url", x, `${name}= in ${withoutQuery(x.url)}`));
      }
    }
  }
  return found;
}

/** Hosts a Company's poppy.json and OAuth metadata name, per Company. */
export function listedHosts(all: readonly Exchange[]): Map<string, Set<string>> {
  const hosts = new Map<string, Set<string>>();
  const add = (peer: string, value: unknown) => {
    if (typeof value === "string" && /^https:\/\//.test(value)) {
      try {
        const set = hosts.get(peer) ?? new Set<string>();
        set.add(new URL(value).host);
        hosts.set(peer, set);
      } catch {
        // Not a URL.
      }
    } else if (Array.isArray(value)) value.forEach((item) => add(peer, item));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => add(peer, item));
  };
  for (const x of all) {
    if (x.direction !== "to-company" || !x.peer || x.status !== 200) continue;
    if (x.url.pathname.endsWith("/.well-known/poppy.json") || x.url.pathname.startsWith("/.well-known/oauth-authorization-server") || x.url.pathname === "/poppy.json") {
      add(x.peer, jsonBody(x.responseBody));
    }
  }
  return hosts;
}

/** A Session Token sent to a host its Company's documents don't list (spec 4.3). */
export function unlistedHostChecks(all: readonly Exchange[]): Check[] {
  const tokens = issuedTokens(all);
  const listed = listedHosts(all);
  const found: Check[] = [];
  for (const x of all) {
    if (x.probe) continue;
    const auth = authorization(x);
    if (!auth || (auth.scheme !== "DPoP" && auth.scheme !== "Bearer")) continue;
    const issuer = tokens.get(auth.token);
    if (issuer === undefined) continue;
    const hosts = listed.get(issuer);
    if (!hosts) continue;
    if (x.direction !== "to-company" || x.peer !== issuer || !hosts.has(x.url.host)) {
      found.push(check("token.unlisted-host", x, `a token from ${issuer} sent to ${x.url.host}`));
    }
  }
  return found;
}

/** A redirect followed with the Authorization or DPoP of the request that got it (Guides). */
export function redirectChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  for (const [i, x] of all.entries()) {
    if (x.probe || x.status < 300 || x.status >= 400) continue;
    if (!x.requestHeaders.has("authorization") && !x.requestHeaders.has("dpop")) continue;
    const location = x.responseHeaders.get("location");
    if (!location) continue;
    const target = new URL(location, x.url).href;
    const followed = all.slice(i + 1).find((later) => later.url.href === target && (later.requestHeaders.has("authorization") || later.requestHeaders.has("dpop")));
    if (followed) found.push(check("redirect.credentials-followed", followed, `${x.url.href} redirected to ${target}, followed with credentials`));
  }
  return found;
}

/** A request to the same Company before an earlier 429's Retry-After elapsed (100 ms of slack for the proxy's clock). */
export function retryAfterChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  const blocked = new Map<string, number>();
  for (const x of [...agentRequests(all)].sort((a, b) => a.started - b.started)) {
    const until = blocked.get(x.peer ?? "");
    if (until !== undefined && x.started < until - 100) {
      found.push(check("rate-limit.retry-after-ignored", x, `sent ${until - x.started} ms before Retry-After elapsed`));
    }
    if (x.status === 429) {
      const seconds = Number(x.responseHeaders.get("retry-after"));
      if (Number.isFinite(seconds)) blocked.set(x.peer ?? "", x.ended + seconds * 1000);
    }
  }
  return found;
}

const OAUTH_PATH = /token|revoke|revocation|device|par\b/;

/** Company responses: WWW-Authenticate, Retry-After, OAuth error bodies, token responses, events. */
export function companyChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  for (const x of agentRequests(all)) {
    const auth = authorization(x);
    const fields = form(x);
    const oauth = !!fields && (fields.has("grant_type") || fields.has("client_assertion") || OAUTH_PATH.test(x.url.pathname));
    if (x.status === 401 && auth && !oauth && !x.responseHeaders.has("www-authenticate")) {
      found.push(check("company.www-authenticate", x, `401 for ${x.method} ${withoutQuery(x.url)}`));
    }
    if (x.status === 429 && !x.responseHeaders.has("retry-after")) found.push(check("company.retry-after", x, `429 for ${withoutQuery(x.url)}`));
    if (oauth && x.status >= 400 && x.status < 500) {
      const body = jsonBody(x.responseBody);
      if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).error !== "string") {
        found.push(check("company.oauth-error-body", x, `HTTP ${x.status} from ${withoutQuery(x.url)}: ${x.responseBody.slice(0, 120)}`));
      }
    }
    if (oauth && fields?.has("grant_type") && x.status === 200) {
      const body = jsonBody(x.responseBody) as Record<string, unknown> | undefined;
      const missing = ["access_token", "token_type", "expires_in", "session_id"].filter((field) => body?.[field] === undefined);
      if (missing.length) found.push(check("company.token-response", x, `missing ${missing.join(", ")}`));
    }
    if (x.method === "GET" && /\/events$/.test(x.url.pathname) && x.status === 200) {
      const type = x.responseHeaders.get("content-type") ?? "";
      if (type.includes("application/json")) {
        const body = jsonBody(x.responseBody) as Record<string, unknown> | undefined;
        const events = body?.events;
        if (!Array.isArray(events) || (events.length > 0 && typeof body?.cursor !== "string") || (body?.has_more !== undefined && typeof body.has_more !== "boolean")) {
          found.push(check("company.events-shape", x, x.responseBody.slice(0, 160)));
        }
      } else if (type.includes("text/event-stream")) {
        for (const block of x.responseBody.replace(/\r\n?/g, "\n").split("\n\n")) {
          const lines = block.split("\n");
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
          const hasData = lines.some((line) => line.startsWith("data:"));
          if (hasData && event !== "text-delta" && !lines.some((line) => line.startsWith("id:"))) {
            found.push(check("company.sse-event-id", x, `a ${event} event without an id`));
            break;
          }
        }
      }
    }
  }
  return found;
}

/** Authorization responses (the callback URLs a Company produced) must carry `iss` (RFC 9207, spec 4.5). */
export function authorizationResponseChecks(callbacks: readonly string[], all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  const urls = [...callbacks];
  for (const x of all) {
    const location = x.responseHeaders.get("location");
    if (x.direction === "to-company" && location && /[?&](code|error)=/.test(location) && /[?&]state=/.test(location)) urls.push(location);
  }
  for (const url of urls) {
    try {
      if (!new URL(url).searchParams.get("iss")) found.push(check("company.iss-missing", null, url));
    } catch {
      // Not a URL; the step that produced it failed already.
    }
  }
  return found;
}

/** Every trace check. */
export function traceChecks(all: readonly Exchange[], callbacks: readonly string[] = []): Check[] {
  return [
    ...assertionChecks(all),
    ...dpopChecks(all),
    ...tokenInUrlChecks(all),
    ...unlistedHostChecks(all),
    ...redirectChecks(all),
    ...retryAfterChecks(all),
    ...companyChecks(all),
    ...authorizationResponseChecks(callbacks, all)
  ];
}
