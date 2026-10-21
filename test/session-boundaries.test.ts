import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BROWSER_SESSION_HEADER, BrowserSessions } from "../src/browser-sessions";
import { verifySession } from "../src/session";
import { agent, authenticatedWsRequest, chat, connect, fetchWorker, follow, ORIGIN, sessionCookie, until, wsRequest } from "./agent-helpers";

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
}

async function logout(cookie: string) {
  return fetchWorker(new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie } }));
}

describe("application browser session boundaries", () => {
  it("refuses legacy sockets without an explicit nonempty workspace after an account switch", async () => {
    const a = await agent();
    const b = await agent();
    const bootstrap = await authenticatedWsRequest({ cookie: a.cookie });
    expect(new URL(bootstrap.url).searchParams.get("workspace")).toBe(a.stub.id.toString());
    // Old running JavaScript has no workspace binding. It must not reconnect
    // under a replacement browser cookie and replay its old private outbox.
    for (const query of ["", "?workspace="]) {
      expect((await fetchWorker(wsRequest({ cookie: b.cookie, query }))).status).toBe(401);
    }
    expect((await fetchWorker(await authenticatedWsRequest({ cookie: b.cookie, query: `?workspace=${a.stub.id}` }))).status).toBe(401);
    const current = await fetchWorker(await authenticatedWsRequest({ cookie: b.cookie }));
    expect(current.status).toBe(101);
    current.webSocket!.accept();
    current.webSocket!.close();
  });

  it("binds an existing tab's WebSocket to its authenticated workspace across account changes", async () => {
    const a = await agent();
    const b = await agent();
    const me = await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: a.cookie } }));
    const { workspaceId } = await me.json() as { workspaceId: string };
    expect(workspaceId).toBe(a.stub.id.toString());
    const requestFor = (cookie: string) => {
      const request = wsRequest({ cookie });
      const url = new URL(request.url);
      url.searchParams.set("workspace", workspaceId);
      return new Request(url, request);
    };
    // A fresh valid cookie for a different actor must not route this old tab there.
    expect((await fetchWorker(requestFor(b.cookie))).status).toBe(401);
    const response = await fetchWorker(requestFor(a.cookie));
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    response.webSocket!.close();
  });

  it("revokes a copied cookie and its connected socket on logout", async () => {
    const a = await agent();
    const { socket, client } = await connect(a.cookie);
    try {
      await chat(socket, client, "Before logout");
      const ended = closed(socket);
      expect((await logout(a.cookie)).status).toBe(303);
      expect((await ended).code).toBe(1008);
      expect((await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: a.cookie } }))).status).toBe(401);
      expect((await fetchWorker(wsRequest({ cookie: a.cookie }))).status).toBe(401);
    } finally { socket.close(); }
  });

  it("rejects an already authenticated upload whose body arrives after logout", async () => {
    const a = await agent();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: "image/jpeg" }), "PRIVATE_PHOTO.jpg");
    const encoded = new Request(ORIGIN, { method: "POST", body: form });
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      entered(); await wait; controller.enqueue(bytes); controller.close();
    } }, { highWaterMark: 0 });
    const pending = fetchWorker(new Request(`${ORIGIN}/api/attachments`, {
      method: "POST", headers: { Cookie: a.cookie, Origin: ORIGIN,
        "Content-Type": encoded.headers.get("Content-Type")!, "Content-Length": String(bytes.byteLength) }, body
    }));
    try {
      await ready;
      expect((await logout(a.cookie)).status).toBe(303);
      release();
      expect((await pending).status).toBe(401);
      expect(JSON.parse(await a.stub.poppySql("SELECT name FROM attachments"))).toEqual([]);
    } finally { release(); await pending; }
  });

  it("keeps another login session for the same person usable", async () => {
    const a = await agent();
    const sibling = await sessionCookie(a.identity);
    const first = await connect(a.cookie);
    const second = await connect(sibling);
    try {
      const ended = closed(first.socket);
      expect((await logout(a.cookie)).status).toBe(303);
      expect((await ended).code).toBe(1008);
      expect((await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: sibling } }))).status).toBe(200);
      await chat(second.socket, second.client, "Sibling login still works");
    } finally { first.socket.close(); second.socket.close(); }
  });

  it("overwrites a spoofed internal session header and rejects header-only authentication", async () => {
    const a = await agent();
    const sibling = await sessionCookie(a.identity);
    // Register and revoke the first session before trying to substitute its id.
    expect((await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: a.cookie } }))).status).toBe(200);
    const identity = await verifySession(new Request(ORIGIN, { headers: { Cookie: a.cookie } }), env.SESSION_SECRET);
    await logout(a.cookie);
    const request = await authenticatedWsRequest({ cookie: sibling });
    request.headers.set(BROWSER_SESSION_HEADER, identity.sessionId);
    const response = await fetchWorker(request);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const client = follow(socket);
    try {
      await client.until(() => client.frames.some(frame => frame.type === "events"));
      await chat(socket, client, "Header cannot select a revoked session");
      const unauthenticated = wsRequest();
      unauthenticated.headers.set(BROWSER_SESSION_HEADER, identity.sessionId);
      expect((await fetchWorker(unauthenticated)).status).toBe(401);
      const replay = wsRequest({ cookie: a.cookie });
      const goodIdentity = await verifySession(new Request(ORIGIN, { headers: { Cookie: sibling } }), env.SESSION_SECRET);
      replay.headers.set(BROWSER_SESSION_HEADER, goodIdentity.sessionId);
      expect((await fetchWorker(replay)).status).toBe(401);
    } finally { socket.close(); }
  });

  it("denies unsolicited outbound data once the stored authentication expires", async () => {
    const a = await agent();
    const { socket, client } = await connect(a.cookie);
    try {
      const ended = closed(socket);
      await runInDurableObject(a.stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE browser_sessions SET expires_at = ?", Date.now() - 1);
        for (const connection of state.getWebSockets()) connection.send(JSON.stringify({ type: "private-after-expiry", text: "must not leave" }));
      });
      expect((await ended).code).toBe(1008);
      expect(client.frames.some(frame => frame.type === "private-after-expiry")).toBe(false);
    } finally { socket.close(); }
  });

  it("reconstructs authorization from durable tags and rows before reattaching sockets", async () => {
    const a = await agent();
    const { socket, client } = await connect(a.cookie);
    try {
      await runInDurableObject(a.stub, (_instance, state) => {
        // Reconstruct only this capability; no whole-runtime reset in this suite.
        const recovered = new BrowserSessions(state, () => true);
        recovered.onStart();
        for (const connection of state.getWebSockets()) connection.send(JSON.stringify({ type: "authorized-after-recovery" }));
      });
      await client.until(() => client.frames.some(frame => frame.type === "authorized-after-recovery"));
      const ended = closed(socket);
      await runInDurableObject(a.stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE browser_sessions SET revoked = 1");
        new BrowserSessions(state, () => true).onStart();
      });
      expect((await ended).code).toBe(1008);
    } finally { socket.close(); }
  });
});
