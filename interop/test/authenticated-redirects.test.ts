import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { CheckedApiRequest } from "../../src/poppy/apis.ts";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client.ts";
import type { Company } from "../../src/poppy/discovery.ts";
import { toIssuer } from "../../src/poppy/issuer.ts";
import { sha256 } from "../../src/poppy/jwt.ts";
import { EndpointRequest } from "../../src/poppy/outgoing.ts";
import { migrate } from "../../src/poppy/store.ts";
import { memorySql } from "../impls/pda-agent/sqlite.ts";

const ISSUER = "https://auth.books.example";
const ORIGIN = "https://api.books.example";
const CLIENT_ID = "https://agent.example/poppy/client.json";
type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: string };
const kinds = ["token", "device", "revocation", "api", "authorize", "conversations", "feedback", "mcp"] as const;
type Kind = typeof kinds[number];

/**
 * Real fetch redirect handling on an isolated loopback HTTP server. Only the
 * injected transport maps public HTTPS fixture URLs to loopback; application
 * Requests and their signed public URLs are unchanged. The server verifies the
 * real client assertion or delegated Session JWT before answering or redirecting.
 */
async function fixture(redirect: boolean) {
  const signing = await generateKeyPair("ES256", { extractable: true });
  const source: Seen[] = [], sink: Seen[] = [], errors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const seen = { method: request.method!, path: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      if (seen.path === "/sink") { sink.push(seen); response.setHeader("Content-Type", "application/json"); response.end("{}"); return; }
      if (seen.path === "/openapi.json") {
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["poppy-session"]).toBeUndefined();
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          openapi: "3.1.0", servers: [{ url: ORIGIN }], security: [{ account: [] }],
          components: { securitySchemes: { account: { type: "http", scheme: "bearer" } } },
          paths: { "/orders": { post: { operationId: "createOrder", requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: "string" } } } } } }, responses: { "200": { description: "Created" } } } } }
        }));
        return;
      }
      source.push(seen);
      if (["/token", "/device", "/revoke"].includes(seen.path)) {
        expect(seen.headers["poppy-session"]).toBeUndefined();
        const fields = new URLSearchParams(seen.body);
        expect(fields.get("client_id")).toBe(CLIENT_ID);
        expect(fields.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
        await jwtVerify(fields.get("client_assertion")!, signing.publicKey, { issuer: CLIENT_ID, subject: CLIENT_ID, audience: ISSUER, algorithms: ["ES256"] });
      } else {
        expect(seen.headers.authorization).toBe("Bearer account-access");
        const jwt = seen.headers["poppy-session"];
        expect(typeof jwt).toBe("string");
        const header = decodeProtectedHeader(jwt as string);
        const delegation = await jwtVerify(header.pap_dlg as string, signing.publicKey, { issuer: CLIENT_ID, typ: "pap-delegation+jwt", algorithms: ["ES256"] });
        const jwk = (delegation.payload.cnf as { jwk: JWK }).jwk;
        const session = await jwtVerify(jwt as string, await importJWK(jwk, "ES256"), { issuer: CLIENT_ID, audience: ISSUER, typ: "poppy-session+jwt", algorithms: ["ES256"] });
        expect(session.payload.htm).toBe(seen.method);
        expect(session.payload.htu).toBe(`${ORIGIN}${seen.path}`);
        expect(session.payload.ath).toBe(await sha256("account-access"));
      }
      if (redirect) { response.statusCode = 307; response.setHeader("Location", "/sink"); response.end(); }
      else { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ access_token: "unused-new-access", token_type: "Bearer", expires_in: 3600 })); }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      response.statusCode = 500;
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback transport address");
  const transport = `http://127.0.0.1:${address.port}`;
  const sql = memorySql();
  migrate(sql);
  const host: PoppyHost = {
    env: {
      PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Redirect test", POPPY_LOGO_URI: "https://agent.example/logo.svg",
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"), POPPY_SIGNING_JWKS: JSON.stringify([{ ...await exportJWK(signing.privateKey), kid: "redirect-test" }]),
      CompanyLimiter: { getByName: () => ({ delay: async () => 0, observe: async () => {}, blockUntil: async () => {} }) }
    } as unknown as Env,
    sql, fetcher: async (request) => {
      const publicUrl = new URL(request.url);
      if (!["auth.books.example", "api.books.example"].includes(publicUrl.hostname)) throw new Error("Unexpected public fixture host");
      // Materialize the unchanged bytes, as these small JSON/form requests are
      // replayable by an HTTP redirect implementation (a ReadableStream isn't).
      const body = request.body ? await request.arrayBuffer() : undefined;
      return fetch(new Request(`${transport}${publicUrl.pathname}${publicUrl.search}`, {
        method: request.method, headers: request.headers, redirect: request.redirect, signal: request.signal,
        ...(body ? { body } : {})
      }));
    },
    showCard: async () => {}, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false,
    pushDirect: () => {}, userContext: () => ({ user_available: true }), sleep: async () => {}, now: () => Date.now()
  };
  const company: Company = {
    issuer: toIssuer(ISSUER), domain: "books.example", name: "Books", protocolVersion: "0.3",
    endpoints: { token: `${ISSUER}/token`, revocation: `${ISSUER}/revoke`, deviceAuthorization: `${ISSUER}/device` }, signIn: {}, customScopes: {}, extensions: {},
    conversations: { endpoint: `${ORIGIN}/conversations` }, web: { browserSessionEndpoint: `${ORIGIN}/browser-session` }, feedback: { endpoint: `${ORIGIN}/feedback` },
    apis: [{ type: "openapi", url: `${ORIGIN}/openapi.json`, description: "Books API" }, { type: "mcp", url: `${ORIGIN}/mcp`, description: "Books MCP" }]
  };
  const client = new PoppyClient(host);
  await client.completeSignIn(company, "main", "default", { access_token: "account-access", token_type: "Bearer", expires_in: 3600, refresh_token: "held-refresh", scope: "orders:write" });
  return {
    source, sink, errors, client, company,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

async function exercise(f: Awaited<ReturnType<typeof fixture>>, kind: Kind) {
  const { client, company } = f;
  if (kind === "token") return client.oauthRequest(company, company.endpoints.token, async () => ({ grant_type: "refresh_token", refresh_token: "held-refresh" }), { dpop: false });
  if (kind === "device") return client.oauthRequest(company, company.endpoints.deviceAuthorization!, async () => ({ scope: "orders:write" }), { dpop: false });
  if (kind === "revocation") return client.oauthRequest(company, company.endpoints.revocation, async () => ({ token: "held-refresh", token_type_hint: "refresh_token" }), { dpop: false });
  const body = { text: "Private source request", code: "browser-one-time-code" };
  const outgoing = kind === "api" ? await CheckedApiRequest.check(client, company, { operation: "createOrder", body: { note: "Private source request" } })
    : kind === "mcp" ? EndpointRequest.mcp(company, { method: "POST", url: `${ORIGIN}/mcp`, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: body } })
      : EndpointRequest.to(company, { method: "POST", url: `${ORIGIN}/${kind === "authorize" ? "browser-session/authorize" : kind}`, body });
  // The test authorizes this one fixture call; production approvals still enter through their own guard.
  return client.resource(company, outgoing, { beforeDispatch: () => { expect(client.session(company.issuer, "main")?.account).toBe("default"); } });
}

describe("authenticated endpoint redirects through the actual HTTP transport", () => {
  it.each(kinds)("does not forward %s credentials or its POST body to a 307 sink", async (kind) => {
    const f = await fixture(true);
    try {
      const answer = await exercise(f, kind);
      expect(f.errors).toEqual([]);
      expect(f.source).toHaveLength(1);
      expect(f.source[0]!.method).toBe("POST");
      expect(f.source[0]!.body).not.toBe("");
      expect(f.sink.map((seen) => ({
        method: seen.method,
        hasSession: !!seen.headers["poppy-session"], hasAuthorization: !!seen.headers.authorization,
        hasRefreshToken: seen.body.includes("held-refresh"), hasClientAssertion: seen.body.includes("client_assertion="),
        hasPrivateBody: seen.body.includes("Private source request") || seen.body.includes("browser-one-time-code")
      }))).toEqual([]);
      expect(answer.status).toBe(307);
    } finally { await f.close(); }
  });

  it.each(kinds)("still authenticates and sends the unchanged %s endpoint successfully", async (kind) => {
    const f = await fixture(false);
    try {
      expect((await exercise(f, kind)).status).toBe(200);
      expect(f.errors).toEqual([]);
      expect(f.source).toHaveLength(1);
      expect(f.source[0]!.method).toBe("POST");
      expect(f.sink).toEqual([]);
    } finally { await f.close(); }
  });
});
