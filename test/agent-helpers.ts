/**
 * Helpers for tests that drive the Worker as a browser would: identities,
 * session cookies, the chat WebSocket, and a view folded from its frames;
 * and for Poppy tests: mock Companies, agents and the violation check.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect } from "vitest";
import type { Provider } from "../src/config";
import type { PiServerMessage } from "../src/protocol";
import { agentNameFor, createSession, type Identity } from "../src/session";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../src/view";
import { hostsFor, type MockCompany, type MockConfig, type MockRequest } from "./mock-company";
import worker, { type PersonalAgent } from "./worker";

export const ORIGIN = "https://agent.example.com";

let budgetScope = crypto.randomUUID();
beforeEach(() => { budgetScope = crypto.randomUUID(); });

async function prepareAgentBudget(identity: Identity): Promise<void> {
  const name = await agentNameFor(identity);
  createdAgents.add(name);
  const stub = env.PersonalAgent.getByName(name) as unknown as DurableObjectStub<PersonalAgent>;
  await stub.testBudgetScope(budgetScope);
}

/** A Google Workspace account at an allowlisted domain, or an allowlisted GitHub id. */
export function person(sub = `user-${crypto.randomUUID()}`, provider: Provider = "google"): Identity {
  return provider === "google"
    ? { provider, sub, email: `${sub}@workspace.example`, domain: "workspace.example" }
    : { provider, sub, email: `${sub}@example.com`, domain: null };
}

/** `name=value` from a `Set-Cookie` header, ready for a `Cookie` header. */
export function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

export async function sessionCookie(identity: Identity, now?: number): Promise<string> {
  await prepareAgentBudget(identity);
  return cookiePair(await createSession(identity, env.SESSION_SECRET, now));
}

export function wsRequest(
  init: { cookie?: string; origin?: string; upgrade?: boolean; query?: string } = {}
): Request {
  const headers = new Headers();
  if (init.upgrade !== false) headers.set("Upgrade", "websocket");
  headers.set("Origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("Cookie", init.cookie);
  return new Request(`${ORIGIN}/ws${init.query ?? ""}`, { headers });
}

/** A current browser bootstraps its immutable workspace before opening the socket. */
export async function authenticatedWsRequest(init: { cookie: string; query?: string }): Promise<Request> {
  const response = await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: init.cookie } }));
  expect(response.status).toBe(200);
  const { workspaceId } = await response.json() as { workspaceId: string };
  expect(typeof workspaceId).toBe("string");
  const query = new URLSearchParams(init.query);
  // Explicit empty/mismatching workspace is preserved so callers can test refusal.
  if (!query.has("workspace")) query.set("workspace", workspaceId);
  return wsRequest({ cookie: init.cookie, query: `?${query}` });
}

export async function fetchWorker(request: Request, overrides: Partial<Env> = {}) {
  return worker.fetch(request, { ...env, ...overrides });
}

/** Folds every `events` frame into a view, as the browser hook does. */
export function follow(socket: WebSocket) {
  let view: PiSessionView = EMPTY_VIEW;
  const frames: Array<PiServerMessage | { type: string; name?: string }> = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as PiServerMessage | { type: string };
    frames.push(message);
    if (message.type === "events") {
      view = reduceEvents(
        view,
        (message as Extract<PiServerMessage, { type: "events" }>).events
      );
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    if (!check()) throw new Error("Condition never held");
  };
  const texts = () =>
    view.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "text" ? [`${message.role}: ${part.text}`] : []
      )
    );
  return { view: () => view, frames, until, texts };
}

export async function connect(identity: Identity | string, query = "") {
  if (typeof identity !== "string") createdAgents.add(await agentNameFor(identity));
  const cookie = typeof identity === "string" ? identity : await sessionCookie(identity);
  const response = await fetchWorker(await authenticatedWsRequest({ cookie, query }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const client = follow(socket);
  await client.until(() => client.frames.some((f) => f.type === "events"));
  return { socket, client };
}

export async function chat(
  socket: WebSocket,
  client: ReturnType<typeof follow>,
  text: string,
  expected?: string
) {
  socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: text }));
  // Without an expected answer, any turn number will do: the agent may have history.
  await client.until(() =>
    expected === undefined
      ? client.texts().some((t) => t.startsWith(`assistant: echo: ${text} (turn `))
      : client.texts().includes(`assistant: ${expected}`)
  );
  await client.until(() => !client.view().running);
}

// ---------------------------------------------------------------- Poppy

/*
 * Poppy tests: mock Companies, agents driven through their Durable Object
 * stubs, and the violation check. After every test, every mock Company it
 * created with `company()` must have recorded no violations and no warnings
 * (our own client is held to SHOULDs, the Guides and our readings too: the
 * strict run of docs/conformance-levels.md), unless the test said which it
 * expects (`expectViolations`, which matches either). Every file that
 * imports this module gets the check.
 */

export const testEnv = env as Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> };

export type Company = {
  readonly id: string;
  readonly stub: DurableObjectStub<MockCompany>;
  readonly domain: string;
  readonly hosts: ReturnType<typeof hostsFor>;
  /** This test breaks the protocol on purpose: exactly these violations, and no others. */
  expectViolations(...patterns: RegExp[]): void;
};

/** Every mock Company the current test created, with the violations it expects. */
const created: { company: Company; expected: RegExp[]; instanceId: string }[] = [];
const createdAgents = new Set<string>();

/** Flush cancellation before terminating this test's object. The concurrency
 * gate prevents in-flight callbacks from rearming between cancellation and abort.
 * Other tests' agents and the mock Company's evidence are untouched.
 */
export async function stopAgent(stub: DurableObjectStub<import("../src/agent").PersonalAgent>): Promise<void> {
  await expect(runInDurableObject(stub, (_instance, state) => state.blockConcurrencyWhile(async () => {
    if (state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'cf_agents_jobs'").toArray().length) {
      state.storage.sql.exec("DELETE FROM cf_agents_jobs");
    }
    await state.storage.deleteAlarm();
    await state.storage.sync();
    state.abort("Instance dispose");
  }))).rejects.toThrow("Instance dispose");
}

/** Check the witness before trusting even an empty violation/request history. */
export async function companyEvidence(stub: DurableObjectStub<MockCompany>, instanceId: string) {
  const evidence = await stub.evidence();
  if (evidence.instanceId !== instanceId) throw new Error("Mock Company was replaced: protocol evidence was lost");
  return evidence.state;
}

/** Violations no pattern expects, and patterns no violation matched. */
export function compareViolations(violations: readonly string[], expected: readonly RegExp[]) {
  return {
    unexpected: violations.filter((violation) => !expected.some((pattern) => pattern.test(violation))),
    missing: expected.filter((pattern) => !violations.some((violation) => pattern.test(violation))).map(String)
  };
}

afterEach(async () => {
  const mocks = created.splice(0);
  const agents = [...createdAgents];
  createdAgents.clear();
  try {
    for (const { company: c, expected, instanceId } of mocks) {
      const violations = (await companyEvidence(c.stub, instanceId)).recorded;
      expect(compareViolations(violations, expected), `violations and warnings at mock Company ${c.id}`).toEqual({ unexpected: [], missing: [] });
    }
  } finally {
    await Promise.all(agents.map((name) => stopAgent(testEnv.PersonalAgent.getByName(name))));
  }
});

/** A new mock Company, checked for violations after the test. */
export async function company(config: Partial<MockConfig> = {}): Promise<Company> {
  const id = `c${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const stub = testEnv.MOCK_COMPANY.getByName(id);
  await stub.configure({ deviceInterval: 1, ...config });
  const entry = { company: undefined as unknown as Company, expected: [] as RegExp[], instanceId: await stub.instanceId() };
  entry.company = {
    id,
    stub,
    domain: `${id}.shop.test`,
    hosts: hostsFor(id, { issuerTrailingSlash: config.issuerTrailingSlash ?? false, issuerPath: config.issuerPath ?? null }),
    expectViolations: (...patterns) => entry.expected.push(...patterns)
  };
  created.push(entry);
  return entry.company;
}

/** A person's agent, driven through its Durable Object stub, with a session cookie for the Worker. */
export async function agent(identity: Identity = person()) {
  const name = await agentNameFor(identity);
  createdAgents.add(name);
  const stub = testEnv.PersonalAgent.getByName(name) as unknown as DurableObjectStub<PersonalAgent>;
  await stub.testBudgetScope(budgetScope);
  // Who the agent belongs to, as the Worker records on every request: on the demo, so notices reach the model.
  await stub.recordIdentity(identity);
  return { stub, identity, cookie: await sessionCookie(identity) };
}

export type Agent = Awaited<ReturnType<typeof agent>>;

/** Poll for a card (or anything else a test reads back); notices have `poppyWaitForNotice`. */
export async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function tool(a: Pick<Agent, "stub">, name: string, args: Record<string, unknown>, callId?: string) {
  return a.stub.poppyTool(name, args, callId);
}

/**
 * The wide events (src/log.ts) written in this isolate since `mark`
 * (`poppyLogMark`), parsed, oldest first. Every console line the app
 * writes is one; anything else (a library's own line) is left out.
 */
export async function wideEvents(a: Pick<Agent, "stub">, mark: number): Promise<Array<Record<string, any>>> {
  return (await a.stub.poppyLogsSince(mark)).flatMap((line) => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      return typeof event?.kind === "string" && event.service === "personal-agent" ? [event] : [];
    } catch {
      return [];
    }
  });
}

export async function cards(a: Pick<Agent, "stub">): Promise<Array<Record<string, any>>> {
  return JSON.parse(await a.stub.poppyCards());
}

export async function requests(c: Company): Promise<MockRequest[]> {
  return (await c.stub.state()).requests;
}

/** Direct Sign-In end to end: the test plays the User on the Company's page. */
export async function signInDirect(
  a: Pick<Agent, "stub" | "cookie">,
  c: Company,
  scopes = ["orders:read", "orders:write"],
  decision: { approve?: boolean; scopes?: string[]; account?: string } = {},
  /** More `poppy_sign_in` arguments: `session`, `account`. */
  args: Record<string, unknown> = {}
) {
  const started = await tool(a, "poppy_sign_in", { domain: c.domain, scopes, reason: "To look at your orders", ...args });
  expect(started.isError).toBe(false);
  if (started.text.includes("signed in with access")) return null;
  const card = (await cards(a)).find((item) => item.kind === "signin_link" && item.open);
  expect(card).toBeDefined();
  const location = await c.stub.approveAuthorization(card!.url, { approve: decision.approve ?? true, account: decision.account ?? "acct_ada", ...(decision.scopes ? { scopes: decision.scopes } : {}) });
  const callback = await worker.fetch(new Request(location, { headers: { Cookie: a.cookie } }), env);
  return { callback, location, text: await callback.text() };
}
