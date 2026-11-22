/**
 * The command-line validator's fetcher, for Node, which can reach private
 * networks (Workers can't). The validator checks names (`isPublicHost`); this
 * checks addresses: it resolves each host itself, refuses a name that
 * resolves to a loopback, private, link-local or other non-public address
 * (`isPublicAddress`), and connects only to the address it checked
 * (`pinnedLookup`), so DNS rebinding can't swap it. TLS still verifies the
 * certificate against the host name. Redirects are returned, not followed:
 * the validator follows them itself, checking each hop.
 *
 * Only the CLI uses this: the hosted validator and the agent run on Workers,
 * whose `fetch` does all of this itself (and reports what Node throws as
 * Cloudflare's own statuses: 526 for a certificate, 530 for a name that
 * doesn't resolve or resolves to a private address).
 */
import { promises as dns } from "node:dns";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pinnedLookup, type Resolver } from "../src/validator/address.ts";
import { INVALID_STATUS, type Fetcher } from "../src/validator/fetch.ts";

/** Every address the system resolver gives for a name, in its own order. */
export const systemResolver: Resolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));

/** Statuses whose response has no body (Fetch: "null body status"), which `Response` refuses one for; 101 and 103 never get here. */
const NULL_BODY = new Set([204, 205, 304]);

/** What a fetcher rejects with for a status no `Response` can hold, reported as `invalid-status` (src/validator/fetch.ts). */
function invalidStatus(message: string): RangeError {
  return Object.assign(new RangeError(message), { code: INVALID_STATUS });
}

/**
 * Node's response as a `Response`, or a throw. Node's parser takes any three
 * digits as a status, and a `Response` holds only 200 to 599, with no body
 * for a null-body status or a HEAD.
 */
export function responseFrom(incoming: IncomingMessage, method: string): Response {
  const status = incoming.statusCode ?? 0;
  if (status < 200 || status > 599) throw invalidStatus(`the server answered with HTTP status ${status}, which isn't a valid status`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
  }
  const empty = NULL_BODY.has(status) || method === "HEAD";
  const response = new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers });
  if (empty) incoming.resume();
  return response;
}

/**
 * Sends `outgoing` and settles with its response. Nothing can escape the
 * promise: a response `responseFrom` can't convert rejects, as does a switch
 * of protocols we didn't ask for (Node reports that as `upgrade`, not as a
 * response, and with no listener would close the socket and settle nothing),
 * and every error rejects, including one after the promise has settled.
 */
export function settleWith(outgoing: ClientRequest, method: string): Promise<Response> {
  return new Promise<Response>((settle, reject) => {
    outgoing.once("response", (incoming) => {
      try {
        settle(responseFrom(incoming, method));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    outgoing.once("upgrade", (_incoming, socket) => {
      socket.destroy();
      reject(invalidStatus("the server switched protocols (HTTP 101), which isn't an answer to this request"));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** A fetcher that connects only to public addresses, resolved with `resolve` (the system's resolver by default). */
export function addressCheckingFetcher(resolve: Resolver = systemResolver): Fetcher {
  const lookup = pinnedLookup(resolve);
  return async (input) => {
    const url = new URL(input.url);
    if (url.protocol !== "https:") throw new TypeError(`${url.href} isn't HTTPS`);
    const headers: Record<string, string> = {};
    input.headers.forEach((value, name) => (headers[name] = value));
    // No connection pool: each request resolves and checks its host again.
    return settleWith(httpsRequest(url, { method: input.method, headers, lookup: lookup as never, agent: false, signal: input.signal }), input.method);
  };
}
