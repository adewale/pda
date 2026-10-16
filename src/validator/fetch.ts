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
  options: { followRedirects?: boolean } = {}
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
      const reason = error instanceof Error && error.name === "TimeoutError" ? `timed out after ${LIMITS.timeoutMs / 1000} seconds` : "failed";
      c.report("http-failed", "", `Fetching ${at} ${reason}.`);
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
    // Only a 200 has its body read; nothing else needs the deadline after this.
    if (response.status !== 200) clearTimeout(timer);
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
      current = new URL(location, current);
      continue;
    }
    const contentType = response.headers.get("Content-Type") ?? undefined;
    const base = { url, finalUrl: at, status: response.status, ...(contentType ? { contentType } : {}) };
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      c.report("http-status", "", `${at} answered HTTP ${response.status}.`);
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
