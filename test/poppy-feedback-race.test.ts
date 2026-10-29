import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { sendFeedback } from "../src/poppy/coverage";
import { agent, company, requests } from "./agent-helpers";

const task = "Pay with a gift card";
const description = "The task cannot be completed through the available interfaces.";

it("sends one acknowledged report for concurrent attempts at the same normalized task", async () => {
  const a = await agent();
  const c = await company({ feedback: true });
  await runInDurableObject(a.stub, async instance => {
    const client = instance.poppy.client;
    const C = await client.company(c.domain);
    const results = await Promise.all([
      sendFeedback(client, C, "main", task, description),
      sendFeedback(client, C, "main", "  pay with a gift card!  ", description)
    ]);
    expect(results.map(result => result.kind).sort()).toEqual(["accepted", "already_sent"]);
  });
  expect((await c.stub.state()).feedback).toHaveLength(1);
  expect((await requests(c)).filter(request => new URL(request.url).pathname.endsWith("/feedback"))).toHaveLength(1);
});

it("lets a queued report retry after the first attempt fails before dispatch", async () => {
  const a = await agent();
  const c = await company({ feedback: true });
  await runInDurableObject(a.stub, async instance => {
    const client = instance.poppy.client;
    const C = await client.company(c.domain);
    const original = client.host.fetcher;
    let first = true;
    const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
      if (new URL(request.url).pathname.endsWith("/feedback") && first) {
        first = false;
        throw new Error("Synthetic failure before Company dispatch");
      }
      return original(request);
    });
    try {
      const results = await Promise.allSettled([
        sendFeedback(client, C, "main", task, description),
        sendFeedback(client, C, "main", task, description)
      ]);
      expect(results[0]?.status).toBe("rejected");
      expect(results[1]).toMatchObject({ status: "fulfilled", value: { kind: "accepted" } });
      expect(await sendFeedback(client, C, "main", task, description)).toEqual({ kind: "already_sent" });
    } finally { remote.mockRestore(); }
  });
  expect((await c.stub.state()).feedback).toHaveLength(1);
});

it("does not serialize or suppress a different task or Company behind an unrelated report", async () => {
  const a = await agent();
  const first = await company({ feedback: true });
  const second = await company({ feedback: true });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  await runInDurableObject(a.stub, async instance => {
    const client = instance.poppy.client;
    const A = await client.company(first.domain);
    const B = await client.company(second.domain);
    const fetcher = client.host.fetcher;
    let pending: Promise<unknown> | undefined;
    let paused = false;
    const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
      if (!paused && new URL(request.url).origin === new URL(A.feedback!.endpoint).origin && new URL(request.url).pathname.endsWith("/feedback")) {
        paused = true;
        entered();
        await held;
      }
      return fetcher(request);
    });
    try {
      pending = sendFeedback(client, A, "main", task, description);
      await reached;
      const others = await Promise.all([
        sendFeedback(client, A, "main", "Pick up an order", description),
        sendFeedback(client, B, "main", task, description)
      ]);
      expect(others).toEqual([{ kind: "accepted" }, { kind: "accepted" }]);
    } finally { release(); await pending; remote.mockRestore(); }
  });
  expect((await first.stub.state()).feedback).toHaveLength(2);
  expect((await second.stub.state()).feedback).toHaveLength(1);
});

it("keeps the same task's feedback independent for two concurrent Users", async () => {
  const c = await company({ feedback: true });
  const users = await Promise.all([agent(), agent()]);
  const results = await Promise.all(users.map(user => user.stub.poppyTool("poppy_feedback", { domain: c.domain, task, description })));
  for (const result of results) expect(JSON.parse(result.text)).toMatchObject({ status: "sent" });
  expect((await c.stub.state()).feedback).toHaveLength(2);
});
