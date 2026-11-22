/**
 * Fetching a document someone else controls, the way the Guides ask
 * ("Fetching metadata safely"): HTTPS only, a few redirects (each HTTPS), a
 * size cap, a timeout, no credentials, no private hosts. Problems become
 * messages on the document's checker rather than exceptions, so the report
 * says what went wrong.
 */
import type { Checker } from "./primitives.ts";

export type Fetcher = (request: Request) => Promise<Response>;

// 10 s, the top of the Guides' "a timeout of a few seconds": a serverless Company's
// first answer after a cold start can take longer than 5 s (readings.md).
export const LIMITS = { maxBytes: 100_000, timeoutMs: 10_000, maxRedirects: 3 } as const;

/**
 * The validator's name, for a Company's logs and bot rules. `fetchDocument`
 * sends none of its own, because the agent's discovery fetches through it
 * too and names itself; the HTTP validator (http.ts) and the CLI add this
 * with `withUserAgent`. Without one a Worker's and Node's requests carry no
 * User-Agent, and bot protection blocks those first. Its version is
 * `VALIDATOR.version` (validate.ts); a test keeps the two equal.
 */
export const USER_AGENT = "PoppyValidator/1.0.0 (+https://poppydemoagent.dev/validator)";

declare const NAMED: unique symbol;

/**
 * A fetcher that names its caller in `User-Agent`. Every fetch of another
 * party's document takes one (`fetchHops`), so a caller that forgets to say
 * who it is doesn't compile; `withUserAgent` is the only way to make one.
 */
export type IdentifiedFetcher = Fetcher & { readonly [NAMED]: true };

/** `fetcher`, with `userAgent` on each request that doesn't already name one. */
export function withUserAgent(fetcher: Fetcher, userAgent: string): IdentifiedFetcher {
  const named: Fetcher = (request) => {
    if (request.headers.has("User-Agent")) return fetcher(request);
    const headers = new Headers(request.headers);
    headers.set("User-Agent", userAgent);
    return fetcher(new Request(request, { headers }));
  };
  return named as IdentifiedFetcher;
}

/** For the `default` of a switch that covers every case: a case added later is a type error there. */
export function unreachable(value: never): never {
  throw new Error(`Unhandled case ${JSON.stringify(value)}`);
}

/**
 * Statuses Cloudflare answers with itself when the server behind it gives no
 * usable response. A Worker's fetch reports a dropped connection this way, and
 * a site behind Cloudflare does too, so none of them is the site's own answer.
 */
const CONNECTION_STATUSES: Readonly<Record<number, string>> = {
  520: "dropped the connection or sent a response that couldn't be read",
  521: "refused the connection",
  522: "didn't accept the connection in time",
  523: "couldn't be reached",
  524: "accepted the connection but didn't answer in time",
  525: "failed the TLS handshake",
  526: "presented a certificate that couldn't be verified",
  527: "couldn't be reached",
  // A Worker's fetch also gets 530 for a name that resolves to a private address, which Workers refuse to connect to.
  530: "couldn't be resolved or reached; a Worker gets this too for a name that resolves to a private address, which Workers won't connect to"
};

/** An error's code, from Node (`code`) or undici and others (`cause.code`). */
function errorCode(error: Error): unknown {
  return (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
}

/**
 * Errors that mean the server accepted the connection and then dropped it,
 * from Node (`code`) or a Worker (its message). A refused connection is left
 * out: that is usually a server that isn't listening, not one turning us away.
 */
function droppedConnection(error: Error): boolean {
  const code = errorCode(error);
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") return true;
  return /connection (was )?(reset|lost|closed)|socket hang up/i.test(error.message);
}

/** Node's codes for a certificate that didn't verify. */
const CERTIFICATE_ERRORS = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);

/**
 * Thrown by a fetcher whose server answered with a status a `Response` can't
 * hold (outside 200 to 599); Node's parser accepts any three digits.
 */
export const INVALID_STATUS = "ERR_HTTP_INVALID_STATUS_CODE";

/**
 * Why a fetch got no answer, decided once from what the fetcher threw;
 * `error` is what it threw. The error codes are Node's, so only the CLI's
 * fetcher (scripts/node-fetcher.ts) produces most of these. On Workers,
 * where the hosted validator and the agent run, the same failures arrive as
 * Cloudflare's own statuses instead (an `Answer` of kind "cloudflare": 526
 * for a certificate, 530 for a name that doesn't resolve or resolves to a
 * private address), and a Worker's `fetch` throws only for a lost connection
 * ("dropped") or a timeout.
 */
export type Failure =
  | { readonly kind: "timeout"; readonly seconds: number; readonly error: unknown }
  | { readonly kind: "non-public-address"; readonly message: string; readonly error: unknown }
  | { readonly kind: "invalid-status"; readonly message: string; readonly error: unknown }
  | { readonly kind: "certificate"; readonly code: string; readonly error: unknown }
  | { readonly kind: "unresolved" | "unresolved-for-now" | "refused" | "connect-timeout" | "unreachable" | "dropped" | "unknown"; readonly error: unknown };

function failureOf(error: unknown, timeoutMs: number): Failure {
  if (!(error instanceof Error)) return { kind: "unknown", error };
  const code = errorCode(error);
  if (error.name === "TimeoutError") return { kind: "timeout", seconds: timeoutMs / 1000, error };
  // A fetcher that resolves names itself refuses one that leads to a private address (address.ts).
  if (error.name === "NonPublicAddressError") return { kind: "non-public-address", message: error.message, error };
  if (code === INVALID_STATUS) return { kind: "invalid-status", message: error.message, error };
  if (typeof code === "string" && CERTIFICATE_ERRORS.has(code)) return { kind: "certificate", code, error };
  if (code === "ENOTFOUND") return { kind: "unresolved", error };
  if (code === "EAI_AGAIN") return { kind: "unresolved-for-now", error };
  if (code === "ECONNREFUSED") return { kind: "refused", error };
  if (code === "ETIMEDOUT") return { kind: "connect-timeout", error };
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return { kind: "unreachable", error };
  if (droppedConnection(error)) return { kind: "dropped", error };
  return { kind: "unknown", error };
}

export type BotService = "Cloudflare" | "Akamai" | "DataDome" | "Imperva";

/**
 * The bot-protection service that answered instead of the site, recognised by
 * what each puts on its own refusals (a header, its Server name, or a body it
 * always sends), or undefined. A plain 403 says nothing either way.
 */
function botProtection(status: number, headers: Headers, body: string): BotService | undefined {
  const server = headers.get("Server") ?? "";
  if (headers.has("cf-mitigated")) return "Cloudflare";
  if (/^cloudflare$/i.test(server) && /^error code: 10\d\d\b/.test(body.trim())) return "Cloudflare";
  if (headers.has("x-datadome")) return "DataDome";
  if (/^AkamaiGHost$/i.test(server) && (status === 403 || /Access Denied/i.test(body))) return "Akamai";
  if (/Incapsula incident ID|_Incapsula_Resource/i.test(body)) return "Imperva";
  return undefined;
}

/** Retry-After as seconds from now (RFC 9110 10.2.3: delay seconds or an HTTP date), or undefined. */
export function retryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.round((at - now) / 1000));
}

/** The start of an error page, enough to recognise a bot-protection refusal; whatever arrived if it stalls or fails. */
async function readPrefix(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // The deadline or the stream ended it; use what arrived.
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all.subarray(0, maxBytes));
}

/** Where a redirect points, decoded once: nothing else turns a `Location` into a URL. */
export type RedirectTarget =
  | { readonly kind: "url"; readonly url: URL }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly location: string };

function redirectTarget(location: string | null, base: URL): RedirectTarget {
  if (!location) return { kind: "missing" };
  try {
    return { kind: "url", url: new URL(location, base) };
  } catch {
    return { kind: "invalid", location };
  }
}

/** What answered, decided once from the status, its headers and, for a 401 or 403, the start of its body. */
export type Answer =
  | { readonly kind: "served"; readonly status: 200 }
  | { readonly kind: "redirect"; readonly status: number; readonly target: RedirectTarget }
  /** Cloudflare's own status for an unusable answer from the server behind it. */
  | { readonly kind: "cloudflare"; readonly status: number; readonly meaning: string }
  | { readonly kind: "bot-protection"; readonly status: number; readonly service: BotService }
  | { readonly kind: "rate-limited"; readonly status: 429; readonly retryAfter: number | undefined }
  | { readonly kind: "server-error"; readonly status: number; readonly retryAfter: number | undefined }
  | { readonly kind: "forbidden"; readonly status: 401 | 403 }
  | { readonly kind: "not-found"; readonly status: 404 }
  | { readonly kind: "other-status"; readonly status: number }
  /** A final status outside 200 to 599. A Worker's fetch passes one through (999, 600), though no `Response` can be built with it; Node's fetcher rejects instead. */
  | { readonly kind: "invalid-status"; readonly status: number };

/** Every answer but a document, after the body that won't be read is discarded. */
async function classify(response: Response, base: URL, signal: AbortSignal): Promise<Answer> {
  const { status, headers } = response;
  if (status === 200) return { kind: "served", status };
  if (status < 200 || status > 599) {
    void response.body?.cancel().catch(() => undefined);
    return { kind: "invalid-status", status };
  }
  // A 401 or 403 is read a little, for a bot-protection service's marks; every other body is discarded unread.
  const forbidden = status === 401 || status === 403;
  const body = forbidden ? await readPrefix(response, 2048, signal) : "";
  if (!forbidden) void response.body?.cancel().catch(() => undefined);
  if (status >= 300 && status < 400 && status !== 304) return { kind: "redirect", status, target: redirectTarget(headers.get("Location"), base) };
  const meaning = CONNECTION_STATUSES[status];
  if (meaning) return { kind: "cloudflare", status, meaning };
  const service = status >= 400 ? botProtection(status, headers, body) : undefined;
  if (service) return { kind: "bot-protection", status, service };
  if (status === 429) return { kind: "rate-limited", status, retryAfter: retryAfterSeconds(headers) };
  if (status === 404) return { kind: "not-found", status };
  if (status >= 500) return { kind: "server-error", status, retryAfter: retryAfterSeconds(headers) };
  if (status === 401 || status === 403) return { kind: "forbidden", status };
  return { kind: "other-status", status };
}

/** Why `fetchHops` stopped without a document. */
export type Stop =
  | { readonly kind: "not-https"; readonly redirected: boolean }
  | { readonly kind: "userinfo" }
  | { readonly kind: "non-public-host"; readonly host: string }
  | { readonly kind: "redirect-refused"; readonly status: number }
  | { readonly kind: "too-many-redirects"; readonly status: number }
  | { readonly kind: "bad-redirect"; readonly status: number; readonly target: Exclude<RedirectTarget, { kind: "url" }> }
  | { readonly kind: "answered"; readonly answer: NotServed; readonly contentType: string | undefined }
  | { readonly kind: "failed"; readonly failure: Failure };

/** An answer that ends the fetch: neither a document nor a redirect. */
export type NotServed = Exclude<Answer, { kind: "served" } | { kind: "redirect" }>;

export type Hops<T> =
  | { readonly kind: "served"; readonly at: URL; readonly value: T }
  | { readonly kind: "stopped"; readonly at: URL; readonly stop: Stop };

export type HopOptions = {
  readonly accept: string;
  /** One deadline for each hop: the answer and the body `read` reads. */
  readonly timeoutMs: number;
  /** How many redirects to follow, or "refused" for a document that must be served where it was asked for. */
  readonly redirects: number | "refused";
  /** Refuse a URL with a user name or password in it. */
  readonly refuseUserinfo?: boolean;
};

type Step<T> =
  | { readonly served: true; readonly value: T }
  | { readonly served: false; readonly answer: Exclude<Answer, { kind: "served" }>; readonly contentType: string | undefined };

/**
 * The one fetch of a document another party controls, for the validator and
 * the agent alike (Guides, "Fetching metadata safely"): HTTPS on a public
 * host at every hop, redirects followed up to a limit, a deadline per hop
 * over the answer and its body, HTTP 200 only (docs/readings.md#success-status),
 * and every other answer or failure classified once. `read` reads a served
 * body within the hop's deadline.
 */
export async function fetchHops<T>(
  fetcher: IdentifiedFetcher,
  url: URL,
  options: HopOptions,
  read: (response: Response, signal: AbortSignal) => Promise<T>
): Promise<Hops<T>> {
  for (let hop = 0, at = url; ; hop++) {
    const here = at;
    const stopped = (stop: Stop): Hops<T> => ({ kind: "stopped", at: here, stop });
    if (here.protocol !== "https:") return stopped({ kind: "not-https", redirected: hop > 0 });
    if (options.refuseUserinfo && (here.username || here.password)) return stopped({ kind: "userinfo" });
    // `localhost.` is `localhost`: a fully qualified name's root dot doesn't change the host.
    if (!isPublicHost(here)) return stopped({ kind: "non-public-host", host: here.hostname.toLowerCase().replace(/\.$/, "") });
    let step: Step<T>;
    try {
      step = await withDeadline(options.timeoutMs, async (signal): Promise<Step<T>> => {
        const request = new Request(here.href, { method: "GET", headers: { Accept: options.accept }, redirect: "manual", signal });
        const response = await raceAbort(
          fetcher(request).then((answer) => {
            // A fetcher may ignore abort and return after we've already timed out.
            if (signal.aborted) void answer.body?.cancel().catch(() => undefined);
            return answer;
          }),
          signal
        );
        const answer = await classify(response, here, signal);
        if (answer.kind === "served") return { served: true, value: await read(response, signal) };
        return { served: false, answer, contentType: response.headers.get("Content-Type") ?? undefined };
      });
    } catch (error) {
      return stopped({ kind: "failed", failure: failureOf(error, options.timeoutMs) });
    }
    if (step.served) return { kind: "served", at: here, value: step.value };
    const { answer } = step;
    if (answer.kind !== "redirect") return stopped({ kind: "answered", answer, contentType: step.contentType });
    if (options.redirects === "refused") return stopped({ kind: "redirect-refused", status: answer.status });
    if (answer.target.kind !== "url") return stopped({ kind: "bad-redirect", status: answer.status, target: answer.target });
    if (hop >= options.redirects) return stopped({ kind: "too-many-redirects", status: answer.status });
    at = answer.target.url;
  }
}

const BLOCKED_HINT =
  "Sites that block automated clients or cloud addresses often do this, and would block an agent the same way. To check the document itself, validate a saved copy.";

export type Fetched = {
  readonly url: string;
  /** Where the document was finally served from, after redirects. */
  readonly finalUrl: string;
  readonly status?: number;
  readonly contentType?: string;
  /** Seconds it may be cached for, from Cache-Control or Expires; null when neither is sent. */
  readonly maxAgeSeconds: number | null;
  /** The body, when it was fetched, within limits, and UTF-8. */
  readonly text?: string;
};

/**
 * Names that never lead to a public host, and the names under them: special-use
 * names (IANA's Special-Use Domain Names registry), the private-use
 * `.internal`, and the top-level names RFC 6762 Appendix G found in private
 * use, none of which is delegated in the root zone.
 */
export const NON_PUBLIC_SUFFIXES = [
  "localhost", // RFC 6761: loopback
  "local", // RFC 6762: multicast DNS on the local link
  "home.arpa", // RFC 8375: home networks
  "arpa", // infrastructure: reverse zones, ipv4only.arpa (RFC 8880), resolver.arpa, service.arpa, 6tisch.arpa
  "internal", // reserved by ICANN for private use (2024)
  "invalid", // RFC 6761: never resolves
  "onion", // RFC 7686: Tor, not DNS
  "alt", // RFC 9476: outside DNS
  "intranet", // RFC 6762 Appendix G, with the five below
  "private",
  "corp",
  "home",
  "lan"
] as const;

/**
 * Hosts never fetched, judged by name alone: IP literals, single-label names,
 * and the special-use and private-use names in `NON_PUBLIC_SUFFIXES`. It
 * can't see what a name resolves to (`127.0.0.1.nip.io` passes it), so a
 * runtime that can reach private networks must also check the address it
 * connects to: Workers refuse those destinations themselves, the Node CLI
 * checks each resolved address (address.ts), and any other caller must
 * supply a fetcher that does.
 */
export function isPublicHost(url: URL): boolean {
  // `localhost.` is `localhost`: a fully qualified name's root dot doesn't change the host.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return !(
    !host.includes(".") ||
    /^\d+(\.\d+){3}$/.test(host) ||
    host.startsWith("[") ||
    NON_PUBLIC_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  );
}

export function cacheSeconds(headers: Headers, now = Date.now()): number | null {
  const control = headers.get("Cache-Control") ?? "";
  if (/\bno-store\b|\bno-cache\b/i.test(control)) return 0;
  const maxAge = /\bmax-age=(\d+)/i.exec(control);
  if (maxAge) return Number(maxAge[1]);
  const expires = headers.get("Expires");
  if (expires) {
    const at = Date.parse(expires);
    if (!Number.isNaN(at)) return Math.max(0, Math.round((at - now) / 1000));
  }
  return null;
}

/**
 * Runs `run` with a signal that aborts after `ms` with a `TimeoutError`, on
 * `setTimeout` (so fake timers drive it), and clears the timer afterwards.
 */
export async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException(`Timed out after ${ms / 1000} seconds`, "TimeoutError")), ms);
  try {
    return await run(deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** `promise`, or the signal's reason if it aborts first: for a fetcher that may ignore the signal. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

/**
 * The body, up to `maxBytes` (null beyond). Rejects with the signal's reason
 * when it aborts mid-read, whether or not the fetcher ties the body to it.
 */
export async function readLimited(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
  signal.throwIfAborted();
  if (Number(response.headers.get("Content-Length") ?? "0") > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      // A source or a sibling tee reader can keep cancellation pending forever.
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    const { done, value } = next;
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      signal.removeEventListener("abort", onAbort);
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  signal.removeEventListener("abort", onAbort);
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

export async function fetchDocument(
  fetcher: IdentifiedFetcher,
  url: string,
  c: Checker,
  options: { followRedirects?: boolean; notFoundIsAnswer?: boolean } = {}
): Promise<Fetched> {
  let start: URL;
  try {
    start = new URL(url);
  } catch {
    c.report("http-failed", "", `${url} isn't a URL.`);
    return { url, finalUrl: url, maxAgeSeconds: null };
  }
  const result = await fetchHops(
    fetcher,
    start,
    { accept: "application/json", timeoutMs: LIMITS.timeoutMs, redirects: (options.followRedirects ?? true) ? LIMITS.maxRedirects : "refused" },
    async (response, signal) => ({ bytes: await readLimited(response, LIMITS.maxBytes, signal), headers: response.headers })
  );
  const at = result.at.href;
  if (result.kind === "stopped") return { url, finalUrl: at, maxAgeSeconds: null, ...reportStop(result.stop, at, url, c, options) };
  const { bytes, headers } = result.value;
  const contentType = headers.get("Content-Type") ?? undefined;
  const base = { url, finalUrl: at, status: 200, ...(contentType ? { contentType } : {}) };
  if (!bytes) {
    c.report("http-too-large", "", `${at} is larger than 100 KB.`);
    return { ...base, maxAgeSeconds: null };
  }
  if (!/^application\/([\w.+-]+\+)?json\b/i.test(contentType ?? "")) {
    c.report("http-content-type", "", `${at} is served as ${contentType ?? "no Content-Type"}, not application/json.`);
  }
  const maxAgeSeconds = cacheSeconds(headers);
  if (maxAgeSeconds === null) c.report("http-no-cache-headers", "", `${at} sends no Cache-Control or Expires.`);
  else if (maxAgeSeconds < 60 || maxAgeSeconds > 86_400) {
    c.report("http-cache-bounded", "", `${at} may be cached for ${maxAgeSeconds} seconds; agents typically clamp that to between 60 and 86400.`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    c.report("not-utf8", "", `${at} isn't valid UTF-8.`);
    return { ...base, maxAgeSeconds };
  }
  return { ...base, maxAgeSeconds, text };
}

/** The report for a fetch that stopped without a document, and the status and type it got, if any. */
function reportStop(
  stop: Stop,
  at: string,
  url: string,
  c: Checker,
  options: { notFoundIsAnswer?: boolean }
): { status?: number; contentType?: string } {
  switch (stop.kind) {
    case "not-https":
      if (stop.redirected) c.report("http-redirect-not-https", "", `A redirect led to ${at}, which isn't HTTPS.`);
      else c.report("http-not-https", "", `${at} isn't HTTPS.`);
      return {};
    case "userinfo":
      c.report("http-failed", "", `${at} has a user name or password in it, so it wasn't fetched.`);
      return {};
    case "non-public-host":
      c.report("http-non-public-host", "", `${stop.host} isn't a public host name.`);
      return {};
    case "redirect-refused":
      c.report("http-redirect-not-allowed", "", `${at} redirects (HTTP ${stop.status}) instead of serving the document.`);
      return { status: stop.status };
    case "too-many-redirects":
      c.report("http-too-many-redirects", "", `More than ${LIMITS.maxRedirects} redirects from ${url}.`);
      return { status: stop.status };
    case "bad-redirect":
      if (stop.target.kind === "missing") c.report("http-status", "", `${at} answered HTTP ${stop.status} without a Location.`);
      else {
        const shown = stop.target.location.length > 200 ? `${stop.target.location.slice(0, 200)}…` : stop.target.location;
        c.report("http-status", "", `${at} redirects (HTTP ${stop.status}) to ${JSON.stringify(shown)}, which isn't a URL.`);
      }
      return { status: stop.status };
    case "answered": {
      const { answer } = stop;
      const got = { status: answer.status, ...(stop.contentType ? { contentType: stop.contentType } : {}) };
      // A 404 is an answer where the protocol gives it a meaning, such as no issuer (3.2); the caller reports it.
      if (answer.kind === "not-found" && options.notFoundIsAnswer) return got;
      reportAnswer(answer, at, c);
      return got;
    }
    case "failed":
      reportFailure(stop.failure, at, c);
      return {};
    default:
      return unreachable(stop);
  }
}

function reportAnswer(answer: NotServed, at: string, c: Checker): void {
  const asks = (wait: number | undefined) => (wait === undefined ? "" : ` and asks to wait ${wait} seconds`);
  switch (answer.kind) {
    // No answer from the site, so not a status it chose: a failed fetch.
    case "cloudflare":
      c.report(
        "http-failed",
        "",
        `Fetching ${at} failed: the server ${answer.meaning}. HTTP ${answer.status} is Cloudflare's code for that, not a status the server sent.${answer.status === 520 ? ` ${BLOCKED_HINT}` : ""}`
      );
      return;
    // Its bot protection answered, not the site: the validator was turned away before the site was asked.
    case "bot-protection":
      c.report(
        "http-failed",
        "",
        `Fetching ${at} failed: ${answer.service}'s bot protection turned the validator away (HTTP ${answer.status}), so the site wasn't asked. It would turn agents away the same way unless it lets them through. To check the document itself, validate a saved copy.`
      );
      return;
    // A limit on how often we may ask, not an answer about the document.
    case "rate-limited":
      c.report("http-failed", "", `Fetching ${at} failed: the server is limiting how often it's asked (HTTP 429)${asks(answer.retryAfter)}. Try again later.`);
      return;
    case "server-error":
      c.report("http-status", "", `${at} answered HTTP ${answer.status}, a server error${asks(answer.retryAfter)}. Server errors are often temporary; try again later.`);
      return;
    case "forbidden":
      c.report(
        "http-status",
        "",
        `${at} answered HTTP ${answer.status}. If it opens in a browser, the site may be turning away automated clients or cloud addresses, which would turn agents away too.`
      );
      return;
    case "not-found":
    case "other-status":
      c.report("http-status", "", `${at} answered HTTP ${answer.status}.`);
      return;
    // Worded as Node's fetcher words its rejection (scripts/node-fetcher.ts), so both runtimes report it alike.
    case "invalid-status":
      c.report("http-failed", "", `Fetching ${at} failed: the server answered with HTTP status ${answer.status}, which isn't a valid status.`);
      return;
    default:
      unreachable(answer);
  }
}

function reportFailure(failure: Failure, at: string, c: Checker): void {
  const failed = (reason: string) => c.report("http-failed", "", `Fetching ${at} failed${reason}`);
  switch (failure.kind) {
    case "timeout":
      c.report("http-failed", "", `Fetching ${at} timed out after ${failure.seconds} seconds.`);
      return;
    case "non-public-address":
      c.report("http-non-public-address", "", `${failure.message}, so ${at} wasn't fetched.`);
      return;
    case "invalid-status":
      return failed(`: ${failure.message}.`);
    case "certificate":
      return failed(`: its TLS certificate didn't verify (${failure.code}). The Guides ask agents to validate certificates, so none will use it.`);
    case "unresolved":
      return failed(": the host name doesn't resolve.");
    case "unresolved-for-now":
      return failed(": the host name couldn't be resolved just now.");
    case "refused":
      return failed(": the server refused the connection.");
    case "connect-timeout":
      return failed(": the connection timed out.");
    case "unreachable":
      return failed(": the host is unreachable.");
    case "dropped":
      return failed(`: the server dropped the connection. ${BLOCKED_HINT}`);
    case "unknown":
      return failed(".");
    default:
      unreachable(failure);
  }
}

/** RFC 8414 §3.1: the well-known segment goes between the host and any path. */
export function metadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}
