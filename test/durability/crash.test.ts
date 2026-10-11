import { abortAllDurableObjects } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chat, connect, person } from "../agent-helpers";

/**
 * Crashes every Durable Object in this runtime, so it runs in its own
 * (test/durability/vitest.config.ts): nothing else is running here to be
 * reset by it.
 */
describe("a crash", () => {
  it("brings the whole history back after a reconnect and a crash", async () => {
    const identity = person();
    const first = await connect(identity);
    await chat(first.socket, first.client, "one", "echo: one (turn 1)");
    first.socket.close();

    const second = await connect(identity);
    expect(second.client.texts()).toEqual(["user: one", "assistant: echo: one (turn 1)"]);
    second.socket.close();

    await abortAllDurableObjects();

    const third = await connect(identity);
    expect(third.client.texts()).toEqual(["user: one", "assistant: echo: one (turn 1)"]);
    await chat(third.socket, third.client, "two", "echo: two (turn 2)");
    third.socket.close();
  });

});
