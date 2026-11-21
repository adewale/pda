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

/** `fetcher`, with `userAgent` on each request that doesn't already name one. */
export function withUserAgent(fetcher: Fetcher, userAgent: string): Fetcher {
  return (request) => {
    if (request.headers.has("User-Agent")) return fetcher(request);
    const headers = new Headers(request.headers);
    headers.set("User-Agent", userAgent);
    return fetcher(new Request(request, { headers }));
  };
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
  530: "couldn't be resolved or reached"
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

/** Why a fetch failed, from what the fetcher threw, as the end of "Fetching … failed". */
function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return ".";
  const code = errorCode(error);
  if (code === INVALID_STATUS) return `: ${error.message}.`;
  if (typeof code === "string" && CERTIFICATE_ERRORS.has(code)) return `: its TLS certificate didn't verify (${code}). The Guides ask agents to validate certificates, so none will use it.`;
  if (code === "ENOTFOUND") return ": the host name doesn't resolve.";
  if (code === "EAI_AGAIN") return ": the host name couldn't be resolved just now.";
  if (code === "ECONNREFUSED") return ": the server refused the connection.";
  if (code === "ETIMEDOUT") return ": the connection timed out.";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return ": the host is unreachable.";
  if (droppedConnection(error)) return `: the server dropped the connection. ${BLOCKED_HINT}`;
  return ".";
}

/**
 * The bot-protection service that answered instead of the site, recognised by
 * what each puts on its own refusals (a header, its Server name, or a body it
 * always sends), or undefined. A plain 403 says nothing either way.
 */
function botProtection(status: number, headers: Headers, body: string): string | undefined {
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
  fetcher: Fetcher,
  url: string,
  c: Checker,
  options: { followRedirects?: boolean; notFoundIsAnswer?: boolean } = {}
): Promise<Fetched> {
  const follow = options.followRedirects ?? true;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    c.report("http-failed", "", `${url} isn't a URL.`);
    return { url, finalUrl: url, maxAgeSeconds: null };
  }
  for (let hop = 0; ; hop++) {
    const at = current.href;
    if (current.protocol !== "https:") {
      if (hop === 0) c.report("http-not-https", "", `${at} isn't HTTPS.`);
      else c.report("http-redirect-not-https", "", `A redirect led to ${at}, which isn't HTTPS.`);
      return { url, finalUrl: at, maxAgeSeconds: null };
    }
    if (!isPublicHost(current)) {
      c.report("http-non-public-host", "", `${current.hostname} isn't a public host name.`);
      return { url, finalUrl: at, maxAgeSeconds: null };
    }
    // One deadline for the response and its body: a body that stalls is as failed as no answer.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("The fetch timed out", "TimeoutError")), LIMITS.timeoutMs);
    const failed = (error: unknown): Fetched => {
      if (error instanceof Error && error.name === "TimeoutError") c.report("http-failed", "", `Fetching ${at} timed out after ${LIMITS.timeoutMs / 1000} seconds.`);
      else c.report("http-failed", "", `Fetching ${at} failed${failureReason(error)}`);
      return { url, finalUrl: at, maxAgeSeconds: null };
    };
    let response: Response;
    try {
      response = await raceAbort(fetcher(
        new Request(at, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "manual",
          signal: deadline.signal
        })
      ).then((answer) => {
        // A fetcher may ignore abort and return after we've already timed out.
        if (deadline.signal.aborted) void answer.body?.cancel().catch(() => undefined);
        return answer;
      }), deadline.signal);
    } catch (error) {
      clearTimeout(timer);
      // A fetcher that resolves names itself refuses one that leads to a private address (address.ts).
      if (error instanceof Error && error.name === "NonPublicAddressError") {
        c.report("http-non-public-address", "", `${error.message}, so ${at} wasn't fetched.`);
        return { url, finalUrl: at, maxAgeSeconds: null };
      }
      return failed(error);
    }
    // A 200 has its body read and a 401 or 403 its first bytes (botProtection); nothing else needs the deadline after this.
    if (response.status !== 200 && response.status !== 401 && response.status !== 403) clearTimeout(timer);
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      void response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("Location");
      if (!follow) {
        c.report("http-redirect-not-allowed", "", `${at} redirects (HTTP ${response.status}) instead of serving the document.`);
        return { url, finalUrl: at, status: response.status, maxAgeSeconds: null };
      }
      if (!location) {
        c.report("http-status", "", `${at} answered HTTP ${response.status} without a Location.`);
        return { url, finalUrl: at, status: response.status, maxAgeSeconds: null };
      }
      if (hop >= LIMITS.maxRedirects) {
        c.report("http-too-many-redirects", "", `More than ${LIMITS.maxRedirects} redirects from ${url}.`);
        return { url, finalUrl: at, status: response.status, maxAgeSeconds: null };
      }
      try {
        current = new URL(location, current);
      } catch {
        const shown = location.length > 200 ? `${location.slice(0, 200)}…` : location;
        c.report("http-status", "", `${at} redirects (HTTP ${response.status}) to ${JSON.stringify(shown)}, which isn't a URL.`);
        return { url, finalUrl: at, status: response.status, maxAgeSeconds: null };
      }
      continue;
    }
    const contentType = response.headers.get("Content-Type") ?? undefined;
    const base = { url, finalUrl: at, status: response.status, ...(contentType ? { contentType } : {}) };
    if (response.status !== 200) {
      const status = response.status;
      let body = "";
      if (status === 401 || status === 403) {
        body = await readPrefix(response, 2048, deadline.signal);
        clearTimeout(timer);
      } else void response.body?.cancel().catch(() => undefined);
      // No answer from the site, so not a status it chose: report it as a failed fetch.
      const dropped = CONNECTION_STATUSES[status];
      if (dropped) {
        c.report(
          "http-failed",
          "",
          `Fetching ${at} failed: the server ${dropped}. HTTP ${status} is Cloudflare's code for that, not a status the server sent.${status === 520 ? ` ${BLOCKED_HINT}` : ""}`
        );
        return { ...base, maxAgeSeconds: null };
      }
      const wait = retryAfterSeconds(response.headers);
      const asks = wait === undefined ? "" : ` and asks to wait ${wait} seconds`;
      // Its bot protection answered, not the site: the validator was turned away before the site was asked.
      const service = botProtection(status, response.headers, body);
      if (service) {
        c.report(
          "http-failed",
          "",
          `Fetching ${at} failed: ${service}'s bot protection turned the validator away (HTTP ${status}), so the site wasn't asked. It would turn agents away the same way unless it lets them through. To check the document itself, validate a saved copy.`
        );
        return { ...base, maxAgeSeconds: null };
      }
      // A limit on how often we may ask, not an answer about the document.
      if (status === 429) {
        c.report("http-failed", "", `Fetching ${at} failed: the server is limiting how often it's asked (HTTP 429)${asks}. Try again later.`);
        return { ...base, maxAgeSeconds: null };
      }
      // A 404 is an answer where the protocol gives it a meaning, such as no issuer (3.2); the caller reports it.
      if (status === 404 && options.notFoundIsAnswer) return { ...base, maxAgeSeconds: null };
      if (status >= 500) {
        c.report("http-status", "", `${at} answered HTTP ${status}, a server error${asks}. Server errors are often temporary; try again later.`);
      } else if (status === 401 || status === 403) {
        c.report(
          "http-status",
          "",
          `${at} answered HTTP ${status}. If it opens in a browser, the site may be turning away automated clients or cloud addresses, which would turn agents away too.`
        );
      } else c.report("http-status", "", `${at} answered HTTP ${status}.`);
      return { ...base, maxAgeSeconds: null };
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readLimited(response, LIMITS.maxBytes, deadline.signal);
    } catch (error) {
      return failed(error);
    } finally {
      clearTimeout(timer);
    }
    if (!bytes) {
      c.report("http-too-large", "", `${at} is larger than 100 KB.`);
      return { ...base, maxAgeSeconds: null };
    }
    if (!/^application\/([\w.+-]+\+)?json\b/i.test(contentType ?? "")) {
      c.report("http-content-type", "", `${at} is served as ${contentType ?? "no Content-Type"}, not application/json.`);
    }
    const maxAgeSeconds = cacheSeconds(response.headers);
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
}

/** RFC 8414 §3.1: the well-known segment goes between the host and any path. */
export function metadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}
