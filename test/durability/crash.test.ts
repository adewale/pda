import { abortAllDurableObjects } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agent, chat, connect, person, until, wideEvents } from "../agent-helpers";
import { obey } from "../worker";

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

  // pi closes itself for good after a storage error: every later call fails.
  // The agent resets its object, so the next request opens pi again.
  it("reopens pi after a storage error, with the whole history", async () => {
    const identity = person();
    const a = await agent(identity);
    const mark = await a.stub.poppyLogMark();
    const first = await connect(identity);
    await chat(first.socket, first.client, "one", "echo: one (turn 1)");

    await a.stub.piFailNextWrite();
    first.socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: "two" }));
    // The reset breaks the stub the test holds, as it does every stub to the object: ask through a new one.
    const failed = await until(async () => {
      try {
        return (await wideEvents(await agent(identity), mark)).find((event) => event.job === "pi.session_failed");
      } catch {
        return undefined; // reached the object while it was being reset
      }
    });
    expect(failed).toMatchObject({ kind: "job", level: "error", outcome: "error" });
    // Logged by class only: pi's message may carry a tool's words.
    expect(JSON.stringify(failed)).not.toContain("disk I/O");

    const second = await connect(identity);
    expect(second.client.texts().slice(0, 2)).toEqual(["user: one", "assistant: echo: one (turn 1)"]);
    await chat(second.socket, second.client, "three");
    second.socket.close();
  });


  // read_url is replay-safe: after a crash pi runs it again, and it finds
  // the page it read and the reader it started, kept with the call.
  it("reads a page once and starts one reader, though the agent crashed while the reader was answering", async () => {
    const identity = person();
    const a = await agent(identity);
    const page = "https://news.example.com/harbour";
    await a.stub.webServe(page, { headers: { "Content-Type": "text/html; charset=utf-8" }, body: "<main><p>The harbour reopens on 3 November.</p></main>" });
    await a.stub.holdReaders();
    const first = await connect(identity);
    first.socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: `When? ${obey("read_url", { url: page, question: "When does it reopen?" })}` }));
    await until(async () => (await a.stub.demoRequests()).some((request) => request.reader));

    await abortAllDurableObjects();
    const stub = (await agent(identity)).stub;
    const second = await connect(identity);
    // pi resumes the run, and the reader is asked again: in the same conversation, for the same submission.
    await until(async () => (await stub.demoRequests()).filter((request) => request.reader).length >= 2);
    await stub.releaseReaders();
    await second.client.until(() => second.client.texts().some((text) => text.startsWith("assistant: echo: When?")));

    expect((await stub.webRequests()).map((request) => request.url)).toEqual([page]);
    expect(await stub.piConversationCount()).toBe(2);
    const answer = (await stub.demoRequests()).filter((request) => !request.reader).at(-1)!.results.at(-1)!;
    expect(answer).toContain("reader: The harbour reopens on 3 November.");
    second.socket.close();
  });
});
