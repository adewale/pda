import {
  cacheSeconds as headerCacheSeconds,
  isPublicHost,
  raceAbort,
  readLimited as readWithin,
  withDeadline
} from "../validator/fetch.ts";
import { parseStrictJson, type Json } from "./json";

export { raceAbort, withDeadline };

/** Every outbound Poppy request goes through one of these; tests swap it for the mock Company. */
export type Fetcher = (request: Request) => Promise<Response>;

/** A Company answered with something we refuse to use. */
export class PoppyFetchError extends Error {
  override name = "PoppyFetchError";
}

export type SafeFetchOptions = {
  /** Maximum response size in bytes. */
  readonly maxBytes?: number;
  /** One deadline for each hop: the response and its body. */
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
};

// The same 10 s as the validator's discovery fetches (src/validator/fetch.ts LIMITS).
const DEFAULTS = { maxBytes: 100_000, timeoutMs: 10_000, maxRedirects: 3 } as const;

/**
 * How long the client waits on a Company. A token or revocation request,
 * answer and body together, gets `oauthMs`; an API, conversation or
 * operations request gets `requestMs` for its answer to start (a long poll
 * adds its own wait), then `bodyMs` to read the body.
 */
export type PoppyTimeouts = { readonly oauthMs: number; readonly requestMs: number; readonly bodyMs: number };

export const POPPY_TIMEOUTS: PoppyTimeouts = { oauthMs: 15_000, requestMs: 30_000, bodyMs: 30_000 };

/** Hosts we never fetch: IP literals, single-label names, and special-use and private-use names (`isPublicHost`). Workers refuse private addresses a public name resolves to. */
export function assertPublicHost(url: URL): void {
  if (!isPublicHost(url)) {
    throw new PoppyFetchError(`Refusing to fetch non-public host ${url.hostname.toLowerCase().replace(/\.$/, "")}`);
  }
}

/**
 * Read a body up to `maxBytes`, failing beyond it, if it isn't UTF-8, or if
 * `signal` aborts first (with the signal's reason). Without a signal, the
 * read gets `POPPY_TIMEOUTS.bodyMs`, and running out is a `PoppyFetchError`.
 */
export async function readLimited(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const bytes = await readLimitedBytes(response, maxBytes, signal);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PoppyFetchError("Response isn't UTF-8");
  }
}

/** `readLimited`'s bytes, for a body that may not be UTF-8 (a web page). */
export async function readLimitedBytes(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const read = (within: AbortSignal) => readWithin(response, maxBytes, within);
  const bytes = await (signal
    ? read(signal)
    : withDeadline(POPPY_TIMEOUTS.bodyMs, read).catch((error: unknown) => {
        throw timeoutError(error, "Reading the response");
      }));
  if (!bytes) throw new PoppyFetchError(`Response larger than ${maxBytes} bytes`);
  return bytes;
}

export type FetchedJson = {
  readonly json: Json;
  /** The URL the document was finally served from. */
  readonly finalUrl: string;
  /** Seconds the response may be cached for, from `Cache-Control`/`Expires`. */
  readonly maxAgeSeconds: number | null;
};

export function cacheSeconds(response: Response): number | null {
  return headerCacheSeconds(response.headers);
}

/** A request that timed out, as a `PoppyFetchError`; anything else unchanged. */
export function timeoutError(error: unknown, url: string): unknown {
  return error instanceof Error && error.name === "TimeoutError" ? new PoppyFetchError(`${url}: ${error.message.toLowerCase()}`) : error;
}

/**
 * Fetch a JSON document another party controls: HTTPS only, a few redirects
 * (each HTTPS), a size cap and a timeout over the answer and its body, no
 * credentials, no private hosts (Guides, "Fetching metadata safely"), and
 * strict JSON.
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
    const at = current;
    const answer = await withDeadline(timeoutMs, async (signal) => {
      const response = await raceAbort(
        fetcher(new Request(at.href, { method: "GET", headers: { Accept: "application/json" }, redirect: "manual", signal })),
        signal
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { redirect: response.headers.get("Location") } as const;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PoppyFetchError(`${at.href} returned HTTP ${response.status}`);
      }
      return { text: await readLimited(response, maxBytes, signal), maxAgeSeconds: cacheSeconds(response) } as const;
    }).catch((error: unknown) => {
      throw timeoutError(error, at.href);
    });
    if ("redirect" in answer) {
      if (!answer.redirect) throw new PoppyFetchError(`Redirect without Location from ${current.href}`);
      if (hop >= maxRedirects) throw new PoppyFetchError(`Too many redirects from ${url}`);
      current = new URL(answer.redirect, current);
      continue;
    }
    return {
      json: parseStrictJson(answer.text),
      finalUrl: current.href,
      maxAgeSeconds: answer.maxAgeSeconds
    };
  }
}
