import { runInDurableObject } from "cloudflare:test";
import type { Context } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { runAccess, TurnAuthority, type TurnReader } from "../src/tools/turn-authority";
import { agent } from "./agent-helpers";

it("keeps submission origin durable and refuses missing or mixed run provenance", async () => {
  const { stub } = await agent();
  await runInDurableObject(stub, async (_instance, state) => {
    const requests = new Map([["10", "user-one"], ["11", "background-one"], ["12", "legacy-one"]]);
    const storage = {
      submission: async (id: string) => {
        const requestId = requests.get(String(id));
        return requestId ? { id, type: "input", status: "placed", conversationId: "1", requestId, entry: "20" } : undefined;
      }
    } as unknown as Storage;
    const authority = new TurnAuthority(state.storage.sql, async () => storage);
    authority.record("user-one", "user");
    authority.record("selected-one", "user", { companies: ["shop.example"], uploads: [] });
    expect(() => authority.record("selected-one", "user", { companies: ["excluded.example"], uploads: [] })).toThrow("trusted origin cannot change");
    authority.record("background-one", "background");
    expect(() => authority.record("background-one", "user")).toThrow("trusted origin cannot change");
    let inputs: string[] = ["10"];
    const api = { conversationId: "1", snapshot: async () => ({ run: { taskId: "30", inputs } }) } as unknown as TurnReader;
    const context = {} as Context;
    expect(await authority.isUser(api, context)).toBe(true);
    // Reopening the local capability loses no authority and never consults message text.
    const reopened = new TurnAuthority(state.storage.sql, async () => storage);
    expect(await reopened.isUser(api, context)).toBe(true);
    inputs = ["10", "11"];
    expect(await reopened.isUser(api, context)).toBe(false);
    inputs = ["11"];
    expect(await reopened.isUser(api, context)).toBe(false);
    inputs = ["12"];
    expect(await reopened.isUser(api, context)).toBe(false);
    inputs = ["999"];
    expect(await reopened.isUser(api, context)).toBe(false);
    inputs = [];
    expect(await reopened.isUser(api, context)).toBe(false);
  });
});

it("withdraws legacy inferred grants rather than manufacturing structured selections", async () => {
  const { stub } = await agent();
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("DROP TABLE turn_sources");
    sql.exec("CREATE TABLE turn_sources (request_id TEXT PRIMARY KEY, source TEXT NOT NULL, task_policy INTEGER NOT NULL DEFAULT 0)");
    sql.exec("INSERT INTO turn_sources VALUES ('legacy', 'user', 1)");
    const authority = new TurnAuthority(sql, async () => ({} as Storage));
    const previous = sql.exec("SELECT task_policy, task_access FROM turn_sources WHERE request_id = 'legacy'").one();
    expect(previous.task_policy).toBe(0);
    expect(JSON.parse(String(previous.task_access))).toEqual({ companies: [], uploads: [] });
    authority.record("fresh", "user", { companies: ["shop.example"], uploads: [] });
    expect(sql.exec("SELECT task_policy FROM turn_sources WHERE request_id = 'fresh'").one().task_policy).toBe(1);
  });
});

it("remembers the Companies a new message states, and nothing else changes them", async () => {
  const { stub } = await agent();
  await runInDurableObject(stub, async (_instance, state) => {
    const authority = new TurnAuthority(state.storage.sql, async () => ({}) as Storage);
    const selected = (...companies: string[]) => ({ companies, uploads: [] });
    expect(authority.selectedCompanies()).toEqual([]);
    authority.record("first", "user", selected("shop.example"));
    expect(authority.selectedCompanies()).toEqual(["shop.example"]);
    // A message that states no selection, as from a tab that hasn't loaded it, leaves it alone and is granted nothing.
    authority.record("silent", "user");
    expect(authority.selectedCompanies()).toEqual(["shop.example"]);
    // Background work never edits what the composer shows.
    authority.record("scheduled", "background", selected("other.example"));
    expect(authority.selectedCompanies()).toEqual(["shop.example"]);
    authority.record("second", "user", selected("next.example"));
    // A late resend of an older message can't undo the newer choice.
    authority.record("first", "user", selected("shop.example"));
    expect(authority.selectedCompanies()).toEqual(["next.example"]);
    authority.record("cleared", "user", selected());
    expect(authority.selectedCompanies()).toEqual([]);
    authority.record("third", "user", selected("again.example"));
    authority.forgetCompanies();
    expect(authority.selectedCompanies()).toEqual([]);
  });
});

const USER = { key: "user", source: "user" as const, policy: 1, access: { companies: ["shop.example", "both.example"], uploads: [{ company: "shop.example", files: ["att_a"] }] } };
const SCHEDULED = { key: "scheduled", source: "background" as const, policy: 1, access: { companies: ["both.example", "other.example"], uploads: [] } };

it("keeps a photo permission to its own message, and a mixed run to what both inputs hold", () => {
  expect(runAccess(USER, [USER])).toEqual(USER.access);
  expect(runAccess(SCHEDULED, [SCHEDULED])).toEqual(SCHEDULED.access);
  // A later message of the User's still carries its own grant.
  const next = { ...USER, key: "next" };
  expect(runAccess(next, [USER, next])).toEqual(USER.access);
  // A Company-started run borrows the User's Companies, never their permission for one message's photo.
  expect(runAccess(USER, [])).toEqual({ companies: USER.access.companies, uploads: [] });
  expect(runAccess(USER, [SCHEDULED, USER])).toEqual({ companies: ["both.example"], uploads: [] });
  expect(runAccess(SCHEDULED, [USER, SCHEDULED])).toEqual({ companies: ["both.example"], uploads: [] });
  // A withdrawn schedule lends nothing to the message that steered into its run.
  expect(runAccess(USER, [{ ...SCHEDULED, policy: 0 }, USER])).toEqual({ companies: [], uploads: [] });
});
