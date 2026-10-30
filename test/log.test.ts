/**
 * The wide events (src/log.ts, src/agent-log.ts): one per unit of work,
 * written when it ends, each with the deployment's environment; a turn's
 * event counts its model and tool calls; failures are level error with a
 * type and code; each agent keeps its newest events, pruned, for the User's
 * "Copy diagnostics"; a Company's error words (a name, a short password, a
 * one-time code) reach no event, diagnostics, Activity or protocol log, its
 * errors logged by class and code; and nothing but src/log.ts writes to the
 * console.
 * The privacy check against every secret a Poppy flow carries is in
 * test/protocol-log.test.ts, with the protocol log's; that a raw string
 * is a type error in any event field is test/log-types.ts, under typecheck.
 */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentLog, DIAGNOSTIC_EVENTS } from "../src/agent-log";
import { base64url } from "../src/base64url";
import { agentId as pseudonym, code, domain, id, literal, message, modelId, origin, redact, reportError, SERVICE, toolName, wideEvent } from "../src/log";
import { routeOf } from "../src/index";
import { agentNameFor } from "../src/session";
import { PoppyError } from "../src/poppy/client";
import { DiscoveryError } from "../src/poppy/discovery";
import { agent, authenticatedWsRequest, cards, chat, company, connect, fetchWorker, follow, ORIGIN, person, signInDirect, tool, until, wideEvents, type Agent } from "./agent-helpers";
import { obey } from "./worker";

type Event = Record<string, any>;

/** What every event carries about the deployment. */
function expectEnvironment(event: Event): void {
  expect(event).toMatchObject({ service: SERVICE, level: expect.stringMatching(/^(info|error)$/), timestamp: expect.any(String) });
  expect(typeof event.version_id).toBe("string");
  expect(event.version_id).not.toBe("");
  expect(event.commit).toMatch(/^([0-9a-f]{4,40}|unknown)$/);
  expect(event.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof event.duration_ms).toBe("number");
  expect(typeof event.outcome).toBe("string");
}

/** The agent's id as its events and the demo gateway carry it: its Durable Object id's first 32 hex digits. */
async function agentId(a: Agent): Promise<string> {
  return env.PersonalAgent.idFromName(await agentNameFor(a.identity)).toString().slice(0, 32);
}

/** Events since `mark`, from this agent (or the Worker's for it). */
async function eventsOf(a: Agent, mark: number): Promise<Event[]> {
  const id = await agentId(a);
  return (await wideEvents(a, mark)).filter((event) => event.agent_id === id);
}

describe("http events", () => {
  it("writes one per request: the route's template, the status, the request id, and who pseudonymously", async () => {
    const a = await agent();
    const mark = await a.stub.poppyLogMark();
    const ray = "8f00aa11bb22cc33-LHR";
    const response = await fetchWorker(new Request(`${ORIGIN}/api/attachments/att_${"A".repeat(22)}?x=secret-query`, { headers: { Cookie: a.cookie, "cf-ray": ray } }));
    expect(response.status).toBe(404);
    const events = (await wideEvents(a, mark)).filter((event) => event.kind === "http" && event.request_id === ray);
    expect(events).toHaveLength(1);
    const [event] = events as [Event];
    expectEnvironment(event);
    expect(event).toMatchObject({
      method: "GET",
      route: "/api/attachments/{id}",
      status: 404,
      outcome: "rejected",
      level: "info",
      signed_in: true,
      sign_in_provider: "google",
      is_owner: false,
      agent_id: await agentId(a)
    });
    const line = JSON.stringify(event);
    expect(line).not.toContain(a.identity.email!);
    expect(line).not.toContain(a.identity.sub);
    expect(line).not.toContain("secret-query");
    expect(line).not.toContain("att_");
  });

  it("calls a request without a session refused, and one that fails on the deployment's settings an error with its type and code", async () => {
    const a = await agent();
    const mark = await a.stub.poppyLogMark();
    expect((await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { "cf-ray": "ray-unauthorized" } }))).status).toBe(401);
    expect((await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: a.cookie, "cf-ray": "ray-config" } }), { OWNERS: { emails: [], github: {} } } as unknown as Partial<Env>)).status).toBe(500);
    const events = await wideEvents(a, mark);
    expect(events.find((event) => event.request_id === "ray-unauthorized")).toMatchObject({ route: "/api/me", status: 401, outcome: "refused", level: "info", signed_in: false });
    const failed = events.find((event) => event.request_id === "ray-config")!;
    expectEnvironment(failed);
    expect(failed).toMatchObject({ status: 500, outcome: "error", level: "error", error: { type: "ConfigError", code: "config" } });
    expect(failed.errors).toHaveLength(1);
  });

  it("names routes by template, never by an id or a query", () => {
    expect(routeOf("/api/memories/12")).toBe("/api/memories/{id}");
    expect(routeOf("/api/schedules/sch_abcdefghij")).toBe("/api/schedules/{id}");
    expect(routeOf("/auth/google/callback")).toBe("/auth/google/callback");
    expect(routeOf("/auth/evil")).toBe("/auth/{other}");
    expect(routeOf("/api/push/subscription/")).toBe("/api/push/subscription");
    expect(routeOf("/agents/personal-agent/abc")).toBe("{other}");
  });
});

describe("turn events", () => {
  it("settles in-flight tool diagnostics before emitting an ended turn, without holding the next run", async () => {
    const a = await agent();
    await runInDurableObject(a.stub, async (_instance, state) => {
      const log = new AgentLog({ sql: state.storage.sql, agentId: pseudonym(a.stub.id.toString())! });
      const before = log.events().length;
      log.onPiEvents([{ type: "run_start", inputs: [] }]);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const pending = log.tool(toolName("calculate")!, async () => {
        await held;
        reportError(new PoppyError("invalid_client", "private-company-refusal", 401), { source: literal("held-tool") });
        return { isError: true, details: { error: "invalid_client" } };
      }, "late-result");
      try {
        log.onPiEvents([{ type: "run_end", inputs: [] }]);
        expect(log.events().slice(before)).toEqual([]);
        log.onPiEvents([{ type: "run_start", inputs: [] }, { type: "run_end", inputs: [] }]);
        expect(log.events().slice(before).map(line => JSON.parse(line).tool_count)).toEqual([0]);
      } finally { release(); await pending; }
      const lines = log.events().slice(before);
      expect(lines).toHaveLength(2);
      const ended = JSON.parse(lines[1]!);
      expect(ended).toMatchObject({ tool_count: 1, tool_calls: [{ call_id: "late-result", error_code: "invalid_client" }], errors: [{ type: "PoppyError", code: "invalid_client" }] });
      expect(lines.join("\n")).not.toContain("private-company-refusal");
    });
  });

  it("writes one for the User's message, naming the socket's request and the model call", async () => {
    const a = await agent();
    const mark = await a.stub.poppyLogMark();
    const request = await authenticatedWsRequest({ cookie: a.cookie });
    request.headers.set("cf-ray", "ray-socket-1");
    const response = await fetchWorker(request);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const client = follow(socket);
    await client.until(() => client.frames.some((f) => f.type === "events"));
    await chat(socket, client, "hello there, private words");
    const turn = await until(async () => (await eventsOf(a, mark)).find((event) => event.kind === "turn"));
    expectEnvironment(turn);
    expect(turn).toMatchObject({
      trigger: "user",
      request_id: "ray-socket-1",
      lane: "demo",
      budget_pool: "workspace.example",
      outcome: "success",
      level: "info",
      stop_reason: "stop",
      model_calls: { count: 1, refused: 0, errors: {} },
      tool_count: 0
    });
    expect(turn.model_calls.output_tokens).toBeGreaterThan(0);
    expect(JSON.stringify(turn)).not.toContain("private words");
    // Exactly one, and the upgrade's own http event carries the same request id.
    expect((await eventsOf(a, mark)).filter((event) => event.kind === "turn")).toHaveLength(1);
    expect((await wideEvents(a, mark)).filter((event) => event.kind === "http" && event.request_id === "ray-socket-1")).toHaveLength(1);
    socket.close();
  });

  it("counts a turn's model calls and tool calls together, never the tool's arguments", async () => {
    const a = await agent();
    const mark = await a.stub.poppyLogMark();
    await a.stub.backgroundTurn(`[company message] work this out ${obey("calculate", { expression: "6 * 7123457" })}`, "op-log-tools");
    const turn = await until(async () => (await eventsOf(a, mark)).find((event) => event.kind === "turn" && event.turn_id === "op-log-tools"));
    expect(turn).toMatchObject({
      trigger: "company",
      outcome: "success",
      model_calls: { count: 2 },
      tool_count: 1,
      tools_used: "calculate",
      tool_outcomes: "calculate:success"
    });
    expect(turn.model_rounds).toBeGreaterThanOrEqual(1);
    expect(turn.tool_calls).toEqual([{ name: "calculate", outcome: "success", duration_ms: expect.any(Number), call_id: expect.any(String) }]);
    expect(JSON.stringify(turn)).not.toContain("7123457");
    expect((await eventsOf(a, mark)).filter((event) => event.kind === "turn")).toHaveLength(1);
  });

  it("calls a turn refused when the model may not be called, at level info", async () => {
    const sub = `s${crypto.randomUUID()}`;
    const a = await agent({ provider: "google", sub, email: `${sub}@nokey.example`, domain: "nokey.example" });
    const { socket, client } = await connect(a.identity);
    const mark = await a.stub.poppyLogMark();
    socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: "anyone there?" }));
    const turn = await until(async () => (await eventsOf(a, mark)).find((event) => event.kind === "turn"));
    expect(turn).toMatchObject({ trigger: "user", lane: "none", refused_reason: "no_key", outcome: "refused", level: "info", model_calls: { refused: 1, errors: { refused_no_key: 1 } } });
    await client.until(() => !client.view().running);
    socket.close();
  });
});

describe("job and ws events", () => {
  it("writes one for a reminder's run, counting its pushes by outcome", async () => {
    const a = await agent();
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const p256dh = base64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
    await a.stub.addPushSubscription(a.identity, { endpoint: "https://fcm.googleapis.com/fcm/send/log-test", p256dh, auth: base64url(crypto.getRandomValues(new Uint8Array(16))) });
    const noon = Date.UTC(2026, 9, 12, 12, 0, 0);
    await a.stub.setClock(noon);
    const reminder = await a.stub.scheduleCreate({ kind: "reminder", text: "Ring the plumber", when: { at: "2026-10-12T13:30" }, timeZone: "UTC" });
    const mark = await a.stub.poppyLogMark();
    await a.stub.scheduleAdvance(Date.UTC(2026, 9, 12, 13, 30));
    await runDurableObjectAlarm(a.stub);
    const jobs = (await eventsOf(a, mark)).filter((event) => event.kind === "job" && event.job === "schedule-due");
    expect(jobs).toHaveLength(1);
    expectEnvironment(jobs[0]!);
    expect(jobs[0]).toMatchObject({ schedule_id: reminder.id, schedule_kind: "reminder", run: "reminded", outcome: "success", push: { sent: 1 } });
    expect(JSON.stringify(jobs[0])).not.toContain("plumber");
    expect(JSON.stringify(jobs[0])).not.toContain("log-test");
  });

  it("writes one for a page frame that does work, and none for one that only reads", async () => {
    const a = await agent();
    const mark = await a.stub.poppyLogMark();
    await a.stub.poppyFrame({ type: "poppy.card.dismiss", id: "nothing-here" });
    await a.stub.poppyFrame({ type: "poppy.activity" });
    const frames = (await eventsOf(a, mark)).filter((event) => event.kind === "ws");
    expect(frames).toHaveLength(1);
    expectEnvironment(frames[0]!);
    expect(frames[0]).toMatchObject({ frame: "poppy.card.dismiss", outcome: "success", level: "info" });
  });
});

describe("diagnostics", () => {
  it("keeps the agent's newest events in its own storage, pruned, and gives them with the protocol log as text", async () => {
    const a = await agent();
    for (let i = 0; i < DIAGNOSTIC_EVENTS + 5; i++) await a.stub.poppyFrame({ type: "poppy.card.dismiss", id: `card-${i}` });
    const [{ n }] = JSON.parse(await a.stub.poppySql("SELECT COUNT(*) AS n FROM agent_log")) as [{ n: number }];
    expect(n).toBe(DIAGNOSTIC_EVENTS);
    const text = await a.stub.diagnostics();
    const lines = text.split("\n");
    expect(lines[0]).toBe("Poppy Demo Agent diagnostics");
    expect(lines[1]).toBe(`Agent: ${await agentId(a)}`);
    const events = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Event);
    expect(events).toHaveLength(DIAGNOSTIC_EVENTS);
    expect(events.every((event) => event.agent_id === (events[0]!.agent_id as string) && event.kind === "ws")).toBe(true);
    // Distinct markers prove which end is retained, through the real pruning trigger.
    await a.stub.poppySql("DELETE FROM agent_log");
    await a.stub.poppySql(`WITH RECURSIVE entries(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM entries WHERE n < ${DIAGNOSTIC_EVENTS + 5}
    ) INSERT INTO agent_log (at, kind, level, line)
      SELECT n, 'ws', 'info', json_object('marker', n) FROM entries ORDER BY n`);
    const retained = (await a.stub.diagnostics()).split("\n").filter((line) => line.startsWith("{"))
      .map((line) => (JSON.parse(line) as { marker: number }).marker);
    expect(retained).toEqual(Array.from({ length: DIAGNOSTIC_EVENTS }, (_, index) => index + 6));
    expect(text).toContain("Poppy protocol log");
    expect(text).not.toContain(a.identity.email!);
  });

  it("answers the page's frame on its own socket", async () => {
    const a = await agent(person());
    const { socket, client } = await connect(a.identity);
    socket.send(JSON.stringify({ type: "poppy.diagnostics" }));
    await client.until(() => client.frames.some((frame) => frame.type === "poppy.diagnostics"));
    const frame = client.frames.find((f) => f.type === "poppy.diagnostics") as unknown as { text: string; at: number };
    expect(frame.text).toMatch(/^Poppy Demo Agent diagnostics\nAgent: [0-9a-f]{32}\n/);
    socket.close();
  });
});

describe("redaction", () => {
  it("cuts URLs to their origin and drops emails, quoted text, credentials, long tokens and short codes", () => {
    expect(redact("GET https://shop.example/orders/ord_1?code=abc failed")).toBe("GET https://shop.example failed");
    expect(redact("ada@example.com is not on the allowlist")).toBe("[email] is not on the allowlist");
    expect(redact("Your task “Call Mum” didn't run")).toBe("Your task [text] didn't run");
    expect(redact("Authorization: Bearer eyJhbGciOi.payload.sig")).toBe("Authorization: Bearer [secret]");
    expect(redact(`token ${"x".repeat(40)} refused`)).toBe("token [secret] refused");
    expect(redact("a".repeat(500))).toHaveLength(8);
    expect(redact("OTP 482913, PIN 1234, HTTP 401")).toBe("OTP [number], PIN [number], HTTP 401");
  });

  it("can't find a name or a short password in a sentence, so a Company's words never reach it", () => {
    // Why errors built around a Company's words are logged by class and code alone (`ForeignText`).
    expect(redact(COMPANY_SAID)).toContain("hunter2");
    const error = new PoppyError("invalid_grant", `Mock Shop refused the token request (invalid_grant): ${COMPANY_SAID}`, 400);
    const line = wideEvent("job", { job: literal("test") }).fail(error).emit();
    expect(JSON.parse(line).error).toEqual({ type: "PoppyError", code: "invalid_grant" });
    expect(leaked(line)).toEqual([]);
    const discovery = JSON.parse(wideEvent("job", { job: literal("test") }).fail(new DiscoveryError(`organization.name is ${COMPANY_SAID}`)).emit());
    expect(discovery.error).toEqual({ type: "DiscoveryError" });
    // An error of ours keeps its message, redacted.
    expect(JSON.parse(wideEvent("job", { job: literal("test") }).fail(new Error("Code 482913 refused")).emit()).error.message).toBe("Code [number] refused");
  });
});

/** The audit's case: a Company's error description naming the User, with their short password and a one-time code. */
const COMPANY_SAID = "Ada Lovelace's password hunter2 is wrong, OTP 482913";

/** Which of the Company's words are in `text`. */
function leaked(text: string): string[] {
  return ["Ada", "Lovelace", "hunter2", "482913"].filter((words) => text.includes(words));
}

const exchange = {
  operation: "POST /orders/{order_id}/exchanges",
  params: { order_id: "ord_7Hk2" },
  body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
};

describe("a Company's words", () => {
  it("never reach an event, the diagnostics, Activity or the protocol log, though the model and the User see them", async () => {
    // Every JSON error this Company answers carries its words as `error_description` (or a JSON-RPC error's `message`).
    const c = await company({ errorDescription: COMPANY_SAID, ignoreWait: true });
    const a = await agent();
    const mark = await a.stub.poppyLogMark();
    await signInDirect(a, c);
    await tool(a, "poppy_message", { domain: c.domain, text: "Where is my order?" });
    await tool(a, "poppy_api_call", { domain: c.domain, ...exchange });
    // A write waits for the User's approval on our card.
    const approval = (await cards(a)).find((item) => item.kind === "approval" && item.open)!;
    expect(approval).toBeDefined();
    // Then its token endpoint refuses this agent (401 invalid_client), and every access token has expired.
    await c.stub.configure({ requireRegistration: ["someone-else"] });
    await c.stub.expireAccessTokens();
    // A tool call: the model is told what the Company said.
    const refused = await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /orders" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("hunter2");
    // Frames of the User's that need a token (approving the write) or the revocation endpoint (signing out).
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
    // The background jobs, due now: the conversation's read fails on the refused token, and its job's event records why.
    await a.stub.poppySql("UPDATE cf_agents_jobs SET time = ? WHERE capability = 'poppy' AND running = 0", Date.now());
    await runDurableObjectAlarm(a.stub);
    // Await the signed-in read's actual refusal before changing authority.
    // The privacy oracle must inspect completed work, not assume an alarm
    // has already run merely because it was requested.
    await until(async () => (await eventsOf(a, mark)).some(event =>
      (event.errors ?? []).some((error: Record<string, unknown>) => error.type === "PoppyError" && error.code === "invalid_client")));
    // Signing out reaches the revocation endpoint, which refuses too; its job runs now.
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await a.stub.poppySql("UPDATE cf_agents_jobs SET time = ? WHERE capability = 'poppy' AND running = 0", Date.now());
    await runDurableObjectAlarm(a.stub);

    const lines = (await a.stub.poppyLogsSince(mark)).join("\n");
    const events = await eventsOf(a, mark);
    const errors = events.flatMap((event) => (event.errors ?? []) as Array<Record<string, unknown>>);
    // The refusals were logged, by class and code: never the Company's words.
    expect(errors.some((error) => error.type === "PoppyError" && error.code === "invalid_client")).toBe(true);
    expect(errors.filter((error) => error.type === "PoppyError" && "message" in error)).toEqual([]);
    expect(leaked(lines)).toEqual([]);
    expect(leaked(await a.stub.diagnostics())).toEqual([]);
    expect(leaked(await a.stub.poppyActivity())).toEqual([]);
    const protocol = await a.stub.poppySql("SELECT * FROM poppy_protocol_log");
    expect(leaked(protocol)).toEqual([]);
    expect((await a.stub.poppyProtocol(c.hosts.issuer)).some((entry) => entry.error === "invalid_client")).toBe(true);
  });
});

describe("safe values", () => {
  const email = "ada@example.com";
  const token = `sk-ant-${"Ab3".repeat(12)}`;

  it("are made only by constructors that refuse emails, tokens, URLs with queries and text", () => {
    for (const unsafe of [email, token, "https://shop.example/orders?code=abc", "Call Mum at six", "x".repeat(200)]) {
      expect(code(unsafe)).toBeUndefined();
      expect(toolName(unsafe)).toBeUndefined();
      expect(modelId(unsafe)).toBeUndefined();
      expect(domain(unsafe)).toBeUndefined();
      // An id may be a long random run (a Company's operation id), so only its field's name keeps a token out of it.
      if (unsafe !== token) expect(id(unsafe)).toBeUndefined();
    }
    expect(code("insufficient_scope")).toBe("insufficient_scope");
    expect(code("TypeError")).toBe("TypeError");
    expect(id("schedule:sch_abc:1760270400000")).toBe("schedule:sch_abc:1760270400000");
    expect(id(crypto.randomUUID())).toMatch(/^[0-9a-f-]{36}$/);
    expect(origin("https://shop.example/orders/ord_1?code=abc#x")).toBe("https://shop.example");
    expect(origin("https://ada:secret@shop.example/")).toBe("https://shop.example");
    expect(origin(email)).toBeUndefined();
    expect(origin("javascript:alert(1)")).toBeUndefined();
    expect(domain("workspace.example")).toBe("workspace.example");
    expect(toolName("read_url")).toBe("read_url");
    expect(modelId("anthropic/claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5-5");
    expect(() => pseudonym("not-an-id")).toThrow(TypeError);
    expect(pseudonym("a".repeat(64))).toBe("a".repeat(32));
  });

  it("let free text in only redacted and bounded, and a literal that slipped past the types only as `unlisted`", () => {
    expect(message(`${email} sent Bearer ${token} to https://shop.example/x?y=z`)).toBe("[email] sent Bearer [secret] to https://shop.example");
    expect(message("w ".repeat(400)).length).toBeLessThanOrEqual(200);
    expect(literal("/api/memories/{id}")).toBe("/api/memories/{id}");
    expect(literal(email as "cast")).toBe("unlisted");
  });

  it("leave a field a constructor refused out of the event", () => {
    const event = wideEvent("job", { job: literal("test"), operation_id: id(email), issuer: origin("https://shop.example/a") });
    const line = JSON.parse(event.emit()) as Event;
    expect(line.job).toBe("test");
    expect(line.issuer).toBe("https://shop.example");
    expect("operation_id" in line).toBe(false);
    expect(JSON.stringify(line)).not.toContain(email);
  });
});

/** Every source file, by path: only src/log.ts writes to the console (and Cloudflare's four upstream files, which we don't edit). */
const sources = import.meta.glob(["../src/**/*.ts", "../src/**/*.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const UPSTREAM = new Set(["../src/protocol.ts", "../src/sockets.ts", "../src/view.ts", "../src/transcript.ts"]);

describe("one logger", () => {
  it("writes to the console only from src/log.ts", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== "../src/log.ts" && !UPSTREAM.has(path))
      .filter(([, text]) => /\bconsole\s*\.\s*(log|warn|error|info|debug|trace|dir|table)\b/.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
