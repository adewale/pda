/** One isolated workerd process group, controlled only through its parent process's IPC. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";

const [settingsFile, role] = process.argv.slice(2);
const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
let peerPort;
let runtime;
const namespaces = new Map();
let socket;
const businessRequests = [];

async function relay(request) {
  assert.ok(peerPort, "The other runtime must be connected first");
  const envelope = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers),
    body: request.body ? Buffer.from(await request.arrayBuffer()).toString("base64") : null };
  const data = await new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port: peerPort, path: "/fetch", method: "POST", headers: { "Content-Type": "application/json" } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify(envelope));
  });
  return new Response([204, 205, 304].includes(data.status) ? null : Buffer.from(data.body, "base64"), { status: data.status, headers: data.headers });
}

runtime = new Miniflare(convertV4MiniflareOptions({
  name: `pda-crash-${role}`, scriptPath: settings.script, modules: true, modulesRoot: settings.bundle,
  compatibilityDate: settings.config.compatibility_date, compatibilityFlags: settings.config.compatibility_flags,
  resourcePersistencePath: settings.persistence[role],
  bindings: settings.bindings, log: new Log(LogLevel.ERROR),
  durableObjects: Object.fromEntries(settings.config.durable_objects.bindings.map(binding => [binding.name, { className: binding.class_name, useSQLite: true, ...(binding.name === "MOCK_COMPANY" ? { unsafePreventEviction: true } : {}) }])),
  ratelimits: Object.fromEntries(settings.config.ratelimits.map(binding => [binding.name, { namespace_id: binding.namespace_id, simple: binding.simple }])),
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === "crash-barrier.test") {
      process.send({ type: "barrier", point: url.pathname.slice(1) });
      return new Promise(() => {});
    }
    const allowed = role === "company" ? url.hostname === "agent.test" : /^(?:auth\.|api\.|mcp\.|www\.|cdn\.)?crash\.shop\.test$/.test(url.hostname);
    assert.ok(allowed, "Process verification never connects to external services");
    return relay(request);
  }
}));
await runtime.ready;
const server = createServer(async (incoming, outgoing) => {
  try {
    assert.equal(incoming.url, "/fetch");
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (role === "company" && input.method === "POST") {
      const url = new URL(input.url);
      const body = input.body ? Buffer.from(input.body, "base64").toString() : "";
      let mcp;
      try { mcp = JSON.parse(body); } catch { /* OAuth form bodies aren't business writes. */ }
      if (url.pathname.endsWith("/exchanges") || mcp?.method === "tools/call") businessRequests.push({
        channel: mcp?.method === "tools/call" ? "mcp" : "openapi",
        approved: !!new Headers(input.headers).get("Poppy-Approval") || !!mcp?.params?._meta?.["personalagentprotocol.org/approval"]
      });
    }
    const response = await runtime.dispatchFetch(input.url, { method: input.method, headers: input.headers, redirect: "manual", ...(input.body ? { body: Buffer.from(input.body, "base64") } : {}) });
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ status: response.status, headers: [...response.headers], body: Buffer.from(await response.arrayBuffer()).toString("base64") }));
  } catch { outgoing.writeHead(502); outgoing.end(JSON.stringify({ error: "Local process bridge failed" })); }
});
server.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));

process.on("message", async message => {
  try {
    let value;
    if (message.action === "peer") peerPort = message.port;
    else if (message.action === "ledger") value = { pid: process.pid, businessRequests };
    else if (message.action === "authenticate") {
      const me = await runtime.dispatchFetch("https://agent.test/api/me", { headers: { Cookie: settings.cookie } });
      assert.equal(me.status, 200, "The production session verifier must accept the synthetic signed cookie");
      const { workspaceId } = await me.json();
      const response = await runtime.dispatchFetch(`https://agent.test/ws?workspace=${workspaceId}`, {
        headers: { Cookie: settings.cookie, Origin: "https://agent.test", Upgrade: "websocket" }
      });
      assert.equal(response.status, 101, "The normal authenticated WebSocket must connect");
      socket = response.webSocket;
      const connected = new Promise(resolve => socket.addEventListener("message", event => {
        if (JSON.parse(event.data).type === "poppy.cards") resolve();
      }));
      socket.accept();
      socket.send(JSON.stringify({ type: "poppy.context", locale: "en-GB", time_zone: "UTC" }));
      await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(new Error("Authenticated context frame timed out")), 10_000).unref())]);
    }
    else if (message.action === "frame") {
      assert.ok(socket, "A signed-in WebSocket is required");
      socket.send(JSON.stringify(message.frame));
    }
    else if (message.action === "call") {
      const binding = role === "company" ? "MOCK_COMPANY" : "PersonalAgent";
      let namespace = namespaces.get(binding);
      if (!namespace) namespaces.set(binding, namespace = await runtime.getDurableObjectNamespace(binding));
      const stub = namespace.getByName(message.name);
      try { value = await stub[message.method](...message.args); } finally { stub[Symbol.dispose]?.(); }
    } else throw new Error("Unknown process command");
    process.send({ type: "reply", id: message.id, value });
  } catch (error) { process.send({ type: "reply", id: message.id, error: error instanceof Error ? error.message : "Process command failed" }); }
});
process.send({ type: "ready", port: server.address().port, pid: process.pid });
