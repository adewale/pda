import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { agent, cards, company, requests, signInDirect } from "./agent-helpers";
import { browse } from "../src/poppy/browser";
import { FetchBrowser } from "../src/poppy/fetch-browser";
import { decideLocal } from "../src/poppy/operations";

it("joins only the agent-controlled browser and leaves an ordinary User visit unjoined", async () => {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  const joined = await runInDurableObject(a.stub, async instance => {
    const client = instance.poppy.client;
    const C = await client.company(c.domain);
    let code: string | undefined;
    const cookies: string[] = [];
    const fetcher = client.host.fetcher;
    const browser = new FetchBrowser(async request => {
      cookies.push(request.headers.get("Cookie") ?? "");
      if (request.method === "POST" && new URL(request.url).pathname === "/poppy/browser-session") {
        code = new URLSearchParams(new TextDecoder().decode(await request.clone().arrayBuffer())).get("code") ?? undefined;
      }
      return fetcher(request);
    });
    const page = await browse(client, browser, C, "main", { kind: "open", url: "/orders" });
    expect(JSON.stringify(page)).toContain("Signed in as acct_ada");
    expect(cookies.some(cookie => cookie.length > 0)).toBe(true);
    expect(cookies.every(cookie => !cookie.includes("private-user-cookie"))).toBe(true);
    const userVisit = await fetcher(new Request(`https://${c.domain}/orders`, {
      headers: { Cookie: "user-browser=private-user-cookie" }
    }));
    expect(await userVisit.text()).toContain("Signed out");
    expect(code).toBeTruthy();
    return { page, code };
  });
  const visible = JSON.stringify({ page: joined.page, cards: await cards(a) });
  expect(visible).not.toContain(joined.code!);
  expect(visible).not.toContain("private-user-cookie");
  expect((await c.stub.state()).browserJoins).toBe(1);
});

it("keeps normal browser navigation and POST303GET while requiring approval of frozen form values", async () => {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  const call = (args: Record<string, unknown>) => a.stub.poppyTool("poppy_browse", { domain: c.domain, ...args });
  expect((await call({ action: "open", url: "/account/address" })).text).toContain("Your address");
  await call({ action: "fill", selector: "#line1", value: "1 High St" });
  const held = await call({ action: "submit", selector: "#address" });
  const id = JSON.parse(held.text).proposed;
  expect((await c.stub.state()).formPosts).toEqual([]);
  await call({ action: "fill", selector: "#line1", value: "Changed after review" });
  await a.stub.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" });
  expect((await c.stub.state()).formPosts[0]?.fields).toContainEqual(["line1", "1 High St"]);
  expect((await cards(a)).find(card => card.approvalId === id)).toMatchObject({ status: "done", result: expect.stringContaining("Address saved") });
  expect((await requests(c)).some(request => request.url.endsWith("/account/address?saved=1") && request.method === "GET")).toBe(true);
});

it("rejects an old form approval after its account and cookie context were replaced", async () => {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  const call = (args: Record<string, unknown>) => a.stub.poppyTool("poppy_browse", { domain: c.domain, ...args });
  await call({ action: "open", url: "/account/address" });
  const held = await call({ action: "submit", selector: "#address" });
  const id = JSON.parse(held.text).proposed;
  await a.stub.poppySql("UPDATE poppy_sessions SET account = 'changed-account' WHERE issuer = ?", c.hosts.issuer);
  const before = (await requests(c)).length;
  await a.stub.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" });
  expect((await c.stub.state()).formPosts).toEqual([]);
  expect((await requests(c)).length).toBe(before);
  expect((await cards(a)).find(card => card.approvalId === id)?.status).toBe("failed");
});

it("binds browser contexts to account and Session even without a browser-session endpoint", async () => {
  const c = await company({ browserSession: false });
  const a = await agent();
  await signInDirect(a, c);
  const call = (args: Record<string, unknown>) => a.stub.poppyTool("poppy_browse", { domain: c.domain, ...args });
  await call({ action: "open", url: "/account/address" });
  await a.stub.poppySql("UPDATE poppy_sessions SET account = 'changed-account' WHERE issuer = ?", c.hosts.issuer);
  const before = (await requests(c)).length;
  const fill = await call({ action: "fill", selector: "#line1", value: "Wrong account" });
  expect(fill.isError).toBe(true);
  expect(fill.details).toContain("approval_changed");
  expect((await requests(c)).length).toBe(before);
});

it("rejoins a website cookie that expired while its Poppy Session remains valid", async () => {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  await runInDurableObject(a.stub, async instance => {
    const client = instance.poppy.client;
    const C = await client.company(c.domain);
    let needsRejoin = false;
    const browser = new FetchBrowser(async request => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/poppy/browser-session") needsRejoin = false;
      if (request.method === "GET" && path === "/orders" && needsRejoin) return new Response("Website cookie expired", { status: 401 });
      return client.host.fetcher(request);
    });
    const read = () => browse(client, browser, C, "main", { kind: "open", url: "/orders" });
    expect(await read()).toMatchObject({ status: 200, text: expect.stringContaining("Signed in as acct_ada") });
    needsRejoin = true;
    expect(await read()).toMatchObject({ status: 200, text: expect.stringContaining("Signed in as acct_ada") });
  });
  expect((await c.stub.state()).browserJoins).toBe(2);
});
