/**
 * Fetching a document someone else controls, the way the Guides ask
 * ("Fetching metadata safely"): HTTPS only, a few redirects (each HTTPS), a
 * size cap, a timeout, no credentials, no private hosts. Problems become
 * messages on the document's checker rather than exceptions, so the report
 * says what went wrong.
 */
import type { Checker } from "./primitives.ts";

export type Fetcher = (request: Request) => Promise<Response>;

export const LIMITS = { maxBytes: 100_000, timeoutMs: 5_000, maxRedirects: 3 } as const;

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

/** Literal IPs, localhost and single-label names: never fetched. */
export function isPublicHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    !host.includes(".") ||
    /^\d+(\.\d+){3}$/.test(host) ||
    host.startsWith("[")
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

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get("Content-Length") ?? "0") > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
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
    let response: Response;
    try {
      response = await fetcher(
        new Request(at, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(LIMITS.timeoutMs)
        })
      );
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out after 5 seconds" : "failed";
      c.report("http-failed", "", `Fetching ${at} ${reason}.`);
      return { url, finalUrl: at, maxAgeSeconds: null };
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await response.body?.cancel();
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
      await response.body?.cancel();
      c.report("http-status", "", `${at} answered HTTP ${response.status}.`);
      return { ...base, maxAgeSeconds: null };
    }
    const bytes = await readLimited(response, LIMITS.maxBytes);
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
