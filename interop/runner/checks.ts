/**
 * Checks on the recording (spec section 8), independent of either side's
 * opinion. Pure functions over a cell's exchanges. Each check is named with
 * the mock Company's violation id (test/mock-company/violations.ts) where one
 * fits; Company-side checks are prefixed `company.`.
 *
 * Each check names its basis, and its severity follows from it
 * (docs/conformance-levels.md): a MUST, an RFC's MUST or a keyword-less rule
 * broken is an error, which fails the cell; a SHOULD, the Guides or our
 * reading (S2's `typ`, `kid` and lifetime; S1's `aud` array; which hosts
 * receive tokens, N10) is a warning, which doesn't. A mock id's basis is the
 * mock's (test/mock-company/violations.ts), and the tests check they agree.
 */
import { createHash } from "node:crypto";
import { levelOf, severityOf, type Basis } from "../../src/validator/levels.ts";
import { authorization, clientIdOf, decodeJwt, direction, form, isServerMetadata, jsonBody, type Exchange } from "./har.ts";
import type { Check, Side } from "./types.ts";

export type CheckSpec = {
  readonly side: Side;
  readonly basis: Basis;
  /** The id is one of the mock Company's violation ids. */
  readonly mock: boolean;
  readonly what: string;
};

export const TRACE_CHECKS = {
  "client-assertion.typ": { side: "agent", basis: "Reading", mock: true, what: "Client assertion header typ isn't \"JWT\" (S2)" },
  "client-assertion.kid": { side: "agent", basis: "Reading", mock: true, what: "Client assertion has no kid (S2)" },
  "client-assertion.alg": { side: "agent", basis: "Guides", mock: true, what: "Client assertion alg isn't ES256 or RS256" },
  "client-assertion.iat-exp-missing": { side: "agent", basis: "MUST", mock: true, what: "Client assertion without iat or exp" },
  "client-assertion.lifetime": { side: "agent", basis: "Reading", mock: true, what: "Client assertion lifetime over 60 seconds (S2; the detail says if over 300)" },
  "client-assertion.jti-missing": { side: "agent", basis: "MUST", mock: true, what: "Client assertion without a jti" },
  "client-assertion.jti-reused": { side: "agent", basis: "MUST", mock: true, what: "Client assertion jti used twice" },
  "client-assertion.aud-array": { side: "agent", basis: "MUST", mock: true, what: "Client assertion aud is an array" },
  "client-assertion.iss-sub": { side: "agent", basis: "RFC", mock: true, what: "Client assertion iss and sub aren't both the client_id" },
  "client-assertion.not-jwt": { side: "agent", basis: "RFC", mock: true, what: "Client assertion is not a JWT" },
  "dpop.not-jwt": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof is not a JWT" },
  "dpop.typ": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof typ isn't dpop+jwt" },
  "dpop.no-jwk": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof has no jwk in its header" },
  "dpop.htm": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof htm isn't the request method" },
  "dpop.htu": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof htu isn't the request URL without query or fragment" },
  "dpop.iat": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof iat is outside the acceptance window" },
  "dpop.jti-missing": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof without a jti" },
  "dpop.jti-reused": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof jti used twice" },
  "dpop.ath": { side: "agent", basis: "RFC", mock: true, what: "DPoP proof ath isn't the hash of the token sent" },
  "secret.token-in-url": { side: "agent", basis: "MUST", mock: true, what: "A token sent in a URL" },
  "rate-limit.retry-after-ignored": { side: "agent", basis: "MUST", mock: true, what: "Request sent again before its Retry-After elapsed" },
  "rate-limit.shared-limit-ignored": { side: "agent", basis: "Guides", mock: true, what: "A different request sent to the Company before an earlier Retry-After elapsed" },
  "token.unlisted-host": { side: "agent", basis: "Reading", mock: false, what: "A Session Token sent to a host the Company's documents don't list (our reading, N10)" },
  "redirect.credentials-followed": { side: "agent", basis: "Guides", mock: false, what: "A redirect followed with the token or proof of the request that got it (Guides)" },
  "company.www-authenticate": { side: "company", basis: "RFC", mock: false, what: "401 to a request with a token, without WWW-Authenticate (RFC 6750, RFC 9449)" },
  "company.retry-after": { side: "company", basis: "Rule", mock: false, what: "429 without Retry-After" },
  "company.oauth-error-body": { side: "company", basis: "RFC", mock: false, what: "OAuth endpoint error that isn't JSON with a string error (RFC 6749 5.2)" },
  "company.token-response": { side: "company", basis: "RFC", mock: false, what: "Token response without access_token or token_type (RFC 6749 5.1; 4.7)" },
  "company.token-no-store": { side: "company", basis: "RFC", mock: false, what: "Token response without Cache-Control: no-store (RFC 6749 5.1; Guides)" },
  "company.iss-missing": { side: "company", basis: "RFC", mock: false, what: "Authorization response without iss (RFC 9207, spec 4.5)" },
  "company.events-shape": {
    side: "company",
    basis: "MUST",
    mock: false,
    what: "Events read without an events array, a string cursor, a boolean has_more, or a string status and responder (7.5: every successful read MUST include them)"
  },
  "company.events-cursor": {
    side: "company",
    basis: "Reading",
    mock: false,
    what: "First read, with no cursor and no events, whose cursor is neither a string nor null (our reading, S10)"
  },
  "company.wait-reply-shape": {
    side: "company",
    basis: "Rule",
    mock: false,
    what: "Send with wait whose reply isn't a read's: events, cursor, has_more, status and responder (7.3: it responds as a read would, 7.5)"
  },
  "company.sse-event-id": { side: "company", basis: "Rule", mock: false, what: "A streamed event without an id (7.6)" },
  // Browser Sessions (spec 5): the agent's join request, by the mock's ids, and the Company's answer.
  "company.browser-session-response": {
    side: "company",
    basis: "Rule",
    mock: false,
    what: "A browser join's form the Company accepted without a redirect and a cookie (6, step 3: it sets the Session's cookie when it redirects the browser)"
  },
  "company.browser-cookie": {
    side: "company",
    basis: "Guides",
    mock: false,
    what: "The cookie a browser join set isn't Secure and HttpOnly (Guides, \"Browser sessions\"; 0.3 left the cookie's attributes to the Guides)"
  },
  "company.handoff-response": {
    side: "company",
    basis: "Rule",
    mock: false,
    what: "A handoff the Company accepted without HTTP 202, or without status and responder (7.9: \"returns HTTP 202 with status and responder\"; 7.7's MUST)"
  },
  "company.direct-parent-open": {
    side: "company",
    basis: "Rule",
    mock: false,
    what: "A message or handoff to a parent conversation accepted while its Direct Conversation was open, or refused without that conversation's id (7.10: they \"return direct_conversation_open, with the Direct Conversation's ID in conversation_id\")"
  },
  "company.metadata-fetch-credentials": {
    side: "company",
    basis: "Guides",
    mock: false,
    what: "The Company's fetch of client metadata or a key set carried a cookie, token or other credential (Guides, Fetching metadata safely)"
  }
} as const satisfies Record<string, CheckSpec>;

export type TraceCheckId = keyof typeof TRACE_CHECKS;

function check(id: TraceCheckId, exchange: Exchange | null, detail: string): Check {
  const spec: CheckSpec = TRACE_CHECKS[id];
  return { id, side: spec.side, severity: severityOf(levelOf(spec.basis)) === "error" ? "error" : "warning", basis: spec.basis, exchange: exchange?.index ?? null, detail, source: "trace" };
}

const SIGNING = new Set(["ES256", "RS256"]);
/** RFC 9449 acceptance window plus clock skew, as the mock allows. */
const DPOP_WINDOW_SECONDS = 90;

const withoutQuery = (url: URL) => `${url.origin}${url.pathname}`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("base64url");

/** Requests an agent sent to a Company, excluding the runner's probes and the proxy's injected exchanges (spec §6). */
const agentRequests = (all: readonly Exchange[]) => all.filter((x) => x.direction === "to-company" && !x.probe && !x.injected);

/** Client assertions: header, lifetime, jti, and an audience that is the issuer (4.1). */
export function assertionChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  const seen = new Set<string>();
  for (const x of agentRequests(all)) {
    const fields = form(x);
    const jwt = fields?.get("client_assertion");
    if (!fields || jwt === null || jwt === undefined) continue;
    const clientId = fields.get("client_id");
    const decoded = decodeJwt(jwt);
    if (!decoded) {
      found.push(check("client-assertion.not-jwt", x, `client assertion at ${withoutQuery(x.url)} isn't a JWT`));
      continue;
    }
    const { header, payload } = decoded;
    if (header.typ !== "JWT") found.push(check("client-assertion.typ", x, `typ is ${JSON.stringify(header.typ)}`));
    if (typeof header.kid !== "string" || header.kid === "") found.push(check("client-assertion.kid", x, "no kid in the header"));
    if (!SIGNING.has(String(header.alg))) found.push(check("client-assertion.alg", x, `alg ${JSON.stringify(header.alg)}`));
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
      found.push(check("client-assertion.iat-exp-missing", x, "no numeric iat and exp"));
    } else {
      const lifetime = payload.exp - payload.iat;
      if (lifetime > 300) found.push(check("client-assertion.lifetime", x, `lifetime ${lifetime} s, over the 300 even lenient Companies allow`));
      else if (lifetime > 60) found.push(check("client-assertion.lifetime", x, `lifetime ${lifetime} s, over the 60 strict Companies allow`));
    }
    if (typeof payload.jti !== "string" || payload.jti === "") found.push(check("client-assertion.jti-missing", x, "no jti"));
    else if (seen.has(payload.jti)) found.push(check("client-assertion.jti-reused", x, `jti ${payload.jti} again`));
    else seen.add(payload.jti);
    // 4.1: aud is the issuer, as a single string, whichever of its endpoints the assertion goes to.
    const issuer = all.filter(isServerMetadata).map((exchange) => jsonBody(exchange.responseBody) as Record<string, unknown> | undefined).find((doc) => doc && typeof doc === "object" && !Array.isArray(doc) && [doc.token_endpoint, doc.revocation_endpoint, doc.device_authorization_endpoint].includes(x.url.href));
    if (Array.isArray(payload.aud)) found.push(check("client-assertion.aud-array", x, "aud is an array"));
    else if (issuer && payload.aud !== issuer.issuer) found.push({ ...check("client-assertion.aud-array", x, `aud ${JSON.stringify(payload.aud)}, not the issuer ${JSON.stringify(issuer.issuer)}`), id: "client-assertion.aud", basis: "MUST", severity: "error" });
    if (clientId && (payload.iss !== clientId || payload.sub !== clientId)) {
      found.push(check("client-assertion.iss-sub", x, `iss ${JSON.stringify(payload.iss)}, sub ${JSON.stringify(payload.sub)}, client_id ${clientId}`));
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
    if (x.probe || x.injected || x.direction === "other") continue;
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
    if (x.url.pathname.endsWith("/.well-known/poppy.json") || isServerMetadata(x) || x.url.pathname === "/poppy.json") {
      add(x.peer, jsonBody(x.responseBody));
    }
  }
  return hosts;
}

/**
 * A Session Token sent to a host its Company's documents don't list. Our
 * reading, not a MUST: 4.3 and 6 don't say which hosts may receive Session
 * Tokens (spec-issues N10). Still an error here; see docs/spec-issues.md N10.
 */
export function unlistedHostChecks(all: readonly Exchange[]): Check[] {
  const tokens = issuedTokens(all);
  const listed = listedHosts(all);
  const found: Check[] = [];
  for (const x of all) {
    if (x.probe || x.injected) continue;
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
    if (x.probe || x.injected || x.status < 300 || x.status >= 400) continue;
    if (!x.requestHeaders.has("authorization") && !x.requestHeaders.has("dpop")) continue;
    const location = x.responseHeaders.get("location");
    if (!location) continue;
    const target = new URL(location, x.url).href;
    const followed = all.slice(i + 1).find((later) => later.url.href === target && (later.requestHeaders.has("authorization") || later.requestHeaders.has("dpop")));
    if (followed) found.push(check("redirect.credentials-followed", followed, `${x.url.href} redirected to ${target}, followed with credentials`));
  }
  return found;
}

/**
 * Requests to a Company before an earlier 429's Retry-After elapsed (100 ms
 * of slack for the proxy's clock). 4.3's MUST is about sending the request
 * again ("before sending the request again"): the same method and URL is
 * `rate-limit.retry-after-ignored`. A different request to that Company in
 * the wait departs only from the Guides' advice to share a Company's limit
 * across tasks, `rate-limit.shared-limit-ignored`, a warning, as the mock
 * Company reads it.
 */
export function retryAfterChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  const blocked = new Map<string, { until: number; request: string }[]>();
  for (const x of [...agentRequests(all)].sort((a, b) => a.started - b.started)) {
    const peer = x.peer ?? "";
    const request = `${x.method} ${x.url.href}`;
    const waits = (blocked.get(peer) ?? []).filter((wait) => x.started < wait.until - 100);
    const same = waits.find((wait) => wait.request === request);
    if (same) {
      found.push(check("rate-limit.retry-after-ignored", x, `sent again ${same.until - x.started} ms before its Retry-After elapsed`));
    } else if (waits.length > 0) {
      const latest = Math.max(...waits.map((wait) => wait.until));
      found.push(check("rate-limit.shared-limit-ignored", x, `sent ${latest - x.started} ms before an earlier Retry-After at this Company elapsed`));
    }
    if (x.status === 429) {
      const seconds = Number(x.responseHeaders.get("retry-after"));
      if (Number.isFinite(seconds)) blocked.set(peer, [...waits, { until: x.ended + seconds * 1000, request }]);
    }
  }
  return found;
}

const OAUTH_PATH = /token|revoke|revocation|device|par\b/;
/** Where a conversation's first message goes, or a later one (7.3). */
const SEND_PATH = /\/conversations(?:\/[^/]+\/messages)?$/;

/**
 * A read's body (7.5): "Every successful read MUST include `cursor`,
 * `has_more`, `status`, and `responder`, even with no events. `cursor` is the
 * last event returned, or the request's cursor if there were none." A send
 * with `wait` "responds as a read of the conversation's events from that
 * cursor would" (7.3), so its reply is held to the same, as a Rule.
 *
 * The draft doesn't say what `cursor` is when there were no events and the
 * request had no cursor (S10). Our reading (docs/readings.md): a string or
 * `null`. So `null` there departs from nothing, and any other value is
 * `company.events-cursor`, a Reading.
 */
function readShapeChecks(x: Exchange, id: "company.events-shape" | "company.wait-reply-shape", protocolVersion = "0.1"): Check[] {
  const body = jsonBody(x.responseBody);
  if (!body || typeof body !== "object" || Array.isArray(body)) return [check(id, x, `not a JSON object: ${x.responseBody.slice(0, 120)}`)];
  const read = body as Record<string, unknown>;
  const problems: string[] = [];
  const events = read.events;
  if (protocolVersion === "0.2" && typeof read.conversation_id !== "string") problems.push("no string conversation_id");
  if (!Array.isArray(events)) problems.push("events isn't an array");
  if (!("has_more" in read)) problems.push("no has_more");
  else if (typeof read.has_more !== "boolean") problems.push("has_more isn't a boolean");
  for (const field of ["status", "responder"] as const) {
    if (!(field in read)) problems.push(`no ${field}`);
    else if (typeof read[field] !== "string") problems.push(`${field} isn't a string`);
  }
  const requestCursor = x.url.searchParams.get("cursor") ?? x.requestHeaders.get("last-event-id") ?? null;
  const found: Check[] = [];
  if (!("cursor" in read)) problems.push("no cursor");
  else if (typeof read.cursor !== "string") {
    if (requestCursor !== null) problems.push(`cursor ${JSON.stringify(read.cursor)}, not a string, after a request with a cursor`);
    else if (Array.isArray(events) && events.length > 0) problems.push(`cursor ${JSON.stringify(read.cursor)}, not a string, with events returned`);
    else if (read.cursor !== null) found.push(check("company.events-cursor", x, `cursor ${JSON.stringify(read.cursor)} on a first read with no events`));
  }
  if (problems.length > 0) found.unshift(check(id, x, `${problems.join("; ")}: ${x.responseBody.slice(0, 120)}`));
  return found;
}

/** Company responses: WWW-Authenticate, Retry-After, OAuth error bodies, token responses, events. */
export function companyChecks(all: readonly Exchange[], protocolVersion = "0.1"): Check[] {
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
      // RFC 6749 5.1: expires_in is only RECOMMENDED, and 0.3 has no session_id (4.7).
      const missing = ["access_token", "token_type"].filter((field) => body?.[field] === undefined);
      if (missing.length) found.push(check("company.token-response", x, `missing ${missing.join(", ")}`));
      // RFC 6749 5.1: a response with tokens MUST carry Cache-Control: no-store, or a cache may keep them.
      if (body?.access_token !== undefined && !/(^|,)\s*no-store\s*(,|$)/i.test(x.responseHeaders.get("cache-control") ?? "")) {
        found.push(check("company.token-no-store", x, `token response from ${withoutQuery(x.url)} without Cache-Control: no-store`));
      }
    }
    if (x.method === "GET" && /\/events$/.test(x.url.pathname) && x.status === 200) {
      const type = x.responseHeaders.get("content-type") ?? "";
      if (type.includes("application/json")) {
        found.push(...readShapeChecks(x, "company.events-shape", protocolVersion));
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
    if (x.method === "POST" && x.url.searchParams.has("wait") && (x.status === 201 || x.status === 202) && SEND_PATH.test(x.url.pathname)) {
      if ((x.responseHeaders.get("content-type") ?? "").includes("application/json")) found.push(...readShapeChecks(x, "company.wait-reply-shape", protocolVersion));
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

// ---------------------------------------------------------------- Browser Sessions (spec 5)

/** Every `web.browser_session_endpoint` the recording's poppy.json documents name. */
export function browserEndpoints(all: readonly Exchange[]): Set<string> {
  const endpoints = new Set<string>();
  for (const x of all) {
    if (x.direction !== "to-company" || x.status !== 200 || !/(?:^|\/)poppy\.json$/.test(x.url.pathname)) continue;
    const web = (jsonBody(x.responseBody) as { web?: { browser_session_endpoint?: unknown } } | undefined)?.web;
    if (typeof web?.browser_session_endpoint === "string") endpoints.add(web.browser_session_endpoint);
  }
  return endpoints;
}

/**
 * The agent's browser joins (6): requests to a Company's browser-session
 * endpoint itself, the page's GET and the form's POST. The agent's own
 * `{endpoint}/authorize` is a request of the agent's, not the browser's.
 */
export function browserJoins(all: readonly Exchange[]): Exchange[] {
  const endpoints = browserEndpoints(all);
  return agentRequests(all).filter((x) => endpoints.has(withoutQuery(x.url)));
}

/** `Set-Cookie` lines of a response; the recording joins repeated headers with ", ", which an Expires date also contains. */
export function setCookies(x: Exchange): string[] {
  const value = x.responseHeaders.get("set-cookie");
  if (!value) return [];
  return value.split(/,\s*(?=[^;,=\s]+=)/).filter((line) => line.trim() !== "");
}

/** The Company's answer to a join's form it accepted (6, step 3): a redirect, with the Session's cookie, Secure and HttpOnly (Guides). */
export function browserSessionResponseChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  for (const x of browserJoins(all)) {
    if (x.method !== "POST" || x.status < 200 || x.status >= 400) continue;
    const location = x.responseHeaders.get("location");
    const target = location ? new URL(location, x.url).href : null;
    const cookies = setCookies(x);
    const problems: string[] = [];
    if (x.status < 300) problems.push(`HTTP ${x.status}, not a redirect`);
    if (target === null) problems.push("no Location");
    if (cookies.length === 0) problems.push("no Set-Cookie");
    if (problems.length > 0) found.push(check("company.browser-session-response", x, problems.join("; ")));
    for (const cookie of cookies) {
      const attributes = cookie.split(";").slice(1).map((part) => part.trim().toLowerCase());
      const name = cookie.split("=")[0]!.trim();
      // Clearing the join's own cookie (Max-Age=0) sets nothing to protect.
      if (attributes.includes("max-age=0")) continue;
      const missing = ["secure", "httponly"].filter((flag) => !attributes.includes(flag));
      if (missing.length) found.push(check("company.browser-cookie", x, `cookie ${name}: ${missing.map((flag) => `no ${flag === "httponly" ? "HttpOnly" : "Secure"}`).join(", ")}`));
    }
  }
  return found;
}

// ---------------------------------------------------------------- Handoff and Direct Conversations (7.9, 7.10)

const CONVERSATION_ACTION = /\/conversations\/([^/]+)\/(messages|handoff|close|events)$/;

/** A handoff the Company accepted answers 202 with `status` and `responder` (7.9, 7.7). */
export function handoffChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  for (const x of agentRequests(all)) {
    if (x.method !== "POST" || CONVERSATION_ACTION.exec(x.url.pathname)?.[2] !== "handoff" || x.status < 200 || x.status >= 300) continue;
    const body = jsonBody(x.responseBody) as Record<string, unknown> | undefined;
    const problems: string[] = [];
    if (x.status !== 202) problems.push(`HTTP ${x.status}, not 202`);
    for (const field of ["status", "responder"]) if (typeof body?.[field] !== "string") problems.push(`no ${field}`);
    if (problems.length) found.push(check("company.handoff-response", x, `${problems.join("; ")}: ${x.responseBody.slice(0, 120)}`));
  }
  return found;
}

/** The events a read returned, as JSON (7.5) or a stream (7.6). */
export function eventsOf(x: Exchange): Record<string, unknown>[] {
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if ((x.responseHeaders.get("content-type") ?? "").includes("text/event-stream")) {
    return x.responseBody
      .replace(/\r\n?/g, "\n")
      .split("\n\n")
      .map((block) => jsonBody(block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")))
      .filter(isObject);
  }
  const events = (jsonBody(x.responseBody) as { events?: unknown } | undefined)?.events;
  return Array.isArray(events) ? events.filter(isObject) : [];
}

/**
 * While a Direct Conversation is open, its parent takes no messages or
 * handoff requests: they get `direct_conversation_open` with the Direct
 * Conversation's id (7.10). Open from the Company's 2xx to a start with
 * `parent_conversation_id`; closed by a close of either (7.12), or by a
 * `direct_closed` event the agent read.
 */
export function directParentChecks(all: readonly Exchange[]): Check[] {
  const found: Check[] = [];
  /** Parent conversation id → its open Direct Conversation's id. */
  const open = new Map<string, string>();
  const closeChild = (child: string) => {
    for (const [parent, direct] of open) if (direct === child) open.delete(parent);
  };
  for (const x of [...agentRequests(all)].sort((a, b) => a.started - b.started)) {
    if (x.method === "POST" && SEND_PATH.test(x.url.pathname) && !CONVERSATION_ACTION.test(x.url.pathname) && x.status >= 200 && x.status < 300) {
      const parent = (jsonBody(x.requestBody) as { parent_conversation_id?: unknown } | undefined)?.parent_conversation_id;
      const child = (jsonBody(x.responseBody) as { conversation_id?: unknown } | undefined)?.conversation_id;
      if (typeof parent === "string" && typeof child === "string") open.set(parent, child);
      continue;
    }
    const action = CONVERSATION_ACTION.exec(x.url.pathname);
    if (!action) continue;
    const id = decodeURIComponent(action[1]!);
    if (action[2] === "events") {
      for (const event of eventsOf(x)) if (event.type === "direct_closed" && typeof event.conversation_id === "string") closeChild(event.conversation_id);
      continue;
    }
    if (action[2] === "close") {
      if (x.status >= 200 && x.status < 300) {
        open.delete(id);
        closeChild(id);
      }
      continue;
    }
    const child = open.get(id);
    if (child === undefined || x.method !== "POST") continue;
    if (x.status >= 200 && x.status < 300) {
      found.push(check("company.direct-parent-open", x, `${action[2]} to ${id} accepted (HTTP ${x.status}) while Direct Conversation ${child} was open`));
    } else if (x.status === 409) {
      const body = jsonBody(x.responseBody) as { error?: unknown; conversation_id?: unknown } | undefined;
      if (body?.error === "direct_conversation_open" && body.conversation_id !== child) {
        found.push(check("company.direct-parent-open", x, `direct_conversation_open names ${JSON.stringify(body.conversation_id)}, not ${child}`));
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------- The Company's fetches of our documents (4.1)

/** Every client_id the agents sent, and the jwks_uri each one's metadata names, as recorded. */
export function clientDocuments(all: readonly Exchange[]): { clientIds: Set<string>; jwksUris: Set<string> } {
  const clientIds = new Set<string>();
  for (const x of agentRequests(all)) {
    const id = clientIdOf(form(x));
    if (id) clientIds.add(id);
    // A Session JWT names its client in iss (5.2).
    const session = x.requestHeaders.get("poppy-session");
    const iss = session ? decodeJwt(session)?.payload.iss : undefined;
    if (typeof iss === "string") clientIds.add(iss);
  }
  const jwksUris = new Set<string>();
  for (const x of all) {
    if (x.direction !== "to-agent" || !clientIds.has(x.url.href)) continue;
    const uri = (jsonBody(x.responseBody) as { jwks_uri?: unknown } | undefined)?.jwks_uri;
    if (typeof uri === "string") jwksUris.add(uri);
  }
  return { clientIds, jwksUris };
}

/** Never send cookies, tokens, or other credentials on these fetches (Guides, Fetching metadata safely). */
export function metadataFetchChecks(all: readonly Exchange[]): Check[] {
  const { clientIds, jwksUris } = clientDocuments(all);
  const found: Check[] = [];
  for (const x of all) {
    if (x.probe || x.injected || x.direction !== "to-agent" || !(clientIds.has(x.url.href) || jwksUris.has(x.url.href))) continue;
    const sent = ["authorization", "dpop", "cookie"].filter((name) => x.requestHeaders.has(name));
    if (sent.length) found.push(check("company.metadata-fetch-credentials", x, `${sent.join(", ")} on the fetch of ${x.url.href}`));
  }
  return found;
}

/** Every trace check. */
export function traceChecks(all: readonly Exchange[], callbacks: readonly string[] = [], protocolVersion = "0.1"): Check[] {
  return [
    ...browserSessionResponseChecks(all),
    ...handoffChecks(all),
    ...directParentChecks(all),
    ...metadataFetchChecks(all),
    ...assertionChecks(all),
    ...dpopChecks(all),
    ...tokenInUrlChecks(all),
    ...unlistedHostChecks(all),
    ...redirectChecks(all),
    ...retryAfterChecks(all),
    ...companyChecks(all, protocolVersion),
    ...authorizationResponseChecks(callbacks, all)
  ];
}
