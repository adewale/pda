/**
 * The own-key Google Gemini lane, end to end: real turns on a person's own
 * Gemini key (`AIza-test-…`) through pi-ai's Google Generative AI provider,
 * against `fakeGemini` in `fake-models.ts`, which calls the tools an `@@obey`
 * line names, answers read_url's reader and our summarizer, starts every
 * answer with a thinking part carrying a base64 `thoughtSignature`, inspects
 * inline photo bytes, and refuses (400) a request that breaks Gemini's rules:
 * `?key=` in the URL, missing or tampered `thoughtSignature`, a
 * `functionResponse` without its `functionCall`, or malformed `inlineData`.
 */
import { describe, expect, it } from "vitest";
import { attachmentMarker, type AttachmentInfo } from "../src/attachments";
import { DEFAULT_QUESTION } from "../src/tools/extensions";
import { agent, chat, company, connect, fetchWorker, ORIGIN, person, until, type Agent } from "./agent-helpers";
import { fakeModels } from "./fake-models";
import { obey } from "./worker";

const HTML = { "Content-Type": "text/html; charset=utf-8" };

function jpeg(size: number, fill = 0x42): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

async function attachPhoto(cookie: string, file = jpeg(2048), name = "harbour.jpg"): Promise<AttachmentInfo> {
  const form = new FormData();
  form.append("file", new Blob([file], { type: "image/jpeg" }), name);
  const body = new Response(form);
  const bytes = new Uint8Array(await body.arrayBuffer());
  const response = await fetchWorker(
    new Request(`${ORIGIN}/api/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": body.headers.get("Content-Type")!,
        "Content-Length": String(bytes.byteLength),
        Origin: ORIGIN,
        Cookie: cookie
      },
      body: bytes
    })
  );
  expect(response.status).toBe(201);
  return (await response.json()) as AttachmentInfo;
}

/** Someone with their own Gemini key and no demo, connected. */
async function onGemini(): Promise<Agent & { connection: Awaited<ReturnType<typeof connect>> }> {
  const a = await agent(person());
  const saved = await fetchWorker(
    new Request(`${ORIGIN}/api/model-key`, {
      method: "POST",
      headers: { Cookie: a.cookie, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google", key: `AIza-test-good-${crypto.randomUUID()}` })
    })
  );
  expect(saved.status).toBe(200);
  return { ...a, connection: await connect(a.identity) };
}

/** Send `text` and wait for the fake Gemini's echo of it, every tool call it asked for made first. */
async function say(a: Awaited<ReturnType<typeof onGemini>>, text: string) {
  await chat(a.connection.socket, a.connection.client, text, `fake Gemini (gemini-4-hydrogen) answers: ${text}`);
}

/** Send `text` and wait for pi to finish with it, whatever the answer (a long prompt's echo is shortened). */
async function send(a: Awaited<ReturnType<typeof onGemini>>, text: string) {
  const { socket, client } = a.connection;
  socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: text }));
  await client.until(() => !client.view().running && client.texts().some((t) => t === `user: ${text}`));
  await client.until(() => !client.view().running);
}

/** A message that fills about 37k tokens of context, more than the 30k a summary keeps (as test/compaction.test.ts). */
const BULK = `[bulk] ${"words that fill the context ".repeat(5_300)}`;

describe("the own-key Gemini lane", () => {
  it("carries each answer's thought signature into the next turn", async () => {
    const a = await onGemini();
    await say(a, "Hello");
    await say(a, "Thanks");
    const requests = await a.stub.ownKeyRequests();
    expect(requests.map((request) => request.last)).toEqual(["Hello", "Thanks"]);
    // The first request has no earlier answer; the second carries the first answer's signed thinking block, which fakeGemini verified.
    expect(requests.map((request) => request.reasoning)).toEqual([0, 1]);
    expect(await a.stub.demoCallCount()).toBe(0);
    a.connection.socket.close();
  });

  it("runs read_url's reader on the person's own key: only the reader sees the page, and every call goes to Gemini", async () => {
    const a = await onGemini();
    const page = "https://news.example.com/harbour";
    await a.stub.webServe(page, { headers: HTML, body: "<main><h1>Harbour reopens</h1><p>The harbour reopens on 3 November after repairs costing £4.2m.</p></main>" });
    await say(a, `Read <${page}>. When does it reopen? ${obey("read_url", { url: page, question: "When does the harbour reopen?" })}`);

    const requests = await a.stub.ownKeyRequests();
    const readers = requests.filter((request) => request.reader);
    expect(readers).toHaveLength(1);
    expect(readers[0]).toMatchObject({ fenced: true, tools: [], reasoning: 0 });
    expect(Object.keys(readers[0]!.sections)).toEqual(["instructions"]);
    expect(readers[0]!.last).toMatch(/\n\nThe question: When does the harbour reopen\?$/);

    const own = requests.filter((request) => !request.reader);
    expect(own.some((request) => request.fenced)).toBe(false);
    const last = own.at(-1)!;
    expect(last.results.at(-1)).toMatch(/<page-answer>\nreader: [^]*The harbour reopens on 3 November after repairs costing £4\.2m\.[^]*\n<\/page-answer>$/);
    expect(last.reasoning).toBeGreaterThan(0);
    expect(await a.stub.demoCallCount()).toBe(0);
    a.connection.socket.close();
  });

  it("asks the reader for a summary without a question, and carries reasoning across a read", async () => {
    const a = await onGemini();
    const page = "https://news.example.com/story";
    await a.stub.webServe(page, { headers: HTML, body: "<main><p>A short story about a harbour.</p></main>" });
    await say(a, `What's this <${page}>? ${obey("read_url", { url: page })}`);
    await say(a, "Thanks");
    const requests = await a.stub.ownKeyRequests();
    expect(requests.find((request) => request.reader)!.last.endsWith(`\n\nThe question: ${DEFAULT_QUESTION}`)).toBe(true);
    expect(requests.at(-1)).toMatchObject({ last: "Thanks", reader: false });
    expect(requests.at(-1)!.reasoning).toBeGreaterThanOrEqual(2);
    a.connection.socket.close();
  });

  it("calls a Poppy tool on the person's own key", async () => {
    const c = await company();
    const a = await onGemini();
    await say(a, `What is ${c.domain}? ${obey("poppy_discover", { domain: c.domain })}`);
    const last = (await a.stub.ownKeyRequests()).at(-1)!;
    expect(last.tools).toContain("poppy_discover");
    expect(last.results).toHaveLength(1);
    expect(last.results[0]).toContain(c.domain);
    a.connection.socket.close();
  });

  it("sends attached photos as inlineData on the person's own Gemini key", async () => {
    const a = await onGemini();
    const photo = await attachPhoto(a.cookie, jpeg(2048), "harbour.jpg");
    await say(a, `Describe this harbour photo.\n\n${attachmentMarker(photo)}`);
    const last = (await a.stub.ownKeyRequests()).at(-1)!;
    expect(last.images).toHaveLength(1);
    expect(last.images[0]).toMatchObject({ mimeType: "image/jpeg", bytes: 2048 });
    expect(await a.stub.demoCallCount()).toBe(0);
    a.connection.socket.close();
  });

  it("summarises on the person's own key, through our summarizer, and puts the prompt first after it", async () => {
    const a = await onGemini();
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

  it("fakeGemini wire validation: rejects ?key= query auth, tampered thoughtSignatures, unmatched functionResponses, and invalid inlineData", async () => {
    const validKey = "AIza-test-good-0123456789abcdef";
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse";

    // ?key= in query string must be rejected even with a valid key.
    const queryKey = await fakeModels(new Request(`https://generativelanguage.googleapis.com/v1beta/models?key=${validKey}`));
    expect(queryKey?.status).toBe(400);

    // Function call without a preceding verified thoughtSignature must be rejected.
    const missingSig = await fakeModels(
      new Request(endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": validKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "hello" }] },
            { role: "model", parts: [{ functionCall: { id: "call_1", name: "poppy_discover", args: { domain: "acme.example" } } }] },
            { role: "user", parts: [{ functionResponse: { id: "call_1", name: "poppy_discover", response: { output: "ok" } } }] }
          ]
        })
      })
    );
    expect(missingSig?.status).toBe(400);

    // Tampered thoughtSignature on a model thinking part must be rejected.
    const tamperedSig = await fakeModels(
      new Request(endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": validKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "hello" }] },
            { role: "model", parts: [{ thought: true, text: "thinking fake_abc", thoughtSignature: btoa("gemini-sig:wrong") }, { text: "hi" }] },
            { role: "user", parts: [{ text: "again" }] }
          ]
        })
      })
    );
    expect(tamperedSig?.status).toBe(400);

    // Unmatched functionResponse must be rejected.
    const unmatchedResp = await fakeModels(
      new Request(endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": validKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ functionResponse: { id: "missing", name: "poppy_discover", response: { output: "ok" } } }] }]
        })
      })
    );
    expect(unmatchedResp?.status).toBe(400);

    // Malformed inlineData must be rejected.
    const badImage = await fakeModels(
      new Request(endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": validKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: "not-valid-base64!" } }] }]
        })
      })
    );
    expect(badImage?.status).toBe(400);
  });
});
