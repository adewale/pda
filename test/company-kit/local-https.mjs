/** Confine the upstream CLI to our local TLS fixture; retain certificate and hostname verification. */
import https from "node:https";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

export function localAgent({ port, hosts, certificate }) {
  const allowed = new Set(hosts);
  return new class extends https.Agent {
    createConnection(options, callback) {
      const host = options.hostname ?? options.host;
      if (!allowed.has(host)) {
        callback(new Error("The Company-kit fixture permits only its declared local hosts"));
        return;
      }
      return super.createConnection({ ...options, host: "127.0.0.1", port, servername: host, ca: readFileSync(certificate) }, callback);
    }
  }({ keepAlive: true });
}

export async function localFetch(agent, input, init = {}) {
  // Miniflare's Request belongs to another implementation; use its actual fields/body.
  const request = typeof input?.url === "string" ? input : new Request(input, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
      const outgoing = https.request(request.url, { agent, method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal }, response => {
        const headers = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        const empty = [204, 205, 304].includes(response.statusCode) || request.method === "HEAD";
        if (empty) response.resume();
        resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
  });
}

if (process.env.PDA_COMPANY_KIT_NETWORK) {
  const settings = JSON.parse(readFileSync(process.env.PDA_COMPANY_KIT_NETWORK, "utf8"));
  https.globalAgent = localAgent(settings);
}
