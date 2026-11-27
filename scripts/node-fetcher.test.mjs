// The CLI's fetcher (scripts/node-fetcher.ts) against Node's real HTTP parser.
// A raw socket server writes each answer byte for byte, as undici's and Node's
// own tests do, and a plain http.request hands it to settleWith: the parsing,
// the response event and the conversion are Node's and ours, while the
// fetcher's address check stays as it is (the last test shows it refuses
// loopback). Nothing here may escape as an uncaught exception: node --test
// fails the file if one does.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { addressCheckingFetcher, settleWith } from "./node-fetcher.ts";

const INVALID_STATUS = "ERR_HTTP_INVALID_STATUS_CODE";

/** Each test fails, rather than hangs, if a request is never settled. */
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);

/**
 * Serves `raw` to one request on loopback and settles the request with
 * settleWith. A request that never settles fails after 3 seconds, and the
 * server's sockets are destroyed either way, so a hang can't keep the run open.
 */
async function answer(raw, method = "GET") {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => socket.end(Buffer.from(raw, "latin1")));
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  let timer;
  try {
    const request = http.request({ host: "127.0.0.1", port: server.address().port, method, agent: false });
    const unsettled = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the request never settled")), 3000)));
    return await Promise.race([settleWith(request, method), unsettled]);
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    server.close();
  }
}

for (const status of ["999", "600", "000", "101"]) {
  test(`rejects HTTP ${status}, a status no Response can hold, instead of throwing out of the callback`, async () => {
    await assert.rejects(answer(`HTTP/1.1 ${status} X\r\nContent-Length: 2\r\n\r\nhi`), {
      code: INVALID_STATUS,
      message: `the server answered with HTTP status ${Number(status)}, which isn't a valid status`
    });
  });
}

test("rejects a switch of protocols it didn't ask for, which Node reports as an upgrade and would otherwise leave unsettled", async () => {
  await assert.rejects(answer("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nraw"), {
    code: INVALID_STATUS,
    message: "the server switched protocols (HTTP 101), which isn't an answer to this request"
  });
});

for (const status of [204, 205, 304]) {
  test(`gives HTTP ${status} no body, as Response requires of a null-body status`, async () => {
    const response = await answer(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\n\r\n`);
    assert.equal(response.status, status);
    assert.equal(response.body, null);
  });
}

test("gives a HEAD no body", async () => {
  const response = await answer("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n", "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
});

test("serves a 200's body and every header value, repeated ones included", async () => {
  const response = await answer("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 2\r\n\r\n{}");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(response.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.equal(await response.text(), "{}");
});

test("waits past an informational 103 for the final answer", async () => {
  const response = await answer("HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hi");
});

test("rejects a malformed status line with Node's parse error", async () => {
  await assert.rejects(answer("HTTP/1.1 20 Short\r\n\r\n"), { code: "HPE_INVALID_STATUS" });
});

test("still refuses a name that resolves to loopback, so the server above is reachable only through settleWith", async () => {
  const fetcher = addressCheckingFetcher(async () => [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(fetcher(new Request("https://public.example/.well-known/poppy.json")), { name: "NonPublicAddressError" });
});
