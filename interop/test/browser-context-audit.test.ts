import { describe, expect, it } from "vitest";
import { browse, type BrowserContextHandle, type PageGuard, type PageSnapshot, type PoppyBrowser } from "../../src/poppy/browser";
import type { PoppyClient, TokenOptions } from "../../src/poppy/client";
import type { Company } from "../../src/poppy/discovery";
import { toIssuer } from "../../src/poppy/issuer";
import { decideLocal } from "../../src/poppy/operations";
import { migrate } from "../../src/poppy/store";
import { memorySql } from "../impls/pda-agent/sqlite";

const COMPANY: Company = {
  issuer: toIssuer("https://auth.shop.example"), domain: "shop.example", name: "Shop", protocolVersion: "0.3",
  endpoints: { token: "https://auth.shop.example/token", revocation: "https://auth.shop.example/revoke" },
  signIn: {}, customScopes: {}, apis: [], extensions: {}, web: { browserSessionEndpoint: "https://shop.example/browser-session" }
};

type Binding = { session_id: string; account: string | null; authority_generation: number };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The real browser coordinator with controlled transport boundaries and a cookie bound to the authorized account. */
function fixture(stage?: "authorize" | "post", restart = false) {
  let state: Binding = { session_id: "session-A", account: "account-A", authority_generation: 0 };
  let authorized: Binding | undefined;
  let cookie: Binding | undefined;
  const reached = deferred(), released = deferred();
  const counts = { joins: 0, posts: 0, closes: 0, pages: 0, submits: 0 };
  const sql = memorySql();
  migrate(sql);
  const hold = async (here: typeof stage) => { if (stage === here) { reached.resolve(); await released.promise; } };
  const client = {
    sql, host: { showCard: async () => {}, notifyModel: async () => {} },
    rememberCompany: () => {}, resumeCompany: async () => COMPANY,
    session: () => state,
    accountGeneration: () => 0,
    token: async () => null,
    beforeRequest: async () => {},
    pageLimited: async () => false,
    resourceJson: async (_company: Company, _request: unknown, options: TokenOptions) => {
      options.beforeDispatch?.();
      if (restart) {
        state = { ...state, session_id: "session-restarted" };
        options.beforeDispatch?.();
      }
      authorized = { ...state };
      await hold("authorize");
      return { status: 204, body: null, headers: new Headers() };
    }
  } as unknown as PoppyClient;
  const browser: PoppyBrowser = {
    async newContext(guard: PageGuard): Promise<BrowserContextHandle> {
      const snapshot = (url: string): PageSnapshot => ({ url, status: 200, title: "Orders", text: `Account ${cookie?.account ?? "signed out"}`, links: [], forms: [] });
      return {
        async joinCode(endpoint) { guard(new URL(endpoint)); counts.joins++; return { status: 200, code: "browser-code", action: endpoint }; },
        async postForm(action) {
          guard(new URL(action)); counts.posts++; cookie = { ...authorized! };
          await hold("post");
          // A real browser follows the post's redirect through this guard too.
          guard(new URL("https://shop.example/"));
          return { url: "https://shop.example/", status: 200 };
        },
        async goto(url) { guard(new URL(url)); counts.pages++; return snapshot(url); },
        async click() { guard(new URL("https://shop.example/orders")); counts.pages++; return snapshot("https://shop.example/orders"); },
        async fill() { return snapshot("https://shop.example/orders"); },
        async prepareSubmit() { return { from: "https://shop.example/orders", action: "https://shop.example/save", method: "POST", enctype: "application/x-www-form-urlencoded", fields: [{ name: "confirm", value: "yes", hidden: false }] }; },
        async submit(submission, beforeDispatch) { guard(new URL(submission.action)); beforeDispatch?.(); counts.submits++; return snapshot(submission.action); },
        async close() { counts.closes++; cookie = undefined; }
      };
    }
  };
  return { client, browser, reached, released, counts,
    change: (account: string | null) => { state = { session_id: account ? "session-B" : state.session_id, account, authority_generation: state.authority_generation + (account ? 0 : 1) }; },
    reauthenticate: () => { state = { ...state, authority_generation: state.authority_generation + 1 }; },
    cookie: () => cookie };
}

const open = (f: ReturnType<typeof fixture>) => browse(f.client, f.browser, COMPANY, "main", { kind: "open", url: "/orders" });

describe("browser join account binding", () => {
  for (const stage of ["authorize", "post"] as const) for (const account of ["account-B", null]) {
    it(`discards a join if ${account ? "the account switches" : "the User signs out"} while ${stage} is pending`, async () => {
      const f = fixture(stage);
      const pending = open(f);
      const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
      await f.reached.promise;
      f.change(account);
      f.released.resolve();
      await rejected;
      expect(f.counts.closes).toBe(1);
      expect(f.cookie()).toBeUndefined();
      expect(f.counts.pages).toBe(0);
      await expect(browse(f.client, f.browser, COMPANY, "main", { kind: "click", selector: "#orders" })).rejects.toMatchObject({ code: "invalid_request" });
    });
  }


  it.each(["authorize", "post"] as const)("rejects sign-out and reauthentication to the same account during %s", async (stage) => {
    const f = fixture(stage);
    const pending = open(f);
    const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
    await f.reached.promise;
    // The account/SID return to their original values; only the durable generation records withdrawal.
    f.reauthenticate();
    f.released.resolve();
    await rejected;
    expect(f.counts.closes).toBe(1);
    expect(f.cookie()).toBeUndefined();
    expect(f.counts.pages).toBe(0);
  });

  it("does not revive a saved form approval after signing back in to the same account", async () => {
    const f = fixture();
    await open(f);
    const proposed = await browse(f.client, f.browser, COMPANY, "main", { kind: "submit", selector: "#save" }) as { proposed: string };
    const stored = f.client.sql.exec("SELECT request FROM poppy_approvals WHERE id = ?", proposed.proposed).toArray()[0] as { request: string };
    expect(JSON.parse(stored.request).binding.authorityGeneration).toBe(0);
    f.reauthenticate();
    await decideLocal(f.client, proposed.proposed, "approve");
    expect(f.counts.submits).toBe(0);
    expect(f.client.sql.exec("SELECT status FROM poppy_approvals WHERE id = ?", proposed.proposed).toArray()[0]).toMatchObject({ status: "failed" });
    await expect(browse(f.client, f.browser, COMPANY, "main", { kind: "click", selector: "#orders" })).rejects.toMatchObject({ code: "approval_changed" });
    // A fresh join after reauthentication is usable, while the old card stays decided.
    expect(await open(f)).toMatchObject({ text: "Account account-A" });
    expect(f.counts.joins).toBe(2);
    await decideLocal(f.client, proposed.proposed, "approve");
    expect(f.counts.submits).toBe(0);
  });

  it("keeps normal browsing in the account actually authorized", async () => {
    const f = fixture();
    expect(await open(f)).toMatchObject({ text: "Account account-A" });
    expect(await open(f)).toMatchObject({ text: "Account account-A" });
    expect(await browse(f.client, f.browser, COMPANY, "main", { kind: "click", selector: "#orders" })).toMatchObject({ text: "Account account-A" });
    expect(f.counts).toEqual({ joins: 1, posts: 1, closes: 0, pages: 3, submits: 0 });
  });

  it("allows the authorize request to restart an ended Session without changing accounts", async () => {
    const f = fixture(undefined, true);
    expect(await open(f)).toMatchObject({ text: "Account account-A" });
    expect(f.cookie()).toEqual({ session_id: "session-restarted", account: "account-A", authority_generation: 0 });
    expect(await browse(f.client, f.browser, COMPANY, "main", { kind: "click", selector: "#orders" })).toMatchObject({ text: "Account account-A" });
  });
});
