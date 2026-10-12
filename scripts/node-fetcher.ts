/**
 * The command-line validator's fetcher, for Node, which can reach private
 * networks (Workers can't). The validator checks names (`isPublicHost`); this
 * checks addresses: it resolves each host itself, refuses a name that
 * resolves to a loopback, private, link-local or other non-public address
 * (`isPublicAddress`), and connects only to the address it checked
 * (`pinnedLookup`), so DNS rebinding can't swap it. TLS still verifies the
 * certificate against the host name. Redirects are returned, not followed:
 * the validator follows them itself, checking each hop.
 */
import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pinnedLookup, type Resolver } from "../src/validator/address.ts";
import type { Fetcher } from "../src/validator/fetch.ts";

/** Every address the system resolver gives for a name, in its own order. */
export const systemResolver: Resolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));

/** A fetcher that connects only to public addresses, resolved with `resolve` (the system's resolver by default). */
export function addressCheckingFetcher(resolve: Resolver = systemResolver): Fetcher {
  const lookup = pinnedLookup(resolve);
  return (input) =>
    new Promise<Response>((settle, reject) => {
      const url = new URL(input.url);
      if (url.protocol !== "https:") return reject(new TypeError(`${url.href} isn't HTTPS`));
      const headers: Record<string, string> = {};
      input.headers.forEach((value, name) => (headers[name] = value));
      const outgoing = httpsRequest(
        url,
        // No connection pool: each request resolves and checks its host again.
        { method: input.method, headers, lookup: lookup as never, agent: false, signal: input.signal },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(name, item);
          }
          const status = incoming.statusCode ?? 0;
          const empty = status === 204 || status === 304 || input.method === "HEAD";
          if (empty) incoming.resume();
          settle(new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers: responseHeaders }));
        }
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
}
