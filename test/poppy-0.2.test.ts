import { describe, expect, it } from "vitest";
import { agent, cards, company, signInDirect, tool, until } from "./agent-helpers";
import { validateCompany, validateText, validateTarget } from "../src/validator/index";
import { TaskCompanyScope } from "../src/poppy/task-scope";

const document = (version = "0.2") => ({ protocol_version: version, organization: { name: "Shop", domain: "www.shop.example" }, auth: { issuer: "https://auth.shop.example/tenant" }, apis: [{ type: "mcp", url: "https://mcp.shop.example/mcp", description: "Catalog" }] });

describe("explicit Poppy draft profiles", () => {
  it.each(["0.0", "0.3", "0.7", "1.0"])("refuses unsupported %s before fetching issuer metadata", async (version) => {
    const seen: string[] = [];
    const report = await validateCompany(async (request) => { seen.push(request.url); return Response.json(document(version)); }, "www.shop.example");
    expect(report.refused).toBe(true);
    expect(seen).toEqual(["https://www.shop.example/.well-known/poppy.json"]);
  });

  it("refuses an unsupported context before fetching standalone OAuth metadata", async () => {
    const seen: string[] = [];
    const report = await validateTarget(async (request) => { seen.push(request.url); return Response.json({}); }, "https://shop.example/.well-known/oauth-authorization-server", { protocolVersion: "0.3" });
    expect(report.refused).toBe(true);
    expect(seen).toEqual([]);
  });

  it("uses the final serving host in 0.2 and retains the requested-host rule in 0.1", async () => {
    for (const version of ["0.1", "0.2"]) {
      const report = await validateCompany(async (request) => {
        if (request.url === "https://shop.example/.well-known/poppy.json") return new Response(null, { status: 302, headers: { Location: "https://provider.example/document" } });
        if (request.url === "https://provider.example/document") return Response.json({ ...document(version), organization: { name: "Shop", domain: "provider.example" } });
        return Response.json({ issuer: "https://auth.shop.example/tenant", token_endpoint: "https://auth.shop.example/token", revocation_endpoint: "https://auth.shop.example/revoke", poppy_domains: ["provider.example"] });
      }, "shop.example");
      expect(report.refused).toBe(version === "0.1");
      expect(report.checkedAgainst).toBe(`Draft ${version}`);
    }
  });

  it("does not normalize www in 0.2 or silently fall back from an invalid validation context", () => {
    expect(validateText("poppy", JSON.stringify(document()), { domain: "shop.example" }).refused).toBe(true);
    expect(validateText("oauth-metadata", "{}", { protocolVersion: "0.3" }).messages.map((m) => m.id)).toEqual(["version-unsupported"]);
  });

  it("requires ES256 only when the optional 0.2 DPoP algorithm list is present", () => {
    const report = validateText("oauth-metadata", JSON.stringify({ issuer: "https://auth.shop.example", token_endpoint: "https://auth.shop.example/token", revocation_endpoint: "https://auth.shop.example/revoke", poppy_domains: ["shop.example"], dpop_signing_alg_values_supported: ["RS256"] }), { protocolVersion: "0.2" });
    expect(report.messages.find((m) => m.id === "metadata-dpop-alg")).toMatchObject({ severity: "error", basis: "MUST", refuses: true });
  });
});

describe("0.2 client against the independent mock rule path", () => {
  it.each([false, true])("discovers, starts an issuer-audience Session and uses MCP (DPoP=%s)", async (mcpDpop) => {
    const c = await company({ protocolVersion: "0.2", mcpDpop, requireNonce: true, issuerPath: "/tenant" });
    const a = await agent();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    expect((await tool(a, "poppy_mcp_list", { domain: c.domain })).isError).toBe(false);
    const state = await c.stub.state();
    const mcp = state.requests.filter((request) => new URL(request.url).pathname === "/mcp");
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp.every((request) => request.headers.authorization?.startsWith(mcpDpop ? "DPoP " : "Bearer "))).toBe(true);
  });

  it("keeps a proposal pending until the User approves its exact revision", async () => {
    const c = await company({ protocolVersion: "0.2" });
    const a = await agent();
    expect((await signInDirect(a, c))?.callback.status).toBe(200);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } })).isError).toBe(false);
    const card = await until(async () => (await cards(a)).find((card) => card.kind === "operation" && card.open));
    expect((await c.stub.state()).performs).toBe(0);
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });
});

describe("Company content cannot expand a User task", () => {
  it("blocks a reachable Company B after Company A supplied content", () => {
    const scope = new TaskCompanyScope();
    scope.update("Look up my order", false, "task-1");
    expect(scope.allow("a.example")).toBe(true);
    scope.receivedCompanyContent();
    expect(scope.allow("b.example")).toBe(false);
    expect(scope.allow("a.example")).toBe(true);
    scope.update("Compare a.example and b.example", false, "task-2");
    expect(scope.allow("a.example")).toBe(true);
    scope.receivedCompanyContent();
    expect(scope.allow("b.example")).toBe(true);
  });
});
