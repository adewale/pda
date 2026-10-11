import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ActivityEntry, ActivityTask, PoppyServerFrame } from "../src/poppy/wire";
import { agent, cards, company, signInDirect, tool, until, type Agent, type Company } from "./agent-helpers";
import worker from "./worker";

/**
 * The page's Activity view (`poppy.activity`): what the agent is doing and
 * has done at Companies, built from its own records. It reaches the page on
 * connect and whenever it changes, it outlives the cards' hour, and it never
 * carries a token, code, credential or sign-in secret. Every mock Company a
 * test creates must record no violations (checked after each test, in
 * agent-helpers.ts).
 */

const ORIGIN = "https://agent.test";
type Activity = Extract<PoppyServerFrame, { type: "poppy.activity" }>;

/** Direct Sign-In, the test playing the User on the Company's page. */
async function signIn(a: Agent, c: Company) {
  expect((await signInDirect(a, c))?.callback.status).toBe(200);
}

/** The chat page: one WebSocket that says hello with `poppy.context` and keeps every `poppy.activity`. */
async function page(a: Agent) {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/ws`, { headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: a.cookie } }),
    env
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const frames: Activity[] = [];
  const raw: string[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || !event.data.includes('"poppy.activity"')) return;
    raw.push(event.data);
    frames.push(JSON.parse(event.data) as Activity);
  });
  socket.send(JSON.stringify({ type: "poppy.context", locale: "en-GB", time_zone: "Europe/London" }));
  await until(() => frames.length > 0);
  return {
    socket,
    frames,
    raw,
    latest: () => frames.at(-1)!,
    /** Waits for an activity frame, sent after `after` frames, that passes `check`. */
    next: (check: (frame: Activity) => boolean, after = 0) => until(() => frames.slice(after).find(check))
  };
}

const exchange = {
  operation: "POST /orders/{order_id}/exchanges",
  params: { order_id: "ord_7Hk2" },
  body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
};

const find = (log: readonly ActivityEntry[], kind: ActivityEntry["kind"]) => log.find((entry) => entry.kind === kind);

/** Every value the agent keeps that must never reach the page. */
async function secrets(a: Agent): Promise<string[]> {
  const found: string[] = [];
  for (const query of [
    "SELECT token AS value FROM poppy_accounts",
    "SELECT secret AS value FROM poppy_signins",
    "SELECT state_hash AS value FROM poppy_signins WHERE state_hash IS NOT NULL",
    "SELECT session_id AS value FROM poppy_sessions"
  ]) {
    for (const row of JSON.parse(await a.stub.poppySql(query)) as { value: string }[]) found.push(row.value);
  }
  return found.filter((value) => value.length >= 8);
}

describe("poppy.activity", () => {
  it("reaches the page on connect, empty for a new agent", async () => {
    const a = await agent();
    const p = await page(a);
    expect(p.frames[0]).toEqual({ type: "poppy.activity", inProgress: [], log: [] });
    p.socket.close();
  });

  it("logs a sign-in, a conversation and a message, and never a token, secret or Session id", async () => {
    const c = await company();
    const a = await agent();
    await signIn(a, c);
    const sent = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "Where is my order?" })).text);
    const p = await page(a);
    const { log, inProgress } = p.latest();

    expect(find(log, "sign_in")).toMatchObject({
      company: `Mock Shop ${c.id}`,
      issuer: c.hosts.issuer,
      how: "sign_in",
      access: "view_and_change",
      decidedBy: "you",
      result: "done"
    });
    expect(find(log, "message")).toMatchObject({ how: "company_agent", quote: "Where is my order?", quoteBy: "agent", result: "done" });
    expect(find(log, "conversation")).toMatchObject({ how: "company_agent", result: "in_progress" });
    // The open conversation is running in the background, and the User can end it.
    const reading = inProgress.find((task) => task.kind === "conversation")!;
    expect(reading.stop).toEqual({ type: "poppy.direct.close", conversationId: sent.conversationId });

    // Newest first.
    expect(log.map((entry) => entry.at)).toEqual([...log.map((entry) => entry.at)].sort((x, y) => y - x));

    const text = p.raw.join("\n");
    for (const secret of await secrets(a)) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"(token|secret|state_hash|session_id|device_code|code_verifier|password)"/);
    p.socket.close();
  });

  it("shows a device sign-in in progress, with its expiry and a cancel frame, but never its codes", async () => {
    const c = await company({ signIn: { direct: null, device: ["poppy:read"], mediated: null }, deviceInterval: 30, deviceExpiresIn: 600 });
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "To see your orders" });
    const card = (await cards(a)).find((item) => item.kind === "signin_device")!;
    const p = await page(a);
    const task = p.latest().inProgress.find((item): item is ActivityTask => item.kind === "device_sign_in")!;
    expect(task.company).toBe(`Mock Shop ${c.id}`);
    expect(task.until).toBe(card.expiresAt);
    expect(task.stop).toEqual({ type: "poppy.signin.cancel", signInId: card.signInId });
    expect(find(p.latest().log, "sign_in")).toMatchObject({ access: "view", result: "waiting", decidedBy: null });
    expect(p.raw.join("\n")).not.toContain(card.userCode);
    for (const secret of await secrets(a)) expect(p.raw.join("\n")).not.toContain(secret);

    // Cancelling with the task's own frame ends it, and the log keeps the outcome.
    const before = p.frames.length;
    await a.stub.poppyFrame(task.stop as unknown as Record<string, unknown>);
    p.socket.send(JSON.stringify({ type: "poppy.context" }));
    const after = await p.next((frame) => !frame.inProgress.some((item) => item.kind === "device_sign_in"), before);
    expect(find(after.log, "sign_in")).toMatchObject({ result: "failed" });
    p.socket.close();
  });

  it("records who approved an operation, in the Company's words, after its card is gone", async () => {
    const c = await company();
    const a = await agent();
    await signIn(a, c);
    await tool(a, "poppy_api_call", { domain: c.domain, ...exchange });
    const card = (await cards(a)).find((item) => item.kind === "operation")!;
    const p = await page(a);
    expect(find(p.latest().log, "operation")).toMatchObject({
      quote: card.summary,
      quoteBy: "company",
      how: "api",
      access: "view_and_change",
      decidedBy: null,
      result: "waiting"
    });

    // The page is told as soon as it changes, without asking again.
    const before = p.frames.length;
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    const done = await p.next((frame) => find(frame.log, "operation")?.result === "done", before);
    const entry = find(done.log, "operation")!;
    expect(entry).toMatchObject({ decidedBy: "you", outcomeBy: "company" });
    // The Company's own words: the operation's result summary, as the mock sent it.
    expect(entry.outcome).toBe(
      "Exchange placed. The insulated jacket ships today, and a return label for the original jacket was emailed. $70.00 was charged to the card ending in 4242."
    );

    // Past the cards' hour the card is gone; the activity log still has it.
    await a.stub.poppySql("UPDATE poppy_cards SET updated_at = 0, open = 0");
    const count = p.frames.length;
    p.socket.send(JSON.stringify({ type: "poppy.context" }));
    const later = await p.next(() => true, count);
    expect(find(later.log, "operation")).toMatchObject({ result: "done", decidedBy: "you", quote: card.summary });
    p.socket.close();
  });

  it("says when a standing permission decided", async () => {
    const c = await company();
    const a = await agent();
    await signIn(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange", maxAmount: "100", currency: "USD", maxUses: 1 });
    await tool(a, "poppy_api_call", { domain: c.domain, ...exchange });
    const p = await page(a);
    expect(find(p.latest().log, "operation")).toMatchObject({ decidedBy: "standing_permission", result: "done" });
    p.socket.close();
  });

  it("logs a local approval with how it would act, and leaves an approved API call's response out", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signIn(a, c);
    await tool(a, "poppy_api_call", { domain: c.domain, ...exchange });
    const card = (await cards(a)).find((item) => item.kind === "approval")!;
    const p = await page(a);
    expect(find(p.latest().log, "approval")).toMatchObject({ how: "api", decidedBy: null, result: "waiting", quote: card.summary });
    const before = p.frames.length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    const done = await p.next((frame) => find(frame.log, "approval")?.result === "done", before);
    expect(find(done.log, "approval")!.decidedBy).toBe("you");
    expect(find(done.log, "approval")!.outcome).toBeUndefined();
    p.socket.close();
  });
});
