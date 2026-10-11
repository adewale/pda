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
import type { PoppyBrowser } from "../src/poppy/browser";
import type { Fetcher } from "../src/poppy/fetch";
import { readConversation } from "../src/poppy/conversations";
import { poppyExtension } from "../src/poppy/tools";
import { FakeBrowser } from "./fake-browser";
import { companyIdFromHost, type MockCompany } from "./mock-company";

type TestEnv = Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> };

/**
 * Where the test agent's Poppy requests go: our own origin to our Worker
 * (so Companies can fetch our client metadata and keys), Company hosts to
 * the mock Company, anything else nowhere.
 */
export function testFetcher(env: Env): Fetcher {
  return async (request) => {
    const url = new URL(request.url);
    if (url.host === "agent.test") return worker.fetch(request, env);
    const id = companyIdFromHost(url.host);
    if (id) return (env as TestEnv).MOCK_COMPANY.getByName(id).fetch(request);
    return new Response("No network in tests", { status: 502 });
  };
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
  protected override poppyFetcher(): Fetcher {
    return testFetcher(this.env);
  }

  protected override poppyBrowser(): PoppyBrowser {
    return new FakeBrowser(testFetcher(this.env));
  }

  protected override poppySettings() {
    return { readWaitSeconds: 1, idleReadMs: 500 };
  }

  /** Records what the model is told, then tells it, as production does. */
  protected override async poppyNotify(text: string, operationId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test_notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, operation_id TEXT)"
    );
    this.ctx.storage.sql.exec("INSERT INTO test_notices (text, operation_id) VALUES (?, ?)", text, operationId);
    await super.poppyNotify(text, operationId);
  }

  /** Run one model-facing Poppy tool as the model would; returns its text. */
  async poppyTool(name: string, args: Record<string, unknown>, callId: string = crypto.randomUUID()): Promise<{ text: string; isError: boolean }> {
    const extension = poppyExtension(() => this.poppy.client, () => this.poppy.browser);
    const tool = extension.tools?.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    const api = { conversationId: "test", callId } as unknown as ToolExecutionApi;
    const result = await tool.execute(args as never, api, {} as never);
    const text = (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
    return { text, isError: result.isError === true };
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
