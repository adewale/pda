import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { sendAgentMessage } from "../src/poppy/agent-message";
import { PoppyError } from "../src/poppy/client";
import { agent, company, requests } from "./agent-helpers";

it("checks message withdrawal after token preparation and still sends a fresh authorized message", async () => {
  const a = await agent();
  const c = await company();
  const endpoint = await runInDurableObject(a.stub, async instance => {
    const client = instance.poppy.client;
    const found = await client.company(c.domain);
    const held = await client.token(found, { label: "main" });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const suspended = new Promise<void>(resolve => { release = resolve; });
    const token = vi.spyOn(client, "token").mockImplementationOnce(async () => {
      entered();
      await suspended;
      return held;
    });
    let active = true;
    const beforeDispatch = () => { if (!active) throw new PoppyError("refused", "Task stopped before message dispatch", 0); };
    try {
      const pending = sendAgentMessage(client, found, { callKey: "withdrawn-message", text: "Please check my order", beforeDispatch });
      const refused = expect(pending).rejects.toMatchObject({ code: "refused" });
      await started;
      active = false;
      release();
      await refused;
    } finally { release(); token.mockRestore(); }
    return found.conversations!.endpoint;
  });
  expect((await requests(c)).filter(request => request.url.startsWith(endpoint) && request.method === "POST")).toEqual([]);
  await runInDurableObject(a.stub, async instance => {
    const client = instance.poppy.client;
    const found = await client.company(c.domain);
    expect(await sendAgentMessage(client, found, { callKey: "fresh-message", text: "Please check my order", beforeDispatch: () => {} })).toMatchObject({ kind: "sent" });
  });
  expect((await requests(c)).filter(request => request.url.startsWith(endpoint) && request.method === "POST")).toHaveLength(1);
});
