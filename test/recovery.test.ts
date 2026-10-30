/**
 * Bounded histories in actual workerd, using real Durable Object SQLite,
 * startup recovery, sockets and alarms. Peers/providers remain local fakes.
 * Generate the fault/interruption combinations explicitly so none can be
 * skipped by command preconditions. These are not arbitrary concurrent PBT.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agent, cards, chat, company, connect, fetchWorker, ORIGIN, person, requests, signInDirect, stopAgent, testEnv, until, type Agent, type Company } from "./agent-helpers";
import { tool } from "./agent-helpers";

const exchange = (c: Company) => ({ domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
/**
 * An operation waiting for the User: the task request received Company
 * terms (Ops 4); their single card sends the stored request with
 * `Poppy-Approval` (Ops 6).
 */
async function proposal() {
  const c = await company({ requireNonce: true, nonceScope: "origin" });
  const a = await agent();
  await signInDirect(a, c);
  expect((await tool(a, "poppy_api_call", exchange(c))).isError).toBe(false);
  const card = (await cards(a)).find((item) => item.kind === "approval" && item.open && item.terms)!;
  expect(card).toMatchObject({ status: "pending", open: true });
  expect((await c.stub.state()).performs).toBe(0);
  return { a, c, card };
}
const approve = (a: Agent, card: Record<string, unknown>) => a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
/** The exchange requests that reached the Company, with and without the approval. */
async function exchanges(c: Company) {
  const all = (await requests(c)).filter((request) => request.method === "POST" && request.url.endsWith("/exchanges"));
  return { approved: all.filter((request) => request.headers["poppy-approval"]), asked: all.filter((request) => !request.headers["poppy-approval"]) };
}
async function crash(a: Agent): Promise<void> {
  // Graceful eviction drains in-flight work. Abort this one object to model
  // abrupt termination, retaining SQLite and leaving the Company untouched.
  await expect(runInDurableObject(a.stub, (_instance, state) => state.abort("local recovery interruption"))).rejects.toThrow("local recovery interruption");
  a.stub = (await agent(a.identity)).stub; // an aborted RPC stub must be replaced
}
const histories = (["lose", "throw", "gateway"] as const).flatMap((fault) => (["before approval", "after lost answer"] as const).map((interruption) => ({ fault, interruption })));

describe("approval recovery in workerd", () => {
  it.each(histories)("keeps the approved identity through $fault and termination $interruption", async ({ fault, interruption }) => {
    const { a, c, card } = await proposal();
    if (interruption === "before approval") {
      await crash(a);
      // Refresh the access token and DPoP nonce before arming a transport fault. The
      // fault must affect the approved request, not its preliminary challenge.
      const baseline = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
      expect(baseline.isError).toBe(false);
      expect(JSON.parse(baseline.text)).toMatchObject({ status: 200, body: { orders: [{ account: "acct_ada" }] } });
      expect((await requests(c)).some((request) => request.method === "GET" && request.url.endsWith("/orders") && request.status === 200)).toBe(true);
      expect((await c.stub.state()).performs).toBe(0);
    }
    // The card survived the termination, still the User's to decide.
    expect((await cards(a)).find((item) => item.approvalId === card.approvalId)).toMatchObject({ status: "pending", open: true });
    await a.stub.poppyFault({ method: "POST", url: "/exchanges", mode: fault });
    await approve(a, card);
    expect(await a.stub.poppyFaultsLeft()).toBe(0);
    // `lose` fails before the request leaves; the others reach the Company, which performs it.
    const reached = fault === "lose" ? 0 : 1;
    expect((await c.stub.state()).performs).toBe(reached);
    if (interruption === "after lost answer") await crash(a);
    await a.stub.poppyAdvance(60_000);
    // No answer, or one we can't trust: the User and the model are told it may have happened (Safety).
    // A gateway can lose the answer after the action happened, so 504 is also uncertain.
    await a.stub.poppyWaitForNotice(fault === "gateway" ? "answered HTTP 504" : "may or may not have happened");
    const beforeRepeat = (await exchanges(c)).approved.length;
    const repeat = await tool(a, "poppy_api_call", exchange(c));
    expect(repeat.isError).toBe(true);
    expect(repeat.text).toContain("unknown outcome");
    expect((await exchanges(c)).approved).toHaveLength(beforeRepeat);
    // A delayed/replayed card and another abrupt termination cannot send it again.
    await approve(a, card);
    await crash(a);
    await a.stub.poppyAdvance(60_000);
    const state = await c.stub.state();
    expect(state.performs).toBe(reached);
    expect(state.operations).toEqual([
      expect.objectContaining({ state: reached ? "succeeded" : "proposed", confirms: reached, approvedBy: reached ? "user" : null })
    ]);
    expect((await cards(a)).find((item) => item.approvalId === card.approvalId)).toMatchObject({
      status: "unknown",
      open: false
    });
    const { approved, asked } = await exchanges(c);
    expect(approved).toHaveLength(reached);
    // Asked once without the approval, after the one nonce challenge at that origin.
    expect(asked.filter((request) => request.status === 403)).toHaveLength(1);
    expect(asked.filter((request) => request.status !== 403)).toEqual([expect.objectContaining({ error: "use_dpop_nonce" })]);
  });

  it("coalesces overlapping approvals while the first answer is held", async () => {
    const { a, c, card } = await proposal();
    await a.stub.poppyFault({ method: "POST", url: "/exchanges", mode: "hold" });
    const first = approve(a, card);
    try {
      await until(async () => (await c.stub.state()).performs === 1);
      await approve(a, card);
      expect((await c.stub.state()).operations[0]).toMatchObject({ confirms: 1 });
    } finally {
      expect(await a.stub.poppyReleaseHeld()).toBe(1);
      await first;
    }
    await crash(a);
    await a.stub.poppyAdvance(60_000);
    await a.stub.poppyWaitForNotice("may or may not have happened");
    expect((await c.stub.state()).performs).toBe(1);
    expect((await exchanges(c)).approved).toHaveLength(1);
  });

  it("handles two approvals arriving together before either has completed", async () => {
    const { a, c, card } = await proposal();
    await Promise.all([approve(a, card), approve(a, card)]);
    expect((await c.stub.state()).operations[0]).toMatchObject({ state: "succeeded", confirms: 1 });
    expect((await c.stub.state()).performs).toBe(1);
    expect((await cards(a)).find((item) => item.approvalId === card.approvalId)).toMatchObject({ status: "done", open: false });
  });
});

describe("socket recovery and isolation in workerd", () => {
  it("deduplicates simultaneous sockets and a post-termination resend, retaining the payload only for its owner", async () => {
    const identity = person();
    const a = await agent(identity);
    const first = await connect(identity);
    const second = await connect(identity);
    const operationId = crypto.randomUUID();
    const text = "private recovery payload café 🚲";
    const frame = JSON.stringify({ type: "submit", id: operationId, operationId, input: text, whenBusy: "followUp" });
    try {
      first.socket.send(frame);
      second.socket.send(frame);
      await Promise.all([first, second].map(({ client }) => client.until(() => client.frames.some((frame) => frame.type === "result" && (frame as { id?: string }).id === operationId))));
      await Promise.all([first, second].map(({ client }) => client.until(() => client.texts().includes(`assistant: echo: ${text} (turn 1)`) && !client.view().running)));
      expect(await a.stub.demoCallCount()).toBe(1);
    } finally {
      first.socket.close(); second.socket.close();
    }
    await crash(a);
    const recovered = await connect(identity);
    const other = await connect(person());
    try {
      recovered.socket.send(frame);
      await recovered.client.until(() => recovered.client.frames.some((frame) => frame.type === "result" && (frame as { id?: string }).id === operationId));
      await chat(recovered.socket, recovered.client, "next", "echo: next (turn 2)");
      expect(recovered.client.texts().filter((entry) => entry === `user: ${text}`)).toHaveLength(1);
      expect(await a.stub.demoCallCount()).toBe(2);
      expect(other.client.texts()).toEqual([]);
    } finally {
      recovered.socket.close(); other.socket.close();
    }
  });

  it("keeps local account access revoked through termination while remote revocation retries remain pending", async () => {
    // The one revocation a 0.3 sign-out sends (the refresh token's) is refused once; its retry is pending.
    const c = await company({ refuseRevocations: 1 });
    const a = await agent();
    await signInDirect(a, c);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    expect(await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" })).toBe(true);
    expect((await c.stub.state()).accountTokens).toBe(1); // still live remotely
    expect((await requests(c)).filter((request) => request.url === c.hosts.revocationEndpoint).map((request) => request.status)).toEqual([401]);
    await crash(a);
    expect(JSON.parse(await a.stub.poppySql("SELECT account FROM poppy_accounts"))).toEqual([]);
    const after = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    // Signed out here: the Session goes on with its header alone, and the Company asks for the account (0.3 7).
    expect(after.isError).toBe(true);
    expect(JSON.parse(after.details)).toMatchObject({ error: "insufficient_scope" });
    expect((await requests(c)).filter((request) => new URL(request.url).pathname === "/orders").at(-1)!.headers.authorization).toBeUndefined();
    await a.stub.poppyAdvance(60_000);
    await until(async () => (await c.stub.state()).accountTokens === 0);
    expect(JSON.parse(await a.stub.poppySql("SELECT status FROM poppy_signouts"))).toEqual([{ status: "revoked" }]);
    await crash(a);
    expect(JSON.parse(await a.stub.poppySql("SELECT account FROM poppy_accounts"))).toEqual([]);
  });
});

const NOW = Date.UTC(2026, 9, 16, 12);

it("waits for another alarm's due revocation before returning from clock advancement", async () => {
  const c = await company({ refuseRevocations: 2 });
  const a = await agent();
  await signInDirect(a, c);
  await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
  await c.stub.configure({ refuseRevocations: 0 });
  await a.stub.poppyFault({ method: "POST", url: c.hosts.revocationEndpoint, mode: "hold" });
  const first = a.stub.poppyAdvance(60_000);
  let second: Promise<void> | undefined;
  try {
    await until(async () => (await c.stub.state()).accountTokens === 0);
    second = a.stub.poppyAdvance(0);
    expect(await Promise.race([second.then(() => "returned"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 200))])).toBe("blocked");
    expect(JSON.parse(await a.stub.poppySql("SELECT attempts FROM poppy_signouts"))).toEqual([{ attempts: 1 }]);
  } finally {
    await until(async () => (await a.stub.poppyReleaseHeld()) > 0);
    await first;
    await second;
  }
  expect(JSON.parse(await a.stub.poppySql("SELECT attempts FROM poppy_signouts"))).toEqual([{ attempts: 2 }]);
});

it("cancels durable jobs and an in-flight conversation reader when its test's agent is stopped", async () => {
  const c = await company();
  const a = await agent();
  await a.stub.poppyFault({ method: "GET", url: "/events", mode: "hold" });
  expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
  await until(async () => (await a.stub.poppyFaultsLeft()) === 0);
  await stopAgent(a.stub);
  const clean = await runInDurableObject(testEnv.PersonalAgent.get(a.stub.id), async (_instance, state) => ({
    alarm: await state.storage.getAlarm(),
    jobs: state.storage.sql.exec("SELECT id FROM cf_agents_jobs").toArray()
  }));
  expect(clean).toEqual({ alarm: null, jobs: [] });
  const count = (await requests(c)).length;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect((await requests(c)).length).toBe(count);
});

describe("durable alarm histories in workerd", () => {
  it.each([0, 1, 3])("recovers a missing job and preserves %i failed delivery attempts across evictions", async (failures) => {
    const a = await agent();
    const { stub } = a;
    await stub.setClock(NOW);
    const reminder = await stub.scheduleCreate({ kind: "reminder", text: "Recovered reminder", when: { in: "PT1H" }, timeZone: "UTC" });
    expect(reminder.error).toBeUndefined();
    await stub.poppySql("DELETE FROM cf_agents_jobs WHERE id = ?", `schedule:${reminder.id}`);
    await evictDurableObject(stub);
    // Wake via the actual signed-in Settings route, not a raw SQL test RPC.
    expect((await fetchWorker(new Request(`${ORIGIN}/api/schedules`, { headers: { Cookie: a.cookie } }))).status).toBe(200);
    expect(JSON.parse(await stub.poppySql("SELECT id FROM cf_agents_jobs WHERE id = ?", `schedule:${reminder.id}`))).toEqual([{ id: `schedule:${reminder.id}` }]);
    const times = [NOW + 3_600_000, NOW + 3_660_000, NOW + 3_960_000, NOW + 5_760_000];
    for (let attempt = 0; attempt <= failures; attempt++) {
      if (attempt < failures) await stub.scheduleFailReminderCards(1);
      await stub.scheduleAdvance(times[attempt]!);
      await runDurableObjectAlarm(stub);
      const runs = JSON.parse(await stub.poppySql("SELECT outcome, due_at FROM schedule_runs WHERE schedule_id = ?", reminder.id));
      if (attempt < failures) {
        expect(runs).toEqual([]);
        expect(JSON.parse(await stub.poppySql("SELECT attempts FROM schedules WHERE id = ?", reminder.id))).toEqual([{ attempts: attempt + 1 }]);
      } else expect(runs).toEqual([{ outcome: "reminded", due_at: times[0] }]);
      await evictDurableObject(stub);
    }
    await stub.scheduleAdvance(NOW + 86_400_000);
    await runDurableObjectAlarm(stub);
    expect((await cards({ stub })).filter((card) => String(card.id).startsWith(`reminder-${reminder.id}-`))).toEqual([expect.objectContaining({ id: `reminder-${reminder.id}-${times[0]}`, text: "Reminder: Recovered reminder" })]);
    expect(JSON.parse(await stub.poppySql("SELECT outcome FROM schedule_runs WHERE schedule_id = ?", reminder.id))).toEqual([{ outcome: "reminded" }]);
    expect(await stub.demoCallCount()).toBe(0);
  });

  it("rechecks authorization after termination before a due task, then resumes it once when access returns", async () => {
    const identity = person();
    const a = await agent(identity);
    let { stub } = a;
    await stub.setClock(NOW);
    const task = await stub.scheduleCreate({ kind: "task", text: "Recovered task", when: { in: "PT1H" }, timeZone: "UTC" });
    await stub.deploymentOverride({ SIGNIN_ALLOWLIST: { emails: [], domains: [], github: {} } });
    await crash(a);
    stub = a.stub;
    await stub.scheduleAdvance(NOW + 3_600_000);
    await runDurableObjectAlarm(stub);
    expect(await stub.demoCallCount()).toBe(0);
    expect(JSON.parse(await stub.poppySql("SELECT outcome FROM schedule_runs"))).toEqual([]);
    expect(JSON.parse(await stub.poppySql("SELECT status FROM schedules WHERE id = ?", task.id))).toEqual([{ status: "paused" }]);
    await stub.deploymentOverride({});
    await agent(identity); // actual signed-in identity path resumes the paused task
    await stub.scheduleAdvance(NOW + 3_600_000);
    await runDurableObjectAlarm(stub);
    await stub.scheduleSettled();
    await crash(a);
    stub = a.stub;
    await stub.scheduleAdvance(NOW + 86_400_000);
    await runDurableObjectAlarm(stub);
    expect(await stub.demoCallCount()).toBe(1);
    expect(JSON.parse(await stub.poppySql("SELECT outcome FROM schedule_runs WHERE schedule_id = ?", task.id))).toEqual([{ outcome: "done" }]);
  });
});
