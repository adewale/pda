import { runInDurableObject } from "cloudflare:test";
import type { Context } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { TurnAuthority, type TurnReader } from "../src/tools/turn-authority";
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
