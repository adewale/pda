/** The recording, as HAR 1.2 entries, and the exchange view the checks read. */

export type HarHeader = { readonly name: string; readonly value: string };

export type HarEntry = {
  readonly startedDateTime: string;
  readonly time: number;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: readonly HarHeader[];
    readonly postData?: { readonly mimeType: string; readonly text: string; readonly encoding?: string };
  };
  readonly response: {
    readonly status: number;
    readonly headers: readonly HarHeader[];
    readonly content: { readonly mimeType: string; readonly text?: string; readonly encoding?: string };
  };
  readonly _upstream?: string | null;
  /** Set by the fault-injection proxy on exchanges it created or altered (spec §6). */
  readonly _interop?: { readonly injected?: boolean; readonly fault?: string } | null;
};

export type Har = { readonly log: { readonly entries: readonly HarEntry[] } };

/** Who sent a request, from the host it went to. */
export type Direction = "to-company" | "to-agent" | "to-runner" | "other";

export type Exchange = {
  readonly index: number;
  readonly method: string;
  readonly url: URL;
  readonly direction: Direction;
  /** The Company or agent name the host belongs to. */
  readonly peer: string | null;
  /** The runner's own probes (`runner fetch`), which no check judges. */
  readonly probe: boolean;
  /** An exchange the fault-injection proxy created or altered, never blamed on an honest side (spec §6). */
  readonly injected: boolean;
  /** The fault's action, when this exchange was altered by one. */
  readonly fault: string | null;
  readonly started: number;
  readonly ended: number;
  readonly requestHeaders: ReadonlyMap<string, string>;
  readonly requestBody: string;
  readonly status: number;
  readonly responseHeaders: ReadonlyMap<string, string>;
  readonly responseBody: string;
};

export const PROBE_HEADER = "x-interop-probe";

function headerMap(headers: readonly HarHeader[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { name, value } of headers) {
    const key = name.toLowerCase();
    map.set(key, map.has(key) ? `${map.get(key)}, ${value}` : value);
  }
  return map;
}

function text(content: { text?: string; encoding?: string } | undefined): string {
  if (!content?.text) return "";
  return content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
}

export function direction(host: string): { direction: Direction; peer: string | null } {
  const name = host.toLowerCase();
  const company = /^(?:.+\.)?([a-z0-9-]+)\.company\.interop\.test$/.exec(name);
  if (company) return { direction: "to-company", peer: company[1]! };
  const agent = /^(?:.+\.)?([a-z0-9-]+)\.agent\.interop\.test$/.exec(name);
  if (agent) return { direction: "to-agent", peer: agent[1]! };
  if (name === "runner.interop.test") return { direction: "to-runner", peer: null };
  return { direction: "other", peer: null };
}

export function exchanges(har: Har): Exchange[] {
  return har.log.entries.map((entry, index) => {
    const url = new URL(entry.request.url);
    const requestHeaders = headerMap(entry.request.headers);
    const started = Date.parse(entry.startedDateTime);
    return {
      index,
      method: entry.request.method,
      url,
      ...direction(url.hostname),
      probe: requestHeaders.has(PROBE_HEADER),
      injected: !!entry._interop?.injected,
      fault: entry._interop?.fault ?? null,
      started,
      ended: started + entry.time,
      requestHeaders,
      requestBody: text(entry.request.postData),
      status: entry.response.status,
      responseHeaders: headerMap(entry.response.headers),
      responseBody: text(entry.response.content)
    };
  });
}

/**
 * An OAuth server metadata path (RFC 8414) for any issuer, where either reading of S3 puts
 * it: inserted before the issuer's path (`/.well-known/oauth-authorization-server/poppy`) or
 * appended after it (`/poppy/.well-known/oauth-authorization-server`).
 */
export const SERVER_METADATA_PATH = /^(?:\/.*)?\/\.well-known\/oauth-authorization-server(?:\/.*)?$/;

export function isServerMetadata(exchange: Pick<Exchange, "url">): boolean {
  return SERVER_METADATA_PATH.test(exchange.url.pathname);
}

/** A form body's fields, when the request is a form POST. */
export function form(exchange: Exchange): URLSearchParams | null {
  const type = exchange.requestHeaders.get("content-type") ?? "";
  return exchange.method === "POST" && type.startsWith("application/x-www-form-urlencoded") ? new URLSearchParams(exchange.requestBody) : null;
}

export function jsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export type DecodedJwt = { readonly header: Record<string, unknown>; readonly payload: Record<string, unknown> };

/** A compact JWS's header and claims, unverified; null when it isn't one. */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    const header = decode(parts[0]!);
    const payload = decode(parts[1]!);
    const isObject = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
    if (!isObject(header) || !isObject(payload)) return null;
    return { header: header as Record<string, unknown>, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** `Authorization: <scheme> <token>`. */
export function authorization(exchange: Exchange): { scheme: string; token: string } | null {
  const value = exchange.requestHeaders.get("authorization");
  if (!value) return null;
  const space = value.indexOf(" ");
  return space === -1 ? null : { scheme: value.slice(0, space), token: value.slice(space + 1).trim() };
}
