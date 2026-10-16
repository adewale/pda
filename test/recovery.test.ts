/**
 * Bounded histories in actual workerd, using real Durable Object SQLite,
 * startup recovery, sockets and alarms. Peers/providers remain local fakes.
 * Generate the fault/interruption combinations explicitly so none can be
 * skipped by command preconditions. These are not arbitrary concurrent PBT.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agent, cards, chat, company, connect, fetchWorker, ORIGIN, person, requests, signInDirect, stopAgent, testEnv, tool, until, type Agent, type Company } from "./agent-helpers";

const exchange = (c: Company) => ({ domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
async function proposal() {
  const c = await company({ requireNonce: true, nonceScope: "origin", clientAssertionAud: "exact" });
  const a = await agent();
  await signInDirect(a, c);
  expect((await tool(a, "poppy_api_call", exchange(c))).isError).toBe(false);
  const card = (await cards(a)).find((item) => item.kind === "operation")!;
  expect(card).toMatchObject({ state: "proposed", open: true });
  expect((await c.stub.state()).performs).toBe(0);
  return { a, c, card };
}
const approve = (a: Agent, c: Company, card: Record<string, unknown>) => a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
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
      // Refresh the Session/DPoP nonce before arming a transport fault. The
      // fault must affect a valid confirm, not its preliminary challenge.
      const baseline = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
      expect(baseline.isError).toBe(false);
      expect(JSON.parse(baseline.text)).toMatchObject({ status: 200, body: { orders: [{ account: "acct_ada" }] } });
      expect((await requests(c)).some((request) => request.method === "GET" && request.url.endsWith("/orders") && request.status === 200)).toBe(true);
      expect((await c.stub.state()).performs).toBe(0);
    }
    await a.stub.poppyFault({ method: "POST", url: "/confirm", mode: fault });
    await approve(a, c, card);
    expect(await a.stub.poppyFaultsLeft()).toBe(0);
    expect((await c.stub.state()).performs).toBe(fault === "lose" ? 0 : 1);
    if (interruption === "after lost answer") await crash(a);
    await a.stub.poppyAdvance(60_000);
    await a.stub.poppyWaitForNotice("is succeeded");
    // A delayed/replayed card and another abrupt termination cannot perform again.
    await approve(a, c, card);
    await crash(a);
    await a.stub.poppyAdvance(60_000);
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.operations).toEqual([expect.objectContaining({ id: card.operationId, state: "succeeded", confirms: 1, approvedBy: "user" })]);
    expect((await cards(a)).find((item) => item.kind === "operation")).toMatchObject({ operationId: card.operationId, state: "succeeded", open: false });
    const confirms = (await requests(c)).filter((request) => request.method === "POST" && request.url.endsWith("/confirm"));
    expect(confirms).toHaveLength(1);
    const proposals = (await requests(c)).filter((request) => request.method === "POST" && request.url.endsWith("/exchanges"));
    expect(proposals.filter((request) => request.status === 202)).toHaveLength(1);
    expect(proposals.filter((request) => request.status !== 202)).toEqual([
      expect.objectContaining({ error: "use_dpop_nonce" })
    ]);
  });

  it("coalesces overlapping approvals while the first confirm answer is held", async () => {
    const { a, c, card } = await proposal();
    await a.stub.poppyFault({ method: "POST", url: "/confirm", mode: "hold" });
    const first = approve(a, c, card);
    try {
      await until(async () => (await c.stub.state()).performs === 1);
      await approve(a, c, card);
      expect((await c.stub.state()).operations[0]).toMatchObject({ confirms: 1 });
    } finally {
      expect(await a.stub.poppyReleaseHeld()).toBe(1);
      await first;
    }
    await crash(a);
    await a.stub.poppyAdvance(60_000);
    await a.stub.poppyWaitForNotice("is succeeded");
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("handles two approvals arriving together before either has completed", async () => {
    const { a, c, card } = await proposal();
    await Promise.all([approve(a, c, card), approve(a, c, card)]);
    expect((await c.stub.state()).operations[0]).toMatchObject({ state: "succeeded", confirms: 1 });
    expect((await c.stub.state()).performs).toBe(1);
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
    const c = await company({ refuseRevocations: 2 });
    const a = await agent();
    await signInDirect(a, c);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    expect(await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" })).toBe(true);
    expect((await c.stub.state()).accountTokens).toBe(1); // still live remotely
    await crash(a);
    expect(JSON.parse(await a.stub.poppySql("SELECT account FROM poppy_accounts"))).toEqual([]);
    const after = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    expect(after.isError).toBe(true);
    expect(JSON.parse(after.details)).toMatchObject({ error: "sign_in_required" });
    await a.stub.poppyAdvance(60_000);
    await until(async () => (await c.stub.state()).accountTokens === 0);
    expect(JSON.parse(await a.stub.poppySql("SELECT status FROM poppy_signouts"))).toEqual([{ status: "revoked" }]);
    await crash(a);
    expect(JSON.parse(await a.stub.poppySql("SELECT account FROM poppy_accounts"))).toEqual([]);
  });
});

const NOW = Date.UTC(2026, 9, 16, 12);

it("restores a missing confirmation job on actual object startup without asking for approval again", async () => {
  const { a, c, card } = await proposal();
  await a.stub.poppyFault({ method: "POST", url: "/confirm", mode: "gateway" });
  await approve(a, c, card);
  expect((await c.stub.state()).performs).toBe(1);
  await a.stub.poppySql("DELETE FROM cf_agents_jobs WHERE fn = 'poppy-operation'");
  await crash(a);
  await a.stub.poppyAdvance(0);
  await until(async () => JSON.parse(await a.stub.poppySql("SELECT operation FROM poppy_operations"))[0]?.operation.includes('"state":"succeeded"'));
  expect((await c.stub.state()).operations[0]).toMatchObject({ state: "succeeded", confirms: 1 });
  expect((await c.stub.state()).performs).toBe(1);
});

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
