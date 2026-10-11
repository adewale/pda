/**
 * Node's http server in front of a fetch-style handler, for our adapters.
 * Behind the recording proxy a request arrives as plain HTTP with the
 * original `Host` and `X-Forwarded-Proto: https`; the handler sees the URL
 * the caller used, `https://<host><path>`.
 */
import http from "node:http";

export type Handler = (request: Request) => Promise<Response>;

const SKIPPED = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);

export function requestUrl(req: http.IncomingMessage): string {
  const host = String(req.headers.host ?? "localhost");
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}${req.url ?? "/"}`;
}

async function toRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || SKIPPED.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && chunks.length > 0;
  return new Request(requestUrl(req), {
    method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {})
  });
}

async function send(response: Response, res: http.ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name === "set-cookie") return;
    headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let closed = false;
  res.on("close", () => {
    closed = true;
    reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      res.write(value);
    }
  } catch {
    // The client went away mid-stream.
  }
  res.end();
}

export function serve(port: number, handler: Handler): http.Server {
  const server = http.createServer((req, res) => {
    toRequest(req)
      .then(handler)
      .then((response) => send(response, res))
      .catch((error: unknown) => {
        console.error("adapter error", error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "adapter_error", detail: String(error) }));
      });
  });
  server.listen(port, "0.0.0.0");
  return server;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An error as the interop spec words it (section 5): `{error, detail}`. */
export function failure(status: number, error: string, detail: string): Response {
  return json({ error, detail }, status);
}

/** Control requests carry `Authorization: Bearer <INTEROP_SECRET>` (spec 5). */
export function authorized(request: Request, secret: string): boolean {
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** A required environment variable. */
export function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
