import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { browse } from "../src/poppy/browser";
import { FetchBrowser } from "../src/poppy/fetch-browser";
import { agent, cards, company, requests, signInDirect } from "./agent-helpers";

describe("browser cookies retain only their authorized access", () => {
  it("rejoins with narrowed scopes even when the Company refuses to revoke the previous grant", async () => {
    const c = await company({ refuseRevocations: 100 });
    const a = await agent();
    await signInDirect(a, c);
    const open = (url: string) => a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "open", url });
    expect((await open("/orders")).text).toContain("Signed in as acct_ada");
    await open("/account/address");
    const pending = await a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "submit", selector: "#address" });
    const id = JSON.parse(pending.text).proposed;
    const before = JSON.parse(await a.stub.poppySql("SELECT session_id, account, scope, authority_generation FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer))[0];
    // The extra requested scope starts fresh consent; the User grants only write access this time.
    await signInDirect(a, c, ["orders:read", "orders:write", "addresses"], { scopes: ["orders:write"] });
    const after = JSON.parse(await a.stub.poppySql("SELECT session_id, account, scope, authority_generation FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer))[0];
    expect(after).toMatchObject({ session_id: before.session_id, account: before.account, authority_generation: before.authority_generation, scope: "orders:write" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" });
    expect((await c.stub.state()).formPosts).toEqual([]);
    expect((await cards(a)).find(card => card.approvalId === id)?.status).toBe("failed");
    const narrowed = await open("/orders");
    expect(narrowed.isError).toBe(false);
    expect(narrowed.text).not.toContain("Signed in as acct_ada");
    expect(narrowed.text).toContain("Signed out");
    expect((await c.stub.state()).browserJoins).toBe(2);
  });

  it("invalidates a scope-only change before fill or a saved form can use the old cookie", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "open", url: "/account/address" });
    const held = await a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "submit", selector: "#address" });
    const id = JSON.parse(held.text).proposed;
    const generation = await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      return client.accountGeneration((await client.company(c.domain)).issuer, "default");
    });
    await a.stub.poppySql("UPDATE poppy_sessions SET scope = 'orders:write' WHERE issuer = ? AND label = 'main'", c.hosts.issuer);
    const before = (await requests(c)).length;
    const fill = await a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "fill", selector: "#line1", value: "Access was withdrawn" });
    expect(fill.isError).toBe(true);
    expect(fill.details).toContain("approval_changed");
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" });
    expect((await requests(c)).length).toBe(before);
    expect((await c.stub.state()).formPosts).toEqual([]);
    expect(await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      return client.accountGeneration((await client.company(c.domain)).issuer, "default");
    })).toBe(generation);
  });

  it("replaces a same-scope browser after fresh consent replaces the refresh-token family", async () => {
    const c = await company({ refuseRevocations: 100 });
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "open", url: "/account/address" });
    const held = await a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "submit", selector: "#address" });
    const id = JSON.parse(held.text).proposed;
    await signInDirect(a, c, ["orders:read", "orders:write", "addresses"], { scopes: ["orders:read", "orders:write"] });
    const fill = await a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "fill", selector: "#line1", value: "Previous sign-in" });
    expect(fill.isError).toBe(true);
    expect(fill.details).toContain("approval_changed");
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" });
    expect((await c.stub.state()).formPosts).toEqual([]);
    const fresh = await a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "open", url: "/orders" });
    expect(fresh.text).toContain("Signed in as acct_ada");
    expect((await c.stub.state()).browserJoins).toBe(2);
  });

  it("keeps an existing cookie when only scope order, duplicates or whitespace change", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const open = () => a.stub.poppyTool("poppy_browse", { domain: c.domain, action: "open", url: "/orders" });
    expect((await open()).text).toContain("Signed in as acct_ada");
    await a.stub.poppySql("UPDATE poppy_sessions SET scope = ' orders:write  orders:read orders:read ' WHERE issuer = ? AND label = 'main'", c.hosts.issuer);
    expect((await open()).text).toContain("Signed in as acct_ada");
    expect((await c.stub.state()).browserJoins).toBe(1);
  });

  it("also binds a signed-out visitor context when the website has no browser-session endpoint", async () => {
    const c = await company({ browserSession: false });
    const a = await agent();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const fetchBrowser = new FetchBrowser(client.host.fetcher);
      let contexts = 0;
      const browser = { newContext: (guard: Parameters<FetchBrowser["newContext"]>[0]) => { contexts++; return fetchBrowser.newContext(guard); } };
      expect(await browse(client, browser, C, "main", { kind: "open", url: "/" })).toMatchObject({ status: 200 });
      client.sql.exec("UPDATE poppy_sessions SET scope = 'orders:write' WHERE issuer = ? AND label = 'main'", C.issuer);
      await expect(browse(client, browser, C, "main", { kind: "click", selector: "#orders" })).rejects.toMatchObject({ code: "approval_changed" });
      expect(await browse(client, browser, C, "main", { kind: "open", url: "/" })).toMatchObject({ status: 200 });
      expect(contexts).toBe(2);
    });
    expect((await c.stub.state()).browserJoins).toBe(0);
  });
});
