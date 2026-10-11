import { parseStrictJson, type Json } from "./json";

/** Every outbound Poppy request goes through one of these; tests swap it for the mock Company. */
export type Fetcher = (request: Request) => Promise<Response>;

/** A Company answered with something we refuse to use. */
export class PoppyFetchError extends Error {
  override name = "PoppyFetchError";
}

export type SafeFetchOptions = {
  /** Maximum response size in bytes. */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
};

const DEFAULTS = { maxBytes: 100_000, timeoutMs: 5_000, maxRedirects: 3 } as const;

/** Hosts we never fetch: IP literals, localhost and single-label names. */
export function assertPublicHost(url: URL): void {
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    !host.includes(".") ||
    /^\d+(\.\d+){3}$/.test(host) ||
    host.startsWith("[")
  ) {
    throw new PoppyFetchError(`Refusing to fetch non-public host ${host}`);
  }
}

/** Read a body up to `maxBytes`, failing beyond it. */
export async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new PoppyFetchError(`Response larger than ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new PoppyFetchError(`Response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

export type FetchedJson = {
  readonly json: Json;
  /** The URL the document was finally served from. */
  readonly finalUrl: string;
  /** Seconds the response may be cached for, from `Cache-Control`/`Expires`. */
  readonly maxAgeSeconds: number | null;
};

function cacheSeconds(response: Response): number | null {
  const control = response.headers.get("Cache-Control") ?? "";
  if (/\bno-store\b|\bno-cache\b/i.test(control)) return 0;
  const maxAge = /\bmax-age=(\d+)/i.exec(control);
  if (maxAge) return Number(maxAge[1]);
  const expires = response.headers.get("Expires");
  if (expires) {
    const at = Date.parse(expires);
    if (!Number.isNaN(at)) return Math.max(0, Math.round((at - Date.now()) / 1000));
  }
  return null;
}

/**
 * Fetch a JSON document another party controls: HTTPS only, a few redirects
 * (each HTTPS), a size cap and a timeout, no credentials, no private hosts
 * (Guides, "Fetching metadata safely"), and strict JSON.
 */
export async function fetchJson(
  fetcher: Fetcher,
  url: string,
  options: SafeFetchOptions = {}
): Promise<FetchedJson> {
  const { maxBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...options };
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "https:") {
      throw new PoppyFetchError(`Refusing non-HTTPS URL ${current.href}`);
    }
    assertPublicHost(current);
    const response = await fetcher(
      new Request(current.href, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
      })
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location) throw new PoppyFetchError(`Redirect without Location from ${current.href}`);
      if (hop >= maxRedirects) throw new PoppyFetchError(`Too many redirects from ${url}`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PoppyFetchError(`${current.href} returned HTTP ${response.status}`);
    }
    const text = await readLimited(response, maxBytes);
    return {
      json: parseStrictJson(text),
      finalUrl: current.href,
      maxAgeSeconds: cacheSeconds(response)
    };
  }
}
