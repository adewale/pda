/**
 * Our client against the mock Company serving the 0.4 draft of 10 November
 * (spec/draft-0.4-retrieved-2026-11-10), alone or beside 0.3 (3.4). Every
 * test also passes the strict check in agent-helpers: the mock recorded no
 * violation or warning, and what the agent sent passes the 0.4 kit's schemas.
 */
import { describe, expect, it } from "vitest";
import { agent, company, requests, tool, type Company } from "./agent-helpers";
import type { MockConfig, MockRequest } from "./mock-company";

const V4: Partial<MockConfig> = { protocolVersion: "0.4" };

/** Requests to the Company's APIs and MCP server, which carry the Session header (5.2). */
const resourceRequests = (all: readonly MockRequest[], c: Company) =>
  all.filter((request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/.well-known/") || url.pathname === "/openapi.json") return false;
    return url.hostname === `api.${c.domain}` || url.hostname === `mcp.${c.domain}`;
  });

describe("0.4: choosing a version and declaring it (3.4)", () => {
  it.each([
    ["serves 0.4 alone", V4],
    ["serves 0.4 and links 0.3", { ...V4, linkedVersion: "0.3" }],
    ["serves 0.3 and links 0.4", { protocolVersion: "0.3", linkedVersion: "0.4" }]
  ] as const)("chooses 0.4 from a Company that %s, and declares it on every Session request", async (_, config) => {
    const c = await company(config);
    const a = await agent();
    const read = await tool(a, "poppy_api_call", { domain: c.domain, operation: "searchProducts", params: { q: "jacket" } });
    expect(read.isError, read.text).toBe(false);
    const resources = resourceRequests(await requests(c), c);
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.every((request) => request.headers["poppy-version"] === "0.4")).toBe(true);
    // The mock lists Operations 3, so the Session declares it (3.3).
    expect(new Set(resources.map((request) => request.headers["poppy-extensions"]))).toEqual(new Set([`"operations";v="3"`]));
    const linked = (await requests(c)).filter((request) => new URL(request.url).pathname.startsWith("/poppy/v"));
    // A 0.4 poppy.json needs no other document; a 0.3 one links the 0.4 document, which is fetched once.
    expect(linked.map((request) => new URL(request.url).pathname)).toEqual(config.protocolVersion === "0.3" ? ["/poppy/v0.4.json"] : []);
  });
});
