import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "./worker";
import { agent, cards, company, requests, tool, type Agent, type Company } from "./agent-helpers";

async function authorize(a: Agent, c: Company, account: string) {
  const existing = new Set((await cards(a)).map(card => card.id));
  expect((await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read", "orders:write"], reason: "Concurrent authorization verification" })).isError).toBe(false);
  const card = (await cards(a)).find(card => card.kind === "signin_link" && card.domain === c.domain && !existing.has(card.id));
  expect(card).toBeDefined();
  return new URL(await c.stub.approveAuthorization(card!.url, { approve: true, account }));
}

describe("simultaneous authorization at two legitimate Companies for two Users", () => {
  it.each(["issuer", "company-state", "user-state", "user-callback", "company-and-user-state", "company-code", "user-code", "company-and-user-code"] as const)(
    "rejects a swapped %s without changing User/Company bindings, then permits four fresh sign-ins", async mutation => {
      const companies = await Promise.all([company(), company()]);
      const users = await Promise.all([agent(), agent()]);
      const flows = users.flatMap((user, i) => companies.map(company => ({ user, company, account: i === 0 ? "acct_ada" : "acct_grace" })));
      const callbacks = await Promise.all(flows.map(flow => authorize(flow.user, flow.company, flow.account)));
      const before = await Promise.all(users.map(user => user.stub.poppySql("SELECT issuer, session_id, account, signed_in FROM poppy_sessions ORDER BY issuer")));
      const callback = new URL(mutation === "user-callback" ? callbacks[2] : callbacks[0]);
      const copy = (field: string, source: number) => callback.searchParams.set(field, callbacks[source]!.searchParams.get(field)!);
      if (mutation === "issuer") copy("iss", 1);
      if (mutation === "company-state") copy("state", 1);
      if (mutation === "user-state") copy("state", 2);
      if (mutation === "company-and-user-state") { copy("state", 3); copy("iss", 3); }
      if (mutation === "company-code") copy("code", 1);
      if (mutation === "user-code") { copy("code", 2); companies[0]!.expectViolations(/^\[code\.pkce\]/); }
      if (mutation === "company-and-user-code") copy("code", 3);
      const rejected = await worker.fetch(new Request(callback, { headers: { Cookie: users[0]!.cookie } }), env);
      expect(rejected.status).toBe(400);
      for (const [i, user] of users.entries()) {
        expect(await user.stub.poppySql("SELECT issuer, session_id, account, signed_in FROM poppy_sessions ORDER BY issuer")).toBe(before[i]);
        expect(JSON.parse(await user.stub.poppySql("SELECT issuer FROM poppy_accounts"))).toEqual([]);
      }
      const posts = await Promise.all(companies.map(async company => (await requests(company)).filter(request => request.method === "POST" && request.grant === "authorization_code")));
      expect(posts[0]).toHaveLength(mutation.endsWith("code") ? 1 : 0);
      expect(posts[1]).toHaveLength(0);
      for (const request of posts[0]!) {
        expect(new URL(request.url).origin).toBe(companies[0]!.hosts.issuer);
        expect(request.bodyKeys).toContain("code_verifier");
        expect(request.headers["poppy-session"]).toBeUndefined();
      }
      // An opaque wrong code may reach the server bound to state; PKCE/issuer ownership
      // must reject it. Fresh controls avoid reusing any code consumed by that denial.
      await Promise.all(flows.map(async flow => {
        const location = await authorize(flow.user, flow.company, flow.account);
        const response = await worker.fetch(new Request(location, { headers: { Cookie: flow.user.cookie } }), env);
        expect(response.status).toBe(200);
        expect((await tool(flow.user, "poppy_api_call", { domain: flow.company.domain, operation: "listOrders" })).isError).toBe(false);
      }));
      for (const flow of flows) {
        const sessions = JSON.parse(await flow.user.stub.poppySql("SELECT issuer, signed_in FROM poppy_sessions WHERE issuer = ?", flow.company.hosts.issuer));
        expect(sessions).toEqual([{ issuer: flow.company.hosts.issuer, signed_in: 1 }]);
        const [{ user_id }] = JSON.parse(await flow.user.stub.poppySql("SELECT user_id FROM poppy_user_ids WHERE issuer = ?", flow.company.hosts.issuer));
        const state = await flow.company.stub.state();
        expect(state.sessions.some(session => session.userId === user_id && session.account === flow.account && session.signedIn)).toBe(true);
        expect(state.performs).toBe(0);
      }
    }
  );
});
