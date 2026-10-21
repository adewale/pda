import { describe, expect, it } from "vitest";
import { world } from "./client-fixture";
import { listMcpTools } from "../../src/poppy/apis";
import { PoppyClient } from "../../src/poppy/client";
import { completeDirectSignIn, signOut, startSignIn } from "../../src/poppy/signin";
import type { Card } from "../../src/poppy/wire";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("MCP initialization belongs to one client and completes before tools run", () => {
  it.each([false, true])("reinitializes after sign-in and account changes with DPoP=%s", async (mcpDpop) => {
    const w = await world({ protocolVersion: "0.2", mcpDpop });
    let initializations = 0;
    const client = new PoppyClient({ ...w.client.host, fetcher: async (request) => {
      if (new URL(request.url).pathname === "/mcp" && request.method === "POST") {
        const body = await request.clone().json() as { method: string };
        if (body.method === "initialize") initializations++;
      }
      return w.client.host.fetcher(request);
    } });
    const list = () => listMcpTools(client, w.company, "main");
    const signIn = async (account: string, label = "main") => {
      const started = await startSignIn(client, w.company, { label, account, scopes: ["poppy:read"], reason: "MCP account isolation", type: "direct" });
      if (started.status !== "waiting") {
        expect(started.status).toBe("signed_in");
        return;
      }
      const card = w.cards.get(`signin-${started.signInId}`) as Extract<Card, { kind: "signin_link" }>;
      const location = await w.mock.approveAuthorization(card.url, { approve: true, account: `acct_${account}` });
      expect((await completeDirectSignIn(client, new URL(location))).ok).toBe(true);
    };
    await list(); await list();
    expect(initializations).toBe(1);
    await signIn("ada"); await list();
    expect(initializations).toBe(2);
    await signOut(client, w.company.issuer, "ada"); await list();
    expect(initializations).toBe(3);
    await signIn("grace", "other");
    await signIn("grace"); await list(); await list();
    expect(initializations).toBe(4);
  });

  it("shares initialization across concurrent callers without exposing a provisional session", async () => {
    const w = await world({ protocolVersion: "0.2", mcpDpop: true });
    const entered = gate(), proceed = gate();
    let initializations = 0, earlyTools = 0, released = false;
    const client = new PoppyClient({ ...w.client.host, fetcher: async (request) => {
      if (new URL(request.url).pathname === "/mcp" && request.method === "POST") {
        const body = await request.clone().json() as { method: string };
        if (body.method === "initialize") { initializations++; entered.release(); await proceed.promise; }
        if (body.method === "tools/list" && !released) earlyTools++;
      }
      return w.client.host.fetcher(request);
    } });
    const first = listMcpTools(client, w.company, "main");
    await entered.promise;
    const second = listMcpTools(client, w.company, "main");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeInitialization = earlyTools;
    released = true; proceed.release();
    const [a, b] = await Promise.all([first, second]);
    expect(beforeInitialization).toBe(0);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(initializations).toBe(1);
  });

  it("discards failed initialization and retries it on the next request", async () => {
    const w = await world({ protocolVersion: "0.2" });
    let notifications = 0, initializations = 0;
    const client = new PoppyClient({ ...w.client.host, fetcher: async (request) => {
      if (new URL(request.url).pathname === "/mcp" && request.method === "POST") {
        const body = await request.clone().json() as { method: string };
        if (body.method === "initialize") initializations++;
        if (body.method === "notifications/initialized" && notifications++ === 0) return new Response(null, { status: 500 });
      }
      return w.client.host.fetcher(request);
    } });
    await expect(listMcpTools(client, w.company, "main")).rejects.toMatchObject({ code: "http_500" });
    expect((await listMcpTools(client, w.company, "main")).length).toBeGreaterThan(0);
    expect(initializations).toBe(2);
  });
});
