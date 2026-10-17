/**
 * The own-key OpenAI lane, end to end: real turns on a person's own OpenAI
 * key through pi-ai's Responses API provider, against the fake OpenAI in
 * `fake-models.ts`, which calls the tools an `@@obey` line names, answers
 * read_url's reader and our summarizer, starts every answer with a reasoning
 * item, and refuses (400) a request that breaks OpenAI's rules: a tool's
 * output without its call, a call without the reasoning item it came with,
 * reasoning whose encrypted content changed, a strict tool with an optional
 * property. Each request is also recorded as pi built it (`ownKeyRequests`).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_QUESTION } from "../src/tools/extensions";
import { agent, chat, company, connect, fetchWorker, ORIGIN, person, until, type Agent } from "./agent-helpers";
import { obey } from "./worker";

const HTML = { "Content-Type": "text/html; charset=utf-8" };

/** Someone with their own OpenAI key and no demo, connected. */
async function onOpenAI(): Promise<Agent & { connection: Awaited<ReturnType<typeof connect>> }> {
  const a = await agent(person());
  const saved = await fetchWorker(
    new Request(`${ORIGIN}/api/model-key`, {
      method: "POST",
      headers: { Cookie: a.cookie, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", key: `sk-test-good-${crypto.randomUUID()}` })
    })
  );
  expect(saved.status).toBe(200);
  return { ...a, connection: await connect(a.identity) };
}

/** Send `text` and wait for the fake OpenAI's echo of it, every tool call it asked for made first. */
async function say(a: Awaited<ReturnType<typeof onOpenAI>>, text: string) {
  await chat(a.connection.socket, a.connection.client, text, `fake OpenAI (gpt-6.1-sol) answers: ${text}`);
}

/** Send `text` and wait for pi to finish with it, whatever the answer (a long prompt's echo is shortened). */
async function send(a: Awaited<ReturnType<typeof onOpenAI>>, text: string) {
  const { socket, client } = a.connection;
  socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: text }));
  await client.until(() => !client.view().running && client.texts().some((t) => t === `user: ${text}`));
  await client.until(() => !client.view().running);
}

/** A message that fills about 37k tokens of context, more than the 30k a summary keeps (as test/compaction.test.ts). */
const BULK = `[bulk] ${"words that fill the context ".repeat(5_300)}`;

describe("the own-key OpenAI lane", () => {
  it("runs read_url's reader on the person's own key: only the reader sees the page, and every call goes to OpenAI", async () => {
    const a = await onOpenAI();
    const page = "https://news.example.com/harbour";
    await a.stub.webServe(page, { headers: HTML, body: "<main><h1>Harbour reopens</h1><p>The harbour reopens on 3 November after repairs costing £4.2m.</p></main>" });
    await say(a, `When does it reopen? ${obey("read_url", { url: page, question: "When does the harbour reopen?" })}`);

    const requests = await a.stub.ownKeyRequests();
    const readers = requests.filter((request) => request.reader);
    expect(readers).toHaveLength(1);
    // The reader: the page and the question, no tools, no prompt but its own.
    expect(readers[0]).toMatchObject({ fenced: true, tools: [], reasoning: 0 });
    expect(Object.keys(readers[0]!.sections)).toEqual(["instructions"]);
    expect(readers[0]!.last).toMatch(/\n\nThe question: When does the harbour reopen\?$/);
    // The agent: never the page, the reader's answer as the tool's result, and the reasoning that came with its call sent back.
    const own = requests.filter((request) => !request.reader);
    expect(own.some((request) => request.fenced)).toBe(false);
    const last = own.at(-1)!;
    expect(last.results.at(-1)).toMatch(/<page-answer>\nreader: [^]*The harbour reopens on 3 November after repairs costing £4\.2m\.[^]*\n<\/page-answer>$/);
    expect(last.reasoning).toBeGreaterThan(0);
    // Nothing on the operator's demo lane.
    expect(await a.stub.demoCallCount()).toBe(0);
    a.connection.socket.close();
  });

  it("asks the reader for a summary without a question, and carries reasoning into the next turn", async () => {
    const a = await onOpenAI();
    const page = "https://news.example.com/story";
    await a.stub.webServe(page, { headers: HTML, body: "<main><p>A short story about a harbour.</p></main>" });
    await say(a, `What's this? ${obey("read_url", { url: page })}`);
    await say(a, "Thanks");
    const requests = await a.stub.ownKeyRequests();
    expect(requests.find((request) => request.reader)!.last.endsWith(`\n\nThe question: ${DEFAULT_QUESTION}`)).toBe(true);
    // The second turn's request carries the first turn's reasoning items, which the fake verified.
    expect(requests.at(-1)).toMatchObject({ last: "Thanks", reader: false });
    expect(requests.at(-1)!.reasoning).toBeGreaterThanOrEqual(2);
    a.connection.socket.close();
  });

  it("calls a Poppy tool on the person's own key", async () => {
    const c = await company();
    const a = await onOpenAI();
    await say(a, `What is ${c.domain}? ${obey("poppy_discover", { domain: c.domain })}`);
    const last = (await a.stub.ownKeyRequests()).at(-1)!;
    expect(last.tools).toContain("poppy_discover");
    expect(last.results).toHaveLength(1);
    expect(last.results[0]).toContain(c.domain);
    a.connection.socket.close();
  });

  it("summarises on the person's own key, through our summarizer, and puts the prompt first after it", async () => {
    const a = await onOpenAI();
    await say(a, "first: find me a jumper in size L");
    await send(a, BULK);
    await say(a, "[context 150100] just over the threshold");
    await say(a, "over");
    await until(async () => (await a.stub.activeEntries())[0]?.kind === "pi.compaction");
    await say(a, "after the summary");

    const requests = await a.stub.ownKeyRequests();
    expect(requests.filter((request) => request.summary)).toHaveLength(1);
    expect((await a.stub.activeEntries())[0]!.text).toContain("Faux summary of");
    const after = requests.at(-1)!;
    expect(after).toMatchObject({ summary: false, carriesSummary: true, last: "after the summary" });
    const start = after.roles.findIndex((role) => role !== "system");
    expect(start).toBeGreaterThan(0);
    expect(after.roles.slice(start)).not.toContain("system");
    expect(await a.stub.demoCallCount()).toBe(0);
    a.connection.socket.close();
  });
});
