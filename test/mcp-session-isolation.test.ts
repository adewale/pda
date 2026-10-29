import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { listMcpTools } from "../src/poppy/apis";
import { isObject } from "../src/poppy/json";
import { agent, company, signInDirect } from "./agent-helpers";

it("starts a separate MCP session for each agent in a shared isolate", async () => {
  const c = await company();
  const first = await agent();
  const second = await agent();
  for (const a of [first, second]) {
    const methods = await runInDurableObject(a.stub, async (instance) => {
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
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  }
});

it.each(["reauth", "step-up"] as const)("refreshes the MCP session and catalogue after same-account %s", async change => {
  const c = await company();
  const a = await agent();
  const list = () => runInDurableObject(a.stub, async instance => {
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
  await signInDirect(a, c, ["orders:read"]);
  const sid = await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer);
  expect(await list()).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  expect(await list()).toEqual([]);
  if (change === "reauth") await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
  await signInDirect(a, c, change === "reauth" ? ["orders:read"] : ["orders:read", "orders:write"]);
  expect(await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer)).toBe(sid);
  expect(await list()).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  expect(await list()).toEqual([]);
});
