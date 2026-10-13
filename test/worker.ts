import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Provider,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { PersonalAgent as ProductionAgent } from "../src/agent";
import type { ListEnv } from "../src/allowlist";
import { SUMMARY_MESSAGE_PREFIX, SUMMARY_SYSTEM_PROMPT } from "../src/compaction";
import worker from "../src/index";
import { toolName } from "../src/log";
import { demoCatalogModel, gatewayDemoLane, routerProvider, type DemoRoute, type LaneModel } from "../src/model-router";
import { POPPY_TIMEOUTS, type Fetcher, type PoppyTimeouts } from "../src/poppy/fetch";
import { buildActivity } from "../src/poppy/activity";
import { readConversation } from "../src/poppy/conversations";
import { protocolIndex, protocolLog } from "../src/poppy/protocol-log";
import type { ProtocolCompany, ProtocolEntry } from "../src/poppy/wire";
import { Sealer } from "../src/poppy/store";
import { poppyExtension } from "../src/poppy/tools";
import type { BrowserLauncher } from "../src/tools/render";
import type { Fetcher as WebFetcher } from "../src/tools/web";
import { fakeBrowserWeb, fakeLauncher, type FakeBrowserWeb, type FakeRender, type FakeRenderLog } from "./fake-browser";
import { base64url } from "../src/base64url";
import type { PushFetcher } from "../src/web-push";
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
 * A fault a test puts between the test agent and a Company: the next request
 * matching `method`, a URL containing `url`, and (for the token endpoint) a
 * form `grant_type`, goes wrong once, as a network would make it:
 *
 * - `throw`: the Company handles it, then the connection fails before the answer arrives;
 * - `gateway`: the Company handles it, then a gateway answers 504 instead;
 * - `hold`: the Company handles it, then the answer is held until `poppyReleaseHeld`,
 *   and the connection fails; meanwhile the test can act as a later step would;
 * - `lose`: the request fails before it reaches the Company;
 * - `error`: the request doesn't reach the Company, and a 500 with
 *   `{"error":"server_error"}` answers instead, as a failing server would;
 * - `stall`: the Company handles it and its answer starts (status, headers and
 *   the body's first byte), then the body never ends. The fetcher ignores the
 *   request's signal, so only the client's own deadline ends the wait.
 */
export type NetworkFault = {
  readonly method: string;
  readonly url: string;
  readonly grant?: string;
  readonly mode: "throw" | "gateway" | "hold" | "lose" | "stall" | "error" | "null";
};

type Faults = { pending: NetworkFault[]; held: (() => void)[]; stalled: { cancelled: boolean }[] };
const faultsByAgent = new WeakMap<object, Faults>();

function faultsOf(agent: object): Faults {
  let faults = faultsByAgent.get(agent);
  if (!faults) faultsByAgent.set(agent, (faults = { pending: [], held: [], stalled: [] }));
  return faults;
}

/** `fetcher`, with the faults a test asked for. No fault, no change. */
function faultyFetcher(fetcher: Fetcher, faults: () => Faults): Fetcher {
  return async (request) => {
    const { pending, held, stalled } = faults();
    if (pending.length === 0) return fetcher(request);
    let grant: string | null = null;
    if (request.method === "POST" && (request.headers.get("Content-Type") ?? "").includes("form-urlencoded")) {
      grant = new URLSearchParams(new TextDecoder().decode(await request.clone().arrayBuffer())).get("grant_type");
    }
    const index = pending.findIndex(
      (fault) =>
        fault.method === request.method && request.url.includes(fault.url) && (fault.grant === undefined || fault.grant === grant)
    );
    if (index === -1) return fetcher(request);
    const [fault] = pending.splice(index, 1);
    if (fault!.mode === "lose") throw new Error("Network connection lost before the request was sent");
    if (fault!.mode === "error") return Response.json({ error: "server_error" }, { status: 500 });
    if (fault!.mode === "null") return Response.json(null);
    const response = await fetcher(request);
    if (fault!.mode === "stall") {
      const first = new Uint8Array((await response.arrayBuffer()).slice(0, 1));
      const stall = { cancelled: false };
      stalled.push(stall);
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(first),
        cancel: () => {
          stall.cancelled = true;
        }
      });
      return new Response(body, { status: response.status, headers: response.headers });
    }
    await response.body?.cancel();
    if (fault!.mode === "gateway") return new Response("upstream timed out", { status: 504 });
    if (fault!.mode === "hold") await new Promise<void>((resolve) => held.push(resolve));
    throw new Error("Network connection lost before the answer arrived");
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
    // The app's wide events (src/log.ts) are kept for tests to read, not printed: there is one per request, turn and job.
    const wide = args.length === 1 && typeof args[0] === "object" && (args[0] as { service?: unknown } | null)?.service === "personal-agent";
    if (!wide) original(...args);
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

/** Each test agent's waits on a Company: production's, until a test shortens them (`poppySetTimeouts`). */
const timeouts = new WeakMap<object, { -readonly [K in keyof PoppyTimeouts]: number }>();

function timeoutsOf(agent: object) {
  let found = timeouts.get(agent);
  if (!found) timeouts.set(agent, (found = { ...POPPY_TIMEOUTS }));
  return found;
}
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
 * A directive the faux model obeys wherever it reads one: `@@obey <tool>
 * <arguments>`, the arguments as base64url JSON so they survive being quoted
 * in a tool result. It stands for a model that follows instructions a
 * Company slipped into what it reads (test/prompt-injection.test.ts).
 */
export function obey(tool: string, args: Record<string, unknown>): string {
  return `@@obey ${tool} ${btoa(JSON.stringify(args)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** Tool calls for the directives in everything since the model last spoke, each made once per transcript. */
function obeyed(context: TranscriptContext) {
  let lastSpoke = context.messages.length - 1;
  while (lastSpoke >= 0 && context.messages[lastSpoke]!.role !== "assistant") lastSpoke--;
  const fresh = context.messages
    .slice(lastSpoke + 1)
    .map((m) => (m.role === "user" || m.role === "toolResult" ? textOf(m.content as Message["content"]) : ""))
    .join("\n");
  const made = new Set(
    context.messages.flatMap((m) =>
      m.role === "assistant"
        ? m.content.flatMap((part) => (part.type === "toolCall" ? [`${part.name} ${JSON.stringify(part.arguments)}`] : []))
        : []
    )
  );
  const calls = [];
  for (const [, name, encoded] of fresh.matchAll(/@@obey (\w+) ([A-Za-z0-9_-]+)/g)) {
    const args = JSON.parse(atob(encoded!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, never>;
    const key = `${name} ${JSON.stringify(args)}`;
    if (made.has(key)) continue;
    made.add(key);
    calls.push(fauxToolCall(name!, args));
  }
  return calls;
}

/**
 * The faux model's script, derived from the transcript alone so it answers
 * the same way after a crash as before: it echoes the latest user message
 * and says how many user turns it has seen, which proves history survived.
 * First, it obeys any `@@obey` directive it has just read.
 */
function script(context: TranscriptContext): AssistantMessage {
  if (isSummaryRequest(context)) return summaryScript(context);
  const calls = obeyed(context);
  if (calls.length) return fauxAssistantMessage(calls, { stopReason: "toolUse" });
  const users = context.messages.filter((m) => m.role === "user");
  const prompt = textOf(users.at(-1)?.content);
  // `[too long]`: the provider says the request is too long, until a summary has made it shorter (with `[always]`, even then).
  if (prompt.includes("[too long]") && (!carriesSummary(context) || prompt.includes("[always]"))) {
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 250000 tokens > 200000 maximum" });
  }
  // A long prompt (one that fills the context) is echoed in part, so the faux model doesn't stream it all back.
  const echoed = prompt.length > 2000 ? `${prompt.slice(0, 200)}… (${prompt.length} characters)` : prompt;
  return fauxAssistantMessage([
    fauxText(`echo: ${echoed} (turn ${users.length})`)
  ]);
}

/** Our summarizer's request (src/compaction.ts), told by its system prompt. */
function isSummaryRequest(context: TranscriptContext): boolean {
  const first = context.messages[0];
  return first?.role === "system" && textOf(first.content as Message["content"]) === SUMMARY_SYSTEM_PROMPT;
}

/** Whether a request carries a summary of earlier conversation, as pi-durable gives it to the model. */
function carriesSummary(context: TranscriptContext): boolean {
  return context.messages.some((m) => m.role === "user" && textOf(m.content as Message["content"]).startsWith(SUMMARY_MESSAGE_PREFIX));
}

/**
 * The faux summarizer: a short summary naming how many lines it read. It
 * fails if what it summarises says `[summary fails]`, and is priced by a
 * `[summary cost N]` marker there, as `[cost N]` prices an answer.
 */
function summaryScript(context: TranscriptContext): AssistantMessage {
  const source = textOf(context.messages.at(-1)?.content as Message["content"]);
  if (source.includes("[summary fails]")) {
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "The summarizer is down (a test fault)" });
  }
  // One JSON message a line (src/compaction.ts); a line that isn't one fails the summary, so every compaction test checks the format.
  const conversation = /<conversation>\n([\s\S]*)\n<\/conversation>/.exec(source)?.[1] ?? "";
  const lines = conversation.split("\n").filter(Boolean);
  if (!lines.every(isSummaryLine)) {
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "The summary's source isn't one JSON message a line (a test fault)" });
  }
  const cost = /\[summary cost ([\d.]+)\]/.exec(source)?.[1];
  return fauxAssistantMessage([fauxText(`Faux summary of ${lines.length} lines.${cost ? ` [cost ${cost}]` : ""}`)]);
}

function isSummaryLine(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && "role" in value && typeof value.role === "string" && line.startsWith('{"role":"');
  } catch {
    return false;
  }
}

/** A request for a host that is neither ours nor a mock Company's, which tests never answer. */
type StrayRequest = { method: string; url: string; headers: string[]; body: string };
const strays = new WeakMap<object, StrayRequest[]>();

/**
 * `fetcher`, recording each stray request. Keyed by the agent rather than a
 * field of it, because the production constructor asks for the fetcher
 * before a subclass's fields exist.
 */
function recording(agent: object, fetcher: Fetcher): Fetcher {
  return async (request) => {
    const host = new URL(request.url).host;
    if (host !== "agent.test" && !companyIdFromHost(host)) {
      const list = strays.get(agent) ?? [];
      strays.set(agent, list);
      list.push({
        method: request.method,
        url: request.url,
        headers: [...request.headers.keys()],
        body: request.body ? await request.clone().text() : ""
      });
    }
    return fetcher(request);
  };
}

/** Every secret value that crossed the wire, per agent, for tests that check none reaches a log or a frame. */
const wireSecrets = new WeakMap<object, Set<string>>();

/** Form fields and JSON members that carry a secret, in either direction. */
const SECRET_FIELDS = new Set([
  "assertion",
  "client_assertion",
  "code",
  "code_verifier",
  "refresh_token",
  "access_token",
  "device_code",
  "user_code",
  "token",
  "sign_in_id",
  "session_id"
]);

function collectSecrets(found: Set<string>, value: unknown, key = ""): void {
  if (typeof value === "string") {
    if (SECRET_FIELDS.has(key) || key.startsWith("credentials.")) found.add(value);
    return;
  }
  if (Array.isArray(value)) for (const item of value) collectSecrets(found, item, key);
  else if (typeof value === "object" && value !== null) {
    for (const [name, item] of Object.entries(value)) collectSecrets(found, item, key === "credentials" ? `credentials.${name}` : name);
  }
}

/**
 * `fetcher`, noting every secret it carries: tokens in `Authorization`, DPoP
 * proofs, cookies, the secret fields of form and JSON bodies (assertions,
 * codes, verifiers, tokens, sign-in values), and the same fields in JSON
 * answers. Answers are read from a clone, after the fact.
 */
function tapping(agent: object, fetcher: Fetcher): Fetcher {
  return async (request) => {
    let found = wireSecrets.get(agent);
    if (!found) wireSecrets.set(agent, (found = new Set()));
    const seen = found;
    const authorization = request.headers.get("Authorization");
    if (authorization) seen.add(authorization.replace(/^\S+\s+/, ""));
    for (const name of ["DPoP", "Cookie"]) {
      const value = request.headers.get(name);
      if (value) seen.add(value);
    }
    const type = request.headers.get("Content-Type") ?? "";
    if (request.body && type.includes("form-urlencoded")) {
      for (const [name, value] of new URLSearchParams(new TextDecoder().decode(await request.clone().arrayBuffer()))) if (SECRET_FIELDS.has(name)) seen.add(value);
    } else if (request.body && type.includes("json")) {
      try {
        collectSecrets(seen, JSON.parse(await request.clone().text()));
      } catch {
        // Not JSON after all.
      }
    }
    const response = await fetcher(request);
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie) seen.add(setCookie.split(";")[0]!.split("=").slice(1).join("="));
    if ((response.headers.get("Content-Type") ?? "").includes("json")) {
      void response
        .clone()
        .text()
        .then((text) => collectSecrets(seen, JSON.parse(text)))
        .catch(() => undefined);
    }
    return response;
  };
}

/** A fake page on the open web, for read_url: what a host answers, or a stall that never ends. */
export type FakePage = {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Answer with headers, then never finish the body. */
  readonly stall?: boolean;
};

/** One request read_url made: everything it carried. */
export type WebRequest = { readonly method: string; readonly url: string; readonly headers: Record<string, string>; readonly body: string };

/**
 * Each agent's fake web, by Durable Object id: pages by URL, the requests
 * that reached it, and its fake Browser Run (test/fake-browser.ts), with a
 * switch standing for `BROWSER_RUN` off.
 */
const webs = new Map<string, { pages: Map<string, FakePage>; requests: WebRequest[]; browser: FakeBrowserWeb; renderOff: boolean }>();

function webOf(id: string) {
  let web = webs.get(id);
  if (!web) webs.set(id, (web = { pages: new Map(), requests: [], browser: fakeBrowserWeb(), renderOff: false }));
  return web;
}

/** The production agent with pi-ai's faux provider in place of AI Gateway. */
export class PersonalAgent extends ProductionAgent {
  /** Woken whenever the model is told something. */
  #noticeWaiters: (() => void)[] = [];

  /** read_url's fetcher: the agent's fake web. A URL nobody served answers 502, as in every other fake. */
  protected override webFetcher(): WebFetcher {
    const web = webOf(this.ctx.id.toString());
    return async (request) => {
      web.requests.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: request.body ? await request.clone().text() : ""
      });
      const page = web.pages.get(request.url);
      if (!page) return new Response("No network in tests", { status: 502 });
      const headers = new Headers(page.headers ?? { "Content-Type": "text/html; charset=utf-8" });
      if (page.stall) {
        const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode("<p>")) });
        return new Response(body, { status: page.status ?? 200, headers });
      }
      // Bytes, so the runtime adds no Content-Type of its own.
      return new Response(new TextEncoder().encode(page.body ?? ""), { status: page.status ?? 200, headers });
    };
  }

  /** Serve `page` at `url` on this agent's fake web. */
  async webServe(url: string, page: FakePage): Promise<void> {
    webOf(this.ctx.id.toString()).pages.set(url, page);
  }

  /** Every request read_url sent, oldest first. */
  async webRequests(): Promise<WebRequest[]> {
    return webOf(this.ctx.id.toString()).requests;
  }

  /** read_url's renderer: the fake browser, never Browser Run; null while a test has switched rendering off. */
  protected override browserRenderer(): BrowserLauncher | null {
    const web = webOf(this.ctx.id.toString());
    return web.renderOff ? null : fakeLauncher(web.browser);
  }

  /** What the fake browser does when it loads `url`. */
  async webRender(url: string, render: FakeRender): Promise<void> {
    webOf(this.ctx.id.toString()).browser.pages.set(url, render);
  }

  /** Every render, oldest first: each request's decision, the setup, and whether the browser was closed. */
  async webRenders(): Promise<{ launches: number; logs: FakeRenderLog[] }> {
    const { browser } = webOf(this.ctx.id.toString());
    return { launches: browser.launches, logs: browser.logs };
  }

  /** As `BROWSER_RUN` on or off, or the binding missing, for this agent. */
  async webRendering(on: boolean): Promise<void> {
    webOf(this.ctx.id.toString()).renderOff = !on;
  }

  /** Every URL the Poppy client asked for, to any host. */
  async poppyRequestUrls(): Promise<string[]> {
    return [...(poppyUrls.get(this) ?? [])];
  }

  /** What each general tool call has kept with itself (`api.memo`), by call id, as pi keeps it per tool task. */
  #memos = new Map<string, Map<string, unknown>>();

  /**
   * Run one general tool (read_url, remember, recall, forget, now, date_math,
   * calculate) as the model would; `callId` names the tool call, so running
   * it again with the same id is a replay.
   */
  async generalTool(
    name: string,
    args: Record<string, unknown>,
    callId: string = crypto.randomUUID()
  ): Promise<{ text: string; isError: boolean; details: string }> {
    const tool = this.generalTools.flatMap((extension) => extension.tools ?? []).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    let memos = this.#memos.get(callId);
    if (!memos) this.#memos.set(callId, (memos = new Map()));
    const kept = memos;
    const api = {
      conversationId: "test",
      callId,
      memo: async (key: string, ...rest: unknown[]) => {
        if (rest.length === 1) return kept.get(key);
        if (!kept.has(key)) kept.set(key, rest[0]);
        return kept.get(key);
      }
    } as unknown as ToolExecutionApi;
    // As pi runs it: counted on a turn's wide event (src/agent-log.ts), here a turn of its own.
    const result = await this.log.tool(toolName(name)!, () => tool.execute(args as never, api, {} as never));
    const text = (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
    return { text, isError: result.isError === true, details: JSON.stringify(result.details ?? null) };
  }

  /** The clock now and date_math read; a test may fix it. */
  protected override clockNow(): number {
    return fixedClocks.get(this.ctx.id.toString()) ?? Date.now();
  }

  async setClock(at: number): Promise<void> {
    fixedClocks.set(this.ctx.id.toString(), at);
  }

  protected override poppyFetcher(): Fetcher {
    const inner = faultyFetcher(recording(this, tapping(this, testFetcher(this.env, () => clockOf(this).now))), () => faultsOf(this));
    return async (request) => {
      let list = poppyUrls.get(this);
      if (!list) poppyUrls.set(this, (list = []));
      list.push(request.url);
      return inner(request);
    };
  }

  /** Every secret this agent's Poppy requests and their answers carried (see `tapping`). */
  async poppyWireSecrets(): Promise<string[]> {
    return [...(wireSecrets.get(this) ?? [])].filter((value) => value.length > 0);
  }

  /** The protocol view's index, as the agent would send it now. */
  async poppyProtocolIndex(): Promise<ProtocolCompany[]> {
    void this.poppy.client;
    return protocolIndex(this.ctx.storage.sql, (issuer) => ({ name: issuer, domain: null })).companies as ProtocolCompany[];
  }

  /** One Company's protocol log, oldest first, as the page would get it. */
  async poppyProtocol(key: string): Promise<ProtocolEntry[]> {
    void this.poppy.client;
    return protocolLog(this.ctx.storage.sql, key, (issuer) => ({ name: issuer, domain: null })).entries as ProtocolEntry[];
  }

  /** Every request this agent sent to a host that is neither ours nor a mock Company's. */
  async poppyStrayRequests(): Promise<StrayRequest[]> {
    return strays.get(this) ?? [];
  }

  /** Every message in the model's transcript, as text: what the model has read and said. */
  async poppyTranscript(): Promise<string> {
    const tables = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%'")
      .toArray()
      .map((row) => String(row.name));
    return JSON.stringify(tables.map((table) => this.ctx.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()));
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
      now: () => clockOf(this).now,
      timeouts: timeoutsOf(this)
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

  /** `poppyFailNoticeOnce`: notices still to fail, by a fragment of their text. */
  #failingNotices: string[] = [];

  /** Records what the model is told, then tells it, as production does. */
  protected override async poppyNotify(text: string, operationId: string): Promise<void> {
    const failing = this.#failingNotices.findIndex((fragment) => text.includes(fragment));
    if (failing !== -1) {
      this.#failingNotices.splice(failing, 1);
      throw new Error("The model couldn't be told (a test fault)");
    }
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

  /** The text "Copy diagnostics" gives the User (src/agent-log.ts). */
  async diagnostics(): Promise<string> {
    return this.log.diagnostics();
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
    // As pi runs it: counted on a turn's wide event (src/agent-log.ts), here a turn of its own.
    const result = await this.log.tool(toolName(name)!, () => tool.execute(args as never, api, {} as never));
    const text = (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
    return { text, isError: result.isError === true, details: JSON.stringify(result.details ?? null) };
  }

  /** A frame from the chat page, as if sent over the WebSocket. */
  async poppyFrame(frame: Record<string, unknown>): Promise<boolean> {
    const socket = { send() {} } as unknown as WebSocket;
    return this.poppy.onWebSocketMessage(socket, JSON.stringify(frame));
  }

  /** One conversation read, now, instead of waiting for the background job; returns when it would read next (null: never). */
  async poppyReadNow(conversationId: string): Promise<number | null> {
    return readConversation(this.poppy.client, conversationId, 0, 60_000);
  }

  /** The page's Activity frame, as the agent would send it now. */
  async poppyActivity(): Promise<string> {
    return JSON.stringify(buildActivity(this.poppy.client));
  }

  /** SQL against the agent's storage, for assertions and test setup. */
  async poppySql(query: string, ...bindings: unknown[]): Promise<string> {
    return JSON.stringify(this.ctx.storage.sql.exec(query, ...bindings).toArray());
  }

  /** What the model was told, in order: once per operation id, as the harness delivers it. */
  async poppyNotices(): Promise<string[]> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test_notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, operation_id TEXT)"
    );
    return this.ctx.storage.sql
      .exec("SELECT text FROM test_notices WHERE seq IN (SELECT MIN(seq) FROM test_notices GROUP BY operation_id) ORDER BY seq")
      .toArray()
      .map((row) => String(row.text));
  }

  /** The next request matching `fault` goes wrong once (see `NetworkFault`). */
  async poppyFault(fault: NetworkFault): Promise<void> {
    faultsOf(this).pending.push(fault);
  }

  /** Let every held answer go (as a failed connection); returns how many there were. */
  async poppyReleaseHeld(): Promise<number> {
    const held = faultsOf(this).held.splice(0);
    for (const release of held) release();
    return held.length;
  }

  /** The next notice to the model containing `fragment` fails, as if the harness had thrown. */
  async poppyFailNoticeOnce(fragment: string): Promise<void> {
    this.#failingNotices.push(fragment);
  }

  /** Stalled bodies (the `stall` fault) so far, and how many of them the client cancelled. */
  async poppyStalled(): Promise<{ stalled: number; cancelled: number }> {
    const { stalled } = faultsOf(this);
    return { stalled: stalled.length, cancelled: stalled.filter((stall) => stall.cancelled).length };
  }

  /** Shorten (or restore) how long the client waits on a Company. */
  async poppySetTimeouts(timeouts: Partial<PoppyTimeouts>): Promise<void> {
    Object.assign(timeoutsOf(this), timeouts);
  }

  /** Faults not yet triggered: network faults and failing notices. Zero once each has fired. */
  async poppyFaultsLeft(): Promise<number> {
    return faultsOf(this).pending.length + this.#failingNotices.length;
  }

  async poppyCards(): Promise<string> {
    void this.poppy.client;
    return JSON.stringify(
      this.ctx.storage.sql.exec("SELECT card FROM poppy_cards ORDER BY updated_at").toArray().map((row) => JSON.parse(String(row.card)))
    );
  }

  /** Forget in-memory state, as an eviction would (tokens, DPoP keys, nonces). */
  async poppyForgetMemory(): Promise<void> {
    (this.poppy as unknown as { forgetForTests(): void }).forgetForTests();
  }

  #faux: ReturnType<typeof fauxProvider> | undefined;

  /**
   * The demo lane with pi-ai's faux provider in place of AI Gateway, counted,
   * and priced by a `[cost 0.25]` marker in the prompt (the faux provider's
   * own cost is always 0). Own-key lanes keep pi-ai's real providers, which
   * the outbound service sends to the fake vendors.
   */
  protected override demoLane(route: DemoRoute): LaneModel {
    const id = this.ctx.id.toString();
    const counted = (stream: AssistantMessageEventStream, price: (message: AssistantMessage) => AssistantMessage): AssistantMessageEventStream => {
      demoCalls.set(id, (demoCalls.get(id) ?? 0) + 1);
      const out = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of stream) out.push(event.type === "done" ? { ...event, message: price(event.message) } : event);
        out.end(price(await stream.result()));
      })();
      return out;
    };
    const countedProvider = (inner: Provider, price: (message: AssistantMessage) => AssistantMessage): Provider => ({
      id: inner.id,
      name: inner.name,
      auth: inner.auth,
      getModels: () => inner.getModels(),
      stream: (model, context, options) => {
        recordRequest(id, context);
        return counted(inner.stream(model, context, options), price);
      },
      streamSimple: (model, context, options) => {
        recordRequest(id, context);
        return counted(inner.streamSimple(model, context, options), price);
      }
    });
    const usage = gatewayUsage.get(id);
    if (usage) {
      // Production's lane, priced by pi-ai from the usage the fake gateway reports.
      const lane = gatewayDemoLane({ ...this.env, AI: fakeGateway(usage) }, route);
      return { provider: countedProvider(lane.provider, (message) => message), model: lane.model };
    }
    if (!this.#faux) {
      this.#faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 2, max: 4 } });
      this.#faux.setResponses(Array.from({ length: 200 }, () => script));
    }
    return { provider: countedProvider(this.#faux.provider, priced), model: this.#faux.getModel() };
  }

  /** From now on, this agent's demo lane is production's, through a fake AI Gateway that reports `usage` for every call. */
  async useGatewayDemo(usage: GatewayUsage): Promise<void> {
    gatewayUsage.set(this.ctx.id.toString(), usage);
  }

  /** The demo lane's clock: a fixed day (noon UTC), moved only by `demoAdvance`. */
  protected override modelNow(): number {
    return DEMO_NOON + (demoOffsets.get(this.ctx.id.toString()) ?? 0);
  }

  /** Move this agent's demo clock on by `ms`. */
  async demoAdvance(ms: number): Promise<void> {
    const id = this.ctx.id.toString();
    demoOffsets.set(id, (demoOffsets.get(id) ?? 0) + ms);
  }

  /** How many calls this agent has made on the demo lane. */
  async demoCallCount(): Promise<number> {
    return demoCalls.get(this.ctx.id.toString()) ?? 0;
  }

  /** Every demo-lane request this agent made, oldest first: what it was and what it carried. */
  async demoRequests(): Promise<DemoRequest[]> {
    return demoRequests.get(this.ctx.id.toString()) ?? [];
  }

  /** The context window pi judges this agent's requests against: the router model's, as pi reads it. */
  async routerWindow(): Promise<number> {
    return routerProvider(this.access, demoCatalogModel(this.env)).getModels()[0]!.contextWindow;
  }

  /** The model's active context, as pi's entries: kind, id, the summary's `head`, and each message's role and text, clipped. */
  async activeEntries(): Promise<Array<{ id: number; kind: string; head: number | null; role: string | null; text: string }>> {
    const entries = await this.harness.messages();
    return entries.map((entry) => {
      const message = entry.model?.[0];
      const content = message && "content" in message ? (message.content as Message["content"]) : undefined;
      return { id: Number(entry.id), kind: entry.kind, head: entry.head === undefined ? null : Number(entry.head), role: message?.role ?? null, text: textOf(content).slice(0, 200) };
    });
  }

  /** The newest assistant message in the transcript: its text and pi's recorded error, if any. */
  async lastAssistant(): Promise<{ text: string; error: string | null }> {
    const entries = (await this.harness.messages()) as Array<{ model?: Array<{ role?: string; content?: Message["content"]; errorMessage?: string }> }>;
    const message = entries.map((entry) => entry.model?.[0]).filter((item) => item?.role === "assistant").at(-1);
    return { text: textOf(message?.content as Message["content"] | undefined), error: message?.errorMessage ?? null };
  }

  /** Reminders' and tasks' jobs: a year out on the real clock, so none runs by itself; `scheduleAdvance` makes them due. */
  protected override scheduleJobTime(_at: number): number {
    return Date.now() + 365 * 86_400_000;
  }

  /**
   * Set the clock (`setClock`) to `at` and make every reminder and task job
   * due on the real clock; the test then runs the alarm
   * (`runDurableObjectAlarm`), and each job checks its row's own time.
   */
  async scheduleAdvance(at: number): Promise<void> {
    fixedClocks.set(this.ctx.id.toString(), at);
    this.ctx.storage.sql.exec("UPDATE cf_agents_jobs SET time = ? WHERE capability = 'schedules' AND running = 0", Date.now());
  }

  /**
   * Set the clock (`setClock`) to `at` and make the job that deletes photos
   * past their 30 days due on the real clock; the test then runs the alarm
   * (`runDurableObjectAlarm`).
   */
  async attachmentsAdvance(at: number): Promise<void> {
    fixedClocks.set(this.ctx.id.toString(), at);
    this.ctx.storage.sql.exec("UPDATE cf_agents_jobs SET time = ? WHERE capability = 'attachments' AND running = 0", Date.now());
  }

  /** What the agent stores of its photos: rows, chunks of each part, and the attachments job's due time on the real clock. */
  async attachmentStorage(): Promise<{ attachments: number; file: number; preview: number; job: number | null }> {
    const sql = this.ctx.storage.sql;
    const count = (query: string) => Number(sql.exec(query).one().n);
    const job = sql.exec("SELECT time FROM cf_agents_jobs WHERE capability = 'attachments'").toArray()[0];
    return {
      attachments: count("SELECT COUNT(*) AS n FROM attachments"),
      file: count("SELECT COUNT(*) AS n FROM attachment_chunks WHERE part = 'file'"),
      preview: count("SELECT COUNT(*) AS n FROM attachment_chunks WHERE part = 'preview'"),
      job: job ? Number(job.time) : null
    };
  }

  /** A reminder or task made straight in the store, without the tools' check of whose turn it is (test setup). */
  async scheduleCreate(input: { kind: "reminder" | "task"; text: string; when: Record<string, unknown>; timeZone: string }): Promise<{ id: string; nextRun: number | null; error?: string }> {
    try {
      const { schedule } = await this.schedules.create({ ...input, createdFrom: `test:${crypto.randomUUID()}` });
      return { id: schedule.id, nextRun: schedule.nextRun };
    } catch (error) {
      // A refusal comes back as its words rather than a rejected call.
      return { id: "", nextRun: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Web Push: this agent's fake push services, never the network. Every endpoint answers 201 unless `pushServe` said otherwise. */
  protected override pushFetcher(): PushFetcher {
    const pushes = pushesOf(this.ctx.id.toString());
    return async (request) => {
      const bytes = new Uint8Array(await request.arrayBuffer());
      pushes.requests.push({ url: request.url, headers: Object.fromEntries(request.headers), body: base64url(bytes) });
      return new Response(null, { status: pushes.statuses.get(request.url) ?? 201 });
    };
  }

  /** The fake push service answers `status` for `endpoint` from now on. */
  async pushServe(endpoint: string, status: number): Promise<void> {
    pushesOf(this.ctx.id.toString()).statuses.set(endpoint, status);
  }

  /** Every push this agent sent, oldest first: the URL, headers and encrypted body (base64url). */
  async pushRequests(): Promise<PushRequest[]> {
    return pushesOf(this.ctx.id.toString()).requests;
  }

  /** Wait until every scheduled task's turn this agent is waiting on has been recorded. */
  async scheduleSettled(): Promise<void> {
    await this.schedules.settledForTests();
  }

  /** A background turn, as a Company message would start one. */
  async backgroundTurn(text: string, operationId: string): Promise<void> {
    await this.poppyNotify(text, operationId);
  }

  /** The deployment's lists, with this agent's overrides (`deploymentOverride`) on top. */
  protected override deployment(): ListEnv {
    return { ...super.deployment(), ...deploymentOverrides.get(this.ctx.id.toString()) };
  }

  /** As a redeploy with these vars would be for this agent (say, someone taken off `SIGNIN_ALLOWLIST`); `{}` puts the test config back. */
  async deploymentOverride(overrides: Partial<Record<"OWNERS" | "SIGNUP" | "SIGNIN_ALLOWLIST" | "DEMO_ALLOWLIST", unknown>>): Promise<void> {
    deploymentOverrides.set(this.ctx.id.toString(), overrides);
  }
}

/** Each agent's overrides of the deployment's lists, by Durable Object id. */
const deploymentOverrides = new Map<string, Partial<ListEnv>>();

/** One Web Push request a test agent sent to its fake push service. */
export type PushRequest = { readonly url: string; readonly headers: Record<string, string>; readonly body: string };

/** Each agent's fake push services, by Durable Object id: statuses by endpoint, and the requests that reached them. */
const pushServices = new Map<string, { statuses: Map<string, number>; requests: PushRequest[] }>();

function pushesOf(id: string) {
  let found = pushServices.get(id);
  if (!found) pushServices.set(id, (found = { statuses: new Map(), requests: [] }));
  return found;
}

/** Every URL each agent's Poppy client asked for. */
const poppyUrls = new WeakMap<object, string[]>();

/** The clock now and date_math read, per agent, where a test fixed it. */
const fixedClocks = new Map<string, number>();

/** Demo-lane calls per agent, by Durable Object id. */
const demoCalls = new Map<string, number>();

/** One demo-lane request: a summary or a turn, whether it carried a summary, and its latest user text (a turn's clipped, a summary's whole). */
export type DemoRequest = {
  readonly summary: boolean;
  readonly carriesSummary: boolean;
  readonly last: string;
  readonly messages: number;
  /** The images the request showed the model, in order: each one's type, size in bytes, and the start of the user text it came with. */
  readonly images: readonly { readonly mimeType: string; readonly bytes: number; readonly with: string }[];
  /** The tools the request offered the model, by name, in order. */
  readonly tools: readonly string[];
  /** The prompt's sections as the request leaves them, by key. */
  readonly sections: Readonly<Record<string, string>>;
};
const demoRequests = new Map<string, DemoRequest[]>();

function recordRequest(id: string, context: TranscriptContext): void {
  const list = demoRequests.get(id) ?? [];
  demoRequests.set(id, list);
  const users = context.messages.filter((m) => m.role === "user");
  const summary = isSummaryRequest(context);
  const last = textOf(users.at(-1)?.content as Message["content"]);
  const tools: string[] = [];
  const sections: Record<string, string> = {};
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const added of message.toolsAdded ?? []) if (!tools.includes(added.name)) tools.push(added.name);
    for (const removed of message.toolsRemoved ?? []) {
      const at = tools.indexOf(removed.name);
      if (at !== -1) tools.splice(at, 1);
    }
    for (const [key, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete sections[key];
      else sections[key] = value;
    }
  }
  list.push({
    summary,
    carriesSummary: carriesSummary(context),
    last: summary ? last : last.slice(0, 200),
    messages: context.messages.length,
    tools,
    sections,
    images: users.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.flatMap((part) =>
            part.type === "image" ? [{ mimeType: part.mimeType, bytes: atob(part.data).length, with: textOf(message.content).slice(0, 80) }] : []
          )
    )
  });
}

/** The demo lane's day in tests: noon UTC, so a test never straddles midnight. */
const DEMO_NOON = Date.UTC(2026, 9, 11, 12);
/** How far each agent's demo clock has been moved on, by Durable Object id. */
const demoOffsets = new Map<string, number>();

/** Tokens the fake AI Gateway reports for each call, as Anthropic's Messages stream does. */
export type GatewayUsage = { readonly input_tokens: number; readonly output_tokens: number };
/** Agents on production's demo lane through the fake gateway, by Durable Object id. */
const gatewayUsage = new Map<string, GatewayUsage>();

/**
 * An AI binding whose gateway answers every Anthropic Messages request with
 * a short streamed reply and `usage`, as AI Gateway relays Anthropic's.
 */
function fakeGateway(usage: GatewayUsage): Ai {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg_gw", type: "message", role: "assistant", content: [], model: "claude-sonnet-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "metered answer" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }],
    ["message_stop", { type: "message_stop" }]
  ];
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return {
    gateway: () => ({
      run: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } })
    })
  } as unknown as Ai;
}

/** A faux answer priced by the `[cost N]` marker its echo carries. */
function priced(message: AssistantMessage): AssistantMessage {
  const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const cost = Number(/\[cost ([\d.]+)\]/.exec(text)?.[1] ?? 0);
  // `[context N]`: the answer reports a context of N tokens, as a provider's usage would, so pi measures the conversation at N.
  const context = Number(/\[context (\d+)\]/.exec(text)?.[1] ?? 0);
  let usage = message.usage;
  if (context) usage = { ...usage, input: context, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: context };
  if (cost) usage = { ...usage, cost: { ...usage.cost, total: cost } };
  return usage === message.usage ? message : { ...message, usage };
}

export { CompanyLimiter, DomainBudget } from "../src/index";
export { MockCompany } from "./mock-company";

export default worker;
