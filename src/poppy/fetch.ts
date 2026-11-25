import {
  cacheSeconds as headerCacheSeconds,
  fetchHops,
  isPublicHost,
  isWebPage,
  raceAbort,
  readLimited as readWithin,
  unreachable,
  withDeadline,
  withUserAgent,
  type Hops,
  type IdentifiedFetcher
} from "../validator/fetch.ts";
import { parseStrictJson, type Json } from "./json";
import { ProblemError, type Problem, type ProblemOrText } from "../diagnostic";

export { raceAbort, withDeadline };
export type { IdentifiedFetcher };

/** Every outbound Poppy request goes through one of these; tests swap it for the mock Company. */
export type Fetcher = (request: Request) => Promise<Response>;

/**
 * Names the agent on its Poppy requests, and nothing about its User. Without
 * one a Worker's requests carry no User-Agent, and a Company's bot protection
 * turns those away first; the validator names itself the same way.
 */
export const POPPY_USER_AGENT = "PoppyDemoAgent/1.0 (Poppy personal agent)";

/** `fetcher`, with `POPPY_USER_AGENT` on each request that doesn't already name one, discovery's included. */
export function identifiedFetcher(fetcher: Fetcher): IdentifiedFetcher {
  return withUserAgent(fetcher, POPPY_USER_AGENT);
}

/** A Company answered with something we refuse to use. */
export class PoppyFetchError extends ProblemError {
  override name = "PoppyFetchError";
  constructor(problem: ProblemOrText) {
    super(problem as Problem);
  }
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
 * Why a fetch stopped, as the error the caller sees: a `PoppyFetchError`
 * for what we refused or what a timeout ended, and what the fetcher threw
 * otherwise, unchanged.
 */
function stopError(result: Extract<Hops<unknown>, { kind: "stopped" }>, url: string): unknown {
  const at = result.at.href;
  const { stop } = result;
  switch (stop.kind) {
    case "not-https":
      return new PoppyFetchError(`Refusing non-HTTPS URL ${at}`);
    case "userinfo":
      return new PoppyFetchError(`Refusing ${at}`);
    case "non-public-host":
      return new PoppyFetchError(`Refusing to fetch non-public host ${stop.host}`);
    case "redirect-refused":
      return new PoppyFetchError(`${at} redirects (HTTP ${stop.status}) instead of serving the document`);
    case "too-many-redirects":
      return new PoppyFetchError(`Too many redirects from ${url}`);
    case "bad-redirect":
      return new PoppyFetchError(stop.target.kind === "missing" ? `Redirect without Location from ${at}` : `Redirect to something that isn't a URL from ${at}`);
    case "answered":
      return new PoppyFetchError(`${at} returned HTTP ${stop.answer.status}`);
    case "failed":
      return stop.failure.kind === "timeout" ? new PoppyFetchError(`${at}: timed out after ${stop.failure.seconds} seconds`) : stop.failure.error;
    default:
      return unreachable(stop);
  }
}

/**
 * Fetch a JSON document another party controls with `fetchHops`, the
 * validator's own fetch (HTTPS on public hosts, a few redirects, a deadline
 * per hop, HTTP 200 only), then a size cap and strict JSON.
 */
export async function fetchJson(
  fetcher: IdentifiedFetcher,
  url: string,
  options: SafeFetchOptions = {}
): Promise<FetchedJson> {
  const { maxBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...options };
  const result = await fetchHops(fetcher, new URL(url), { accept: "application/json", timeoutMs, redirects: maxRedirects }, async (response, signal) => ({
    text: await readLimited(response, maxBytes, signal),
    contentType: response.headers.get("Content-Type") ?? undefined,
    maxAgeSeconds: cacheSeconds(response)
  }));
  if (result.kind === "stopped") throw stopError(result, url);
  // The validator's classification (http-web-page): a page for people where the document should be.
  if (isWebPage(result.value.contentType, result.value.text)) throw new PoppyFetchError(`${url} answered with a web page, not a JSON document`);
  return { json: parseStrictJson(result.value.text), finalUrl: result.at.href, maxAgeSeconds: result.value.maxAgeSeconds };
}

/**
 * `fetchJson`'s fetch for a small binary document, such as a Company's logo,
 * refusing a URL with credentials in it. Returns the bytes and how long they
 * may be cached.
 */
export async function fetchBytes(
  fetcher: IdentifiedFetcher,
  url: string,
  options: SafeFetchOptions = {}
): Promise<{ readonly bytes: Uint8Array; readonly maxAgeSeconds: number | null }> {
  const { maxBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...options };
  const result = await fetchHops(
    fetcher,
    new URL(url),
    { accept: "image/png, image/jpeg, image/gif, image/webp", timeoutMs, redirects: maxRedirects, refuseUserinfo: true },
    async (response, signal) => ({ bytes: await readLimitedBytes(response, maxBytes, signal), maxAgeSeconds: cacheSeconds(response) })
  );
  if (result.kind === "stopped") throw stopError(result, url);
  return result.value;
}
