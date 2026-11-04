import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { listMcpTools } from "../src/poppy/apis";
import { isObject } from "../src/poppy/json";
import { agent, company, signInDirect, type Agent, type Company } from "./agent-helpers";
import type { MockConfig } from "./mock-company";

/**
 * Each agent's MCP cache is its own, and partitioned by the Poppy Session and
 * its authority, under either lifecycle: 2025-06-18's MCP session and
 * catalogue, or 2026-07-28's catalogue alone. `opens` is what a fresh agent
 * sends before its first list (the probe, and the handshake if any);
 * `reopens` what a new partition sends once the server's era is known.
 */
const LIFECYCLES: readonly { name: string; config: Partial<MockConfig>; opens: string[]; reopens: string[] }[] = [
  { name: "2025-06-18", config: { mcpVersions: ["2025-06-18"] }, opens: ["server/discover", "initialize", "notifications/initialized"], reopens: ["initialize", "notifications/initialized"] },
  { name: "2026-07-28", config: { mcpVersions: ["2026-07-28"] }, opens: ["server/discover"], reopens: [] },
  { name: "both", config: { mcpVersions: ["2026-07-28", "2025-06-18"] }, opens: ["server/discover"], reopens: [] }
];

/** The JSON-RPC methods one `listMcpTools` sends. */
async function list(a: Agent, c: Company): Promise<string[]> {
  return runInDurableObject(a.stub, async (instance) => {
    const client = instance.poppy.client;
    const C = await client.company(c.domain);
    const original = client.resource.bind(client);
    const methods: string[] = [];
    const outgoing = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
      const body = request.init().body;
      if (isObject(body) && typeof body.method === "string") methods.push(body.method);
      return original(target, request, options);
    });
    try { await listMcpTools(client, C, "main"); } finally { outgoing.mockRestore(); }
    return methods;
  });
}

describe.each(LIFECYCLES)("MCP $name", ({ config, opens, reopens }) => {
  it("keeps a separate MCP cache for each agent in a shared isolate", async () => {
    const c = await company(config);
    for (const a of [await agent(), await agent()]) expect(await list(a, c)).toEqual([...opens, "tools/list"]);
  });

  it.each(["reauth", "step-up"] as const)("refreshes the MCP catalogue, and any MCP session, after same-account %s", async change => {
    const c = await company(config);
    const a = await agent();
    await signInDirect(a, c, ["orders:read"]);
    const sid = await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer);
    expect(await list(a, c)).toEqual([...opens, "tools/list"]);
    expect(await list(a, c)).toEqual([]);
    if (change === "reauth") await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await signInDirect(a, c, change === "reauth" ? ["orders:read"] : ["orders:read", "orders:write"]);
    expect(await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer)).toBe(sid);
    expect(await list(a, c)).toEqual([...reopens, "tools/list"]);
    expect(await list(a, c)).toEqual([]);
  });
});
