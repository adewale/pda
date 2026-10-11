import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type AssistantMessage,
  type Message,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { PersonalAgent as ProductionAgent, type ModelSource } from "../src/agent";
import { readModelConfig } from "../src/config";
import worker from "../src/index";
import type { Fetcher } from "../src/poppy/fetch";
import { readConversation } from "../src/poppy/conversations";
import { Sealer } from "../src/poppy/store";
import { poppyExtension } from "../src/poppy/tools";
import { CLOCK_HEADER, companyIdFromHost, type MockCompany } from "./mock-company";

type TestEnv = Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> };

/**
 * Where the test agent's Poppy requests go: our own origin to our Worker
 * (so Companies can fetch our client metadata and keys), Company hosts to
 * the mock Company, anything else nowhere. With a fake clock, requests to
 * the mock carry its time, so the mock keeps the same time as the agent.
 */
export function testFetcher(env: Env, clock?: () => number): Fetcher {
  return async (request) => {
    const url = new URL(request.url);
    if (url.host === "agent.test") return worker.fetch(request, env);
    const id = companyIdFromHost(url.host);
    if (id) {
      const stamped = new Request(request);
      if (clock) stamped.headers.set(CLOCK_HEADER, String(clock()));
      return (env as TestEnv).MOCK_COMPANY.getByName(id).fetch(stamped);
    }
    return new Response("No network in tests", { status: 502 });
  };
}

/**
 * Everything written to the console in this isolate, where the test agents
 * and the mock Companies run, so tests can check a secret never reached a log.
 */
const logs: string[] = [];
for (const level of ["debug", "log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logs.push(
      args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ")
    );
    original(...args);
  };
}

/**
 * A test agent's fake clock, and every wait the client asked of it. It
 * stands still: only the client's `sleep` (which returns at once) and a
 * test's `poppyAdvance` move it, so waits and schedules are exact. It starts
 * an hour ahead of the real clock, so a job scheduled on it (a device poll,
 * operation tracking) never runs on its own, only when a test advances.
 */
type FakeClock = { now: number; sleeps: number[] };
const clocks = new WeakMap<object, FakeClock>();

function clockOf(agent: object): FakeClock {
  let clock = clocks.get(agent);
  if (!clock) {
    clock = { now: Date.now() + 3_600_000, sleeps: [] };
    clocks.set(agent, clock);
  }
  return clock;
}

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
}

/**
 * The faux model's script, derived from the transcript alone so it answers
 * the same way after a crash as before: it echoes the latest user message
 * and says how many user turns it has seen, which proves history survived.
 */
function script(context: TranscriptContext): AssistantMessage {
  const users = context.messages.filter((m) => m.role === "user");
  const prompt = textOf(users.at(-1)?.content);
  return fauxAssistantMessage([
    fauxText(`echo: ${prompt} (turn ${users.length})`)
  ]);
}

/** The production agent with pi-ai's faux provider in place of AI Gateway. */
export class PersonalAgent extends ProductionAgent {
  /** Woken whenever the model is told something. */
  #noticeWaiters: (() => void)[] = [];

  protected override poppyFetcher(): Fetcher {
    return testFetcher(this.env, () => clockOf(this).now);
  }

  protected override poppySettings() {
    return {
      readWaitSeconds: 1,
      idleReadMs: 500,
      sleep: async (ms: number) => {
        const clock = clockOf(this);
        clock.sleeps.push(ms);
        clock.now += ms;
      },
      now: () => clockOf(this).now
    };
  }

  /** The fake clock: its time, and every wait the client asked for, in ms. */
  async poppyClock(): Promise<FakeClock> {
    const clock = clockOf(this);
    return { now: clock.now, sleeps: [...clock.sleeps] };
  }

  /**
   * Move the fake clock on by `ms` and run every Poppy job due by then
   * (device polls, operation tracking), as the alarm would once that much
   * time had passed. Conversation reads are scheduled on the real clock and
   * run on their own.
   */
  async poppyAdvance(ms: number): Promise<void> {
    const clock = clockOf(this);
    clock.now += ms;
    const hasJobs = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_jobs'")
      .toArray().length > 0;
    if (!hasJobs) return;
    // The job queue runs on the real clock: make the jobs due by the fake one due now.
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_jobs SET time = ? WHERE capability = 'poppy' AND running = 0 AND time <= ?",
      Date.now(),
      clock.now
    );
    await this.lifecycle.alarm();
  }

  /** Records what the model is told, then tells it, as production does. */
  protected override async poppyNotify(text: string, operationId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test_notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, operation_id TEXT)"
    );
    this.ctx.storage.sql.exec("INSERT INTO test_notices (text, operation_id) VALUES (?, ?)", text, operationId);
    const waiters = this.#noticeWaiters;
    this.#noticeWaiters = [];
    for (const wake of waiters) wake();
    await super.poppyNotify(text, operationId);
  }

  /** The first notice to the model containing `fragment`: now, or as soon as it's sent. */
  async poppyWaitForNotice(fragment: string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await this.poppyNotices()).find((notice) => notice.includes(fragment));
      if (found !== undefined) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`The model was never told anything containing ${JSON.stringify(fragment)}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.#noticeWaiters.push(resolve);
        timer = setTimeout(resolve, remaining);
      });
      clearTimeout(timer);
    }
  }

  /** How many console lines this isolate has written so far; pass it to `poppyLogsSince`. */
  async poppyLogMark(): Promise<number> {
    return logs.length;
  }

  async poppyLogsSince(mark: number): Promise<string[]> {
    return logs.slice(mark);
  }

  /** Every row of every table in the agent's SQLite, as text. */
  async poppyDumpStorage(): Promise<string> {
    const tables = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .toArray()
      .map((row) => String(row.name));
    return JSON.stringify(
      Object.fromEntries(tables.map((table) => [table, this.ctx.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()]))
    );
  }

  /** Open a sealed value with `context` as its additional data, as the client would; null if it fails. */
  async poppyOpenSealed(sealed: string, context: string): Promise<string | null> {
    try {
      return await new Sealer(this.env).open(sealed, context);
    } catch {
      return null;
    }
  }

  /** Run one model-facing Poppy tool as the model would; returns its text. */
  async poppyTool(
    name: string,
    args: Record<string, unknown>,
    callId: string = crypto.randomUUID()
  ): Promise<{ text: string; isError: boolean; /** The result's `details`, as JSON text. */ details: string }> {
    const extension = poppyExtension(() => this.poppy.client, () => this.poppy.browser);
    const tool = extension.tools?.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    const api = { conversationId: "test", callId } as unknown as ToolExecutionApi;
    const result = await tool.execute(args as never, api, {} as never);
    const text = (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
    return { text, isError: result.isError === true, details: JSON.stringify(result.details ?? null) };
  }

  /** A frame from the chat page, as if sent over the WebSocket. */
  async poppyFrame(frame: Record<string, unknown>): Promise<boolean> {
    const socket = { send() {} } as unknown as WebSocket;
    return this.poppy.onWebSocketMessage(socket, JSON.stringify(frame));
  }

  /** One conversation read, now, instead of waiting for the background job. */
  async poppyReadNow(conversationId: string): Promise<void> {
    await readConversation(this.poppy.client, conversationId, 0, 60_000);
  }

  /** SQL against the agent's storage, for assertions and test setup. */
  async poppySql(query: string, ...bindings: unknown[]): Promise<string> {
    return JSON.stringify(this.ctx.storage.sql.exec(query, ...bindings).toArray());
  }

  async poppyNotices(): Promise<string[]> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test_notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, operation_id TEXT)"
    );
    return this.ctx.storage.sql.exec("SELECT text FROM test_notices ORDER BY seq").toArray().map((row) => String(row.text));
  }

  async poppyCards(): Promise<string> {
    return JSON.stringify(
      this.ctx.storage.sql.exec("SELECT card FROM poppy_cards ORDER BY updated_at").toArray().map((row) => JSON.parse(String(row.card)))
    );
  }

  /** Forget in-memory state, as an eviction would (tokens, DPoP keys, nonces). */
  async poppyForgetMemory(): Promise<void> {
    (this.poppy as unknown as { forgetForTests(): void }).forgetForTests();
  }

  protected override modelSource(): ModelSource {
    // Still read the real settings, so a bad var fails here as in production.
    const config = readModelConfig(this.env);
    const faux = fauxProvider({
      tokensPerSecond: 400,
      tokenSize: { min: 2, max: 4 }
    });
    faux.setResponses(Array.from({ length: 200 }, () => script));
    return {
      provider: faux.provider,
      model: faux.getModel(),
      thinkingLevel: config.thinkingLevel
    };
  }
}

export { CompanyLimiter } from "../src/index";
export { MockCompany } from "./mock-company";

export default worker;
