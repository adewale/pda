import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ACTIVITY_LOG_LIMIT } from "../src/poppy/activity";
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
  const bootstrap = await worker.fetch(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: a.cookie } }), env);
  expect(bootstrap.status).toBe(200);
  const { workspaceId } = await bootstrap.json() as { workspaceId: string };
  const response = await worker.fetch(
    new Request(`${ORIGIN}/ws?workspace=${encodeURIComponent(workspaceId)}`, { headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: a.cookie } }),
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
      // 0.3 defines no scopes (4.7), so a sign-in's access is the Company's to name, not ours.
      access: null,
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
    const c = await company({ signIn: { direct: null, device: ["orders:read"], mediated: null }, deviceInterval: 30, deviceExpiresIn: 600 });
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "To see your orders" });
    const card = (await cards(a)).find((item) => item.kind === "signin_device")!;
    const p = await page(a);
    const task = p.latest().inProgress.find((item): item is ActivityTask => item.kind === "device_sign_in")!;
    expect(task.company).toBe(`Mock Shop ${c.id}`);
    expect(task.until).toBe(card.expiresAt);
    expect(task.stop).toEqual({ type: "poppy.signin.cancel", signInId: card.signInId });
    expect(find(p.latest().log, "sign_in")).toMatchObject({ access: null, result: "waiting", decidedBy: null });
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
    // Our card for the write first; approved, the Company answers with its terms, on a card of their own (Ops 4).
    const ours = (await cards(a)).find((item) => item.kind === "approval" && item.open)!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: ours.approvalId, decision: "approve" });
    const card = (await cards(a)).find((item) => item.kind === "approval" && item.open && item.terms)!;
    const entryOf = (frame: Activity) => frame.log.find((entry) => entry.id === `approval-${card.approvalId}`);
    const p = await page(a);
    expect(entryOf(p.latest())).toMatchObject({
      what: `Mock Shop ${c.id} asked for your approval`,
      quote: card.terms.summary,
      quoteBy: "company",
      how: "api",
      access: "view_and_change",
      decidedBy: null,
      result: "waiting"
    });
    // Our own card's request went, and what it asked is now the Company's to say.
    expect(p.latest().log.find((entry) => entry.id === `approval-${ours.approvalId}`)).toMatchObject({ quoteBy: "agent", decidedBy: "you", result: "waiting" });

    // The page is told as soon as it changes, without asking again.
    const before = p.frames.length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    const done = await p.next((frame) => entryOf(frame)?.result === "done", before);
    // What the approved API call returned stays out of the log.
    expect(entryOf(done)).toMatchObject({ decidedBy: "you", quote: card.terms.summary, quoteBy: "company" });
    expect(entryOf(done)!.outcome).toBeUndefined();

    // Past the cards' hour the card is gone; the activity log still has it.
    await a.stub.poppySql("UPDATE poppy_cards SET updated_at = 0, open = 0");
    const count = p.frames.length;
    p.socket.send(JSON.stringify({ type: "poppy.context" }));
    const later = await p.next(() => true, count);
    expect(entryOf(later)).toMatchObject({ result: "done", decidedBy: "you", quote: card.terms.summary });
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

describe("poppy.activity over a long history", () => {
  /** Rows numbered `from` to `to`, inserted in one statement. */
  const series = (from: number, to: number, insert: string) => `WITH RECURSIVE n(i) AS (SELECT ${from} UNION ALL SELECT i + 1 FROM n WHERE i < ${to}) ${insert}`;
  const ISSUER = "https://shop.example/";
  const T = 1_000_000;

  it("shows the newest entries in order and all open work, reading only each table's newest rows, through its time index", async () => {
    const a = await agent();
    await a.stub.poppyActivity(); // Migrates the Poppy tables.
    const sql = (query: string, ...bindings: unknown[]) => a.stub.poppySql(query, ...bindings);
    const terms = (summary: string) => `json_object('summary', ${summary}, 'expiresAt', '2026-10-28T12:00:00Z', 'highlights', json_array())`;
    // A thousand finished approvals of ours, and the newest 300 of everything else, interleaved in time.
    await sql(
      series(1, 1000, `INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, result, created_at)
        SELECT 'done-' || i, ?, 'default', 'Exchange ' || i, '{"kind":"openapi"}', 'done', NULL, ${T} + 5 * i FROM n`),
      ISSUER
    );
    // Operations the Company returned (Ops 4), approved on their terms cards: the newest through its agent, the rest by API.
    await sql(
      series(701, 1000, `INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, result, created_at, terms)
        SELECT 'terms-' || i, ?, 'default', 'Order ' || i,
          CASE WHEN i = 1000 THEN json_object('kind', 'message-approval', 'approval', json_object('operation_id', 'op-' || i, 'revision', 'r1'))
            ELSE json_object('kind', 'openapi', 'call', json_object('approval', json_object('operation_id', 'op-' || i, 'revision', 'r1'))) END,
          'done', NULL, ${T} + 5 * i + 1, ${terms("'Order ' || i")} FROM n`),
      ISSUER
    );
    await sql(
      series(701, 1000, `INSERT INTO poppy_signins (id, type, issuer, label, account, scopes, secret, expires_at, status, created_at)
        SELECT 's-' || i, 'direct', ?, 'default', 'default', 'orders:read', 'unused', 0, 'done', ${T} + 5 * i + 2 FROM n`),
      ISSUER
    );
    await sql(
      series(701, 1000, `INSERT INTO poppy_conversations (id, issuer, remote_id, label, direct, status, responder, last_event_at, created_at)
        SELECT 'c-' || i, ?, 'c-' || i, 'default', 0, 'closed', 'agent', ${T} + 5 * i + 3, ${T} + 5 * i + 3 FROM n`),
      ISSUER
    );
    await sql(
      series(701, 1000, `INSERT INTO poppy_messages (id, issuer, conversation_id, body, created_at)
        SELECT 'm-' || i, ?, 'c-' || i, json_object('message', json_object('author', json_object('type', 'agent'), 'text', 'Hello ' || i)), ${T} + 5 * i + 4 FROM n`),
      ISSUER
    );
    // Open work, older than anything the log shows.
    await sql(
      `INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at) VALUES ('exec-old', ?, 'default', 'Upload', '{"kind":"openapi"}', 'executing', 1)`,
      ISSUER
    );
    await sql(
      `INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at, terms)
       VALUES ('terms-open', ?, 'default', 'Refund', json_object('kind', 'openapi', 'call', json_object('approval', json_object('operation_id', 'op-open', 'revision', 'r1'))), 'executing', 2, ${terms("'Refund'")})`,
      ISSUER
    );
    await sql(
      "INSERT INTO poppy_conversations (id, issuer, remote_id, label, direct, status, responder, last_event_at, created_at) VALUES ('c-open', ?, 'c-open', 'default', 0, 'working', 'agent', 3, 3)",
      ISSUER
    );
    await sql(
      `INSERT INTO poppy_signins (id, type, issuer, label, account, scopes, secret, expires_at, status, created_at)
       VALUES ('s-device', 'device', ?, 'default', 'default', 'orders:read', 'unused', ?, 'pending', 5)`,
      ISSUER,
      Date.now() + 3_600_000
    );
    // A Direct Conversation older than any the log shows, and the newest message, sent in it.
    await sql(
      "INSERT INTO poppy_conversations (id, issuer, remote_id, label, direct, status, responder, last_event_at, created_at) VALUES ('d-old', ?, 'd-old', 'default', 1, 'closed', 'human', 4, 4)",
      ISSUER
    );
    await sql(
      "INSERT INTO poppy_messages (id, issuer, conversation_id, body, created_at) VALUES ('m-direct', ?, 'd-old', json_object('message', json_object('author', json_object('type', 'agent'), 'text', 'Thanks')), ?)",
      ISSUER,
      T + 5 * 1001
    );

    const expected: { id: string; at: number }[] = [{ id: "message-m-direct", at: T + 5 * 1001 }];
    for (let i = 1; i <= 1000; i++) {
      expected.push({ id: `approval-done-${i}`, at: T + 5 * i });
      if (i > 700) {
        expected.push({ id: `approval-terms-${i}`, at: T + 5 * i + 1 }, { id: `signin-s-${i}`, at: T + 5 * i + 2 });
        expected.push({ id: `conversation-c-${i}`, at: T + 5 * i + 3 }, { id: `message-m-${i}`, at: T + 5 * i + 4 });
      }
    }
    expected.sort((x, y) => y.at - x.at);

    const cost = await a.stub.poppyActivityCost();
    const frame = JSON.parse(cost.frame) as Activity;
    expect(frame.log.map(({ id, at }) => ({ id, at }))).toEqual(expected.slice(0, 200));
    expect(find(frame.log, "message")).toMatchObject({ id: "message-m-direct", how: "direct" });
    expect(frame.log.find((entry) => entry.id === "approval-terms-1000")).toMatchObject({ how: "company_agent", quoteBy: "company", quote: "Order 1000" });
    expect(frame.log.find((entry) => entry.id === "approval-terms-999")).toMatchObject({ how: "api", quoteBy: "company" });
    expect(frame.inProgress.map((task) => task.id).sort()).toEqual(["approval-exec-old", "approval-terms-open", "conversation-c-open", "signin-s-device"].sort());

    // Each query over a table with history reads a bounded number of rows (the newest or the open work),
    // through an index: never the whole table, so the 1,301 approvals aren't all read.
    const history = /\b(poppy_approvals|poppy_signins|poppy_signouts|poppy_conversations|poppy_messages)\b/;
    const historyQueries = cost.plans.filter((ran) => history.test(ran.query));
    // Approvals, sign-ins, sign-outs and conversations: their newest and their open work; and the newest messages.
    expect(historyQueries.length).toBeGreaterThanOrEqual(9);
    for (const { query, rowsRead, plan } of historyQueries) {
      expect(plan.filter((step) => /^SCAN \w+$/.test(step)), `a whole table read by: ${query}`).toEqual([]);
      expect(rowsRead, query).toBeLessThanOrEqual(3 * ACTIVITY_LOG_LIMIT);
    }
    const approvalsRead = historyQueries.filter(({ query }) => /\bFROM poppy_approvals\b/.test(query)).reduce((sum, { rowsRead }) => sum + rowsRead, 0);
    expect(approvalsRead).toBeLessThan(1000);
  });
});
