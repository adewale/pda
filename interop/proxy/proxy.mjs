/**
 * The recording proxy (interop spec section 3). It terminates TLS for every
 * *.interop.test name with the run's certificate, forwards each request over
 * plain HTTP to the implementation's container on port 8080, and keeps every
 * exchange, in full, as a HAR entry for the current cell.
 *
 * A control server on port 8082 (plain HTTP, reached only by the runner):
 *   GET  /healthz            200 once both servers listen
 *   POST /cell {id}          start a new cell: forget earlier entries
 *   GET  /har                the current cell's HAR
 *   POST /control {target, method, path, body, headers}
 *                            forward a control call to target:8081 (not recorded)
 *   POST /fetch {method, url, headers, body}
 *                            a raw request through the proxy, recorded like any other
 *
 * No dependencies: Node's own http, https and tls.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { upstreamFor } from "./routing.mjs";

const DIR = process.env.INTEROP_CERT_DIR ?? "/interop";
const CONTROL_PORT = Number(process.env.INTEROP_CONTROL_PORT ?? "8082");
const TLS_PORT = Number(process.env.INTEROP_TLS_PORT ?? "443");
const UPSTREAM_PORT = 8080;
const CONTROL_UPSTREAM_PORT = 8081;

const ca = fs.readFileSync(`${DIR}/ca.pem`);
const key = fs.readFileSync(`${DIR}/proxy.key`);
const cert = fs.readFileSync(`${DIR}/proxy.pem`);

/** The current cell's entries, in the order requests arrived. */
let entries = [];
let cell = null;

function headerList(headers) {
  const list = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const one of Array.isArray(value) ? value : [value]) list.push({ name, value: String(one) });
  }
  return list;
}

/**
 * Undo Content-Encoding (workerd, for one, answers `br` when asked), so checks read the JSON the
 * Company meant. An encoding that won't decode leaves the bytes as they came.
 */
function decode(buffer, encoding) {
  const codings = String(encoding ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item && item !== "identity");
  try {
    for (const coding of codings.reverse()) {
      if (coding === "br") buffer = zlib.brotliDecompressSync(buffer);
      else if (coding === "gzip" || coding === "x-gzip") buffer = zlib.gunzipSync(buffer);
      else if (coding === "deflate") buffer = zlib.inflateSync(buffer);
      else return buffer;
    }
  } catch {
    // Keep the raw bytes.
  }
  return buffer;
}

/** Body text for HAR: UTF-8 when it decodes, else base64. */
function content(buffer) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return { text: buffer.toString("base64"), encoding: "base64" };
  }
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** One HAR entry, filled in as the response streams back. */
function startEntry(req, url, body) {
  const started = Date.now();
  const mime = req.headers["content-type"] ?? "";
  const entry = {
    startedDateTime: new Date(started).toISOString(),
    time: 0,
    request: {
      method: req.method,
      url: url.href,
      httpVersion: `HTTP/${req.httpVersion}`,
      cookies: [],
      headers: headerList(req.headers),
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
      headersSize: -1,
      bodySize: body.length,
      ...(body.length > 0 ? { postData: { mimeType: mime, ...content(body) } } : {})
    },
    response: {
      status: 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 0
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _cell: cell,
    _upstream: null,
    _complete: false
  };
  entries.push(entry);
  return { entry, started };
}

function finishEntry(entry, started, status, headers, chunks) {
  const body = Buffer.concat(chunks);
  entry.time = Date.now() - started;
  entry.timings.wait = entry.time;
  entry.response.status = status;
  entry.response.statusText = http.STATUS_CODES[status] ?? "";
  entry.response.headers = headerList(headers);
  entry.response.redirectURL = String(headers.location ?? "");
  entry.response.bodySize = body.length;
  // HAR 1.2: content.text is the decoded body; bodySize stays the bytes on the wire.
  const decoded = decode(body, headers["content-encoding"]);
  entry.response.content = { size: decoded.length, mimeType: String(headers["content-type"] ?? ""), ...content(decoded) };
  entry._complete = true;
}

async function handle(req, res) {
  const host = req.headers.host ?? "";
  const url = new URL(req.url ?? "/", `https://${host}`);
  const body = await readBody(req);
  const { entry, started } = startEntry(req, url, body);

  if (url.hostname === "runner.interop.test") {
    const reply = Buffer.from(JSON.stringify({ ok: true, url: url.href }));
    const headers = { "content-type": "application/json", "content-length": String(reply.length) };
    res.writeHead(200, headers);
    res.end(reply);
    finishEntry(entry, started, 200, headers, [reply]);
    return;
  }
  const upstream = upstreamFor(host);
  if (!upstream) {
    const reply = Buffer.from(`No implementation serves ${host}`);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(reply);
    finishEntry(entry, started, 502, { "content-type": "text/plain" }, [reply]);
    return;
  }
  entry._upstream = upstream;
  const headers = { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-host": host };
  delete headers.connection;
  const outbound = http.request(
    { host: upstream, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      const chunks = [];
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      res.flushHeaders?.();
      upstreamRes.on("data", (chunk) => {
        chunks.push(chunk);
        res.write(chunk);
      });
      const done = () => {
        if (entry._complete) return;
        finishEntry(entry, started, upstreamRes.statusCode ?? 502, upstreamRes.headers, chunks);
        res.end();
      };
      upstreamRes.on("end", done);
      upstreamRes.on("close", done);
      // The client went away mid-stream (an SSE reader that has what it needs).
      res.on("close", () => {
        if (!entry._complete) {
          finishEntry(entry, started, upstreamRes.statusCode ?? 502, upstreamRes.headers, chunks);
          upstreamRes.destroy();
        }
      });
    }
  );
  outbound.on("error", (error) => {
    if (entry._complete) return;
    const reply = Buffer.from(`Upstream ${upstream} failed: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(reply);
    finishEntry(entry, started, 502, { "content-type": "text/plain" }, [reply]);
  });
  outbound.end(body);
}

const tlsServer = https.createServer({ key, cert, ca }, (req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(error));
  });
});

function har() {
  return {
    log: {
      version: "1.2",
      creator: { name: "poppy-interop-proxy", version: "1" },
      pages: [],
      entries: entries.map((entry) => ({ ...entry }))
    }
  };
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** A control call to an adapter: forwarded as is, never recorded. */
function control(target, method, path, headers, body) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: target, port: CONTROL_UPSTREAM_PORT, method, path, headers: { ...headers, "content-type": "application/json" } },
      async (response) => {
        const text = (await readBody(response)).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: text });
      }
    );
    request.setTimeout(180_000, () => request.destroy(new Error("timeout")));
    request.on("error", (error) => resolve({ status: 0, body: "", error: error.message }));
    request.end(body ?? undefined);
  });
}

/** A raw request through the TLS server, so it is recorded like the implementations' own. */
function selfFetch({ method = "GET", url, headers = {}, body }) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const request = https.request(
      {
        host: "127.0.0.1",
        port: TLS_PORT,
        servername: target.hostname,
        method,
        path: `${target.pathname}${target.search}`,
        headers: { host: target.host, ...headers },
        ca
      },
      async (response) => {
        const text = (await readBody(response)).toString("utf8");
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text });
      }
    );
    request.setTimeout(30_000, () => request.destroy(new Error("timeout")));
    request.on("error", (error) => resolve({ status: 0, headers: {}, body: "", error: error.message }));
    request.end(body ?? undefined);
  });
}

const controlServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://control");
    const text = (await readBody(req)).toString("utf8");
    const json = text ? JSON.parse(text) : {};
    if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/cell") {
      entries = [];
      cell = typeof json.id === "string" ? json.id : null;
      return sendJson(res, 200, { cell });
    }
    if (req.method === "GET" && url.pathname === "/har") return sendJson(res, 200, har());
    if (req.method === "POST" && url.pathname === "/control") {
      return sendJson(res, 200, await control(json.target, json.method ?? "GET", json.path ?? "/", json.headers ?? {}, json.body));
    }
    if (req.method === "POST" && url.pathname === "/fetch") return sendJson(res, 200, await selfFetch(json));
    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(res, 500, { error: "proxy_error", detail: String(error) });
  }
});

tlsServer.listen(TLS_PORT, () => console.log(`proxy: TLS on ${TLS_PORT}`));
controlServer.listen(CONTROL_PORT, () => console.log(`proxy: control on ${CONTROL_PORT}`));
