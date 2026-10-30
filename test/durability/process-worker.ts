/** Test-only process barriers. No production route, authentication override or deployment config. */
import worker, { PersonalAgent as TestAgent } from "../worker";
import { companyIdFromHost } from "../mock-company";
import type { Fetcher } from "../../src/poppy/fetch";
import { completeDirectSignIn } from "../../src/poppy/signin";
import { isObject } from "../../src/poppy/json";

export { CompanyLimiter, DomainBudget, MockCompany, StorageProbe } from "../worker";

type Point = "before-dispatch" | "after-effect" | "after-commit" | "after-notification" |
  "task-before-dispatch" | "task-after-effect" | "task-after-terms-link" | "tool-settlement";

export class PersonalAgent extends TestAgent {
  #armed: { point: Point; approvalId: string } | undefined;

  async crashArm(point: Point, approvalId = "", replay: "safe" | "unsafe" = "safe"): Promise<void> {
    this.#armed = { point, approvalId };
    const client = this.poppy.client;
    if (point === "task-before-dispatch") {
      const resume = client.resumeCompany.bind(client);
      client.resumeCompany = async (...args) => {
        // This is after the durable request and call binding, before its executing claim.
        if (this.#armed?.point === point && args[1] === "approval" && args[2].startsWith("req_")) await this.#barrier(point);
        return resume(...args);
      };
    }
    if (point === "task-after-terms-link") {
      const host = client.host;
      Object.defineProperty(client, "host", { value: { ...host, showCard: async (...args: Parameters<typeof host.showCard>) => {
        const [card] = args;
        if (this.#armed?.point === point && card.kind === "approval" && card.terms) {
          const linked = this.ctx.storage.sql.exec("SELECT id FROM poppy_approvals WHERE id GLOB 'req_*' AND status = 'executing' AND terms_approval_id = ?", card.approvalId).toArray();
          if (linked.length !== 1) throw new Error("Terms publication must follow the durable task link");
          await this.#barrier(point);
        }
        return host.showCard(...args);
      } } });
    }
    if (point === "tool-settlement") {
      // Wrap the real registered tool, not poppyTool: Pi commits its execute intent
      // (including this policy), runs the tool, then is killed before receiving its result.
      const extension = this.registry.snapshot().extension("poppy");
      if (!extension?.tools) throw new Error("The authenticated Pi harness must already be open");
      // The green case retains production's policy; only the negative control replaces it.
      this.registry.install({ ...extension, tools: extension.tools.map(tool => tool.name !== "poppy_mcp_call" ? tool : {
        ...tool, ...(replay === "unsafe" ? { replay } : {}),
        execute: async (...args) => {
          const result = await tool.execute(...args);
          this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_saved_tool (result TEXT NOT NULL)");
          this.ctx.storage.sql.exec("INSERT INTO test_saved_tool (result) VALUES (?)", JSON.stringify(result));
          if (this.#armed?.point === point) await this.#barrier(point);
          return result;
        }
      }) });
    }
  }

  /** Full model-facing results, rather than the diagnostics helper's clipped text. */
  async crashToolResults(): Promise<string> {
    return JSON.stringify((await this.harness.messages()).flatMap(entry => (entry.model ?? []).filter(message => message.role === "toolResult")));
  }

  async crashCompleteSignIn(location: string): Promise<void> {
    const result = await completeDirectSignIn(this.poppy.client, new URL(location));
    if (!result.ok) throw new Error("The real Company token exchange must succeed before crash verification");
  }

  async #barrier(point: Point): Promise<void> {
    this.#armed = undefined;
    await fetch(`https://crash-barrier.test/${point}`, { method: "POST" });
    throw new Error("A process barrier must end with SIGKILL, never return");
  }

  protected override poppyFetcher(): Fetcher {
    return async request => {
      const url = new URL(request.url);
      let business = request.method === "POST" && url.pathname.endsWith("/exchanges");
      let approval = request.headers.has("Poppy-Approval");
      if (!approval && request.method === "POST" && url.pathname === "/mcp") {
        const body: unknown = await request.clone().json();
        business = isObject(body) && body.method === "tools/call" && isObject(body.params) && body.params.name === "exchange_item";
        approval = isObject(body) && isObject(body.params) && isObject(body.params._meta) && body.params._meta["personalagentprotocol.org/approval"] !== undefined;
      }
      if (approval && this.#armed?.point === "before-dispatch") await this.#barrier("before-dispatch");
      const response = await fetch(request);
      if (approval && this.#armed?.point === "after-effect") await this.#barrier("after-effect");
      if (business && !approval && this.#armed?.point === "task-after-effect") await this.#barrier("task-after-effect");
      return response;
    };
  }

  protected override async poppyNotify(text: string, operationId: string): Promise<void> {
    if (this.#armed?.point === "after-commit" && (operationId === `poppy-approval-${this.#armed.approvalId}` || operationId.startsWith(`poppy-approval-${this.#armed.approvalId}-`))) await this.#barrier("after-commit");
    await super.poppyNotify(text, operationId);
    if (this.#armed?.point === "after-notification" && operationId.startsWith(`poppy-approval-${this.#armed.approvalId}-`)) await this.#barrier("after-notification");
  }
}

export default {
  fetch(request: Request, env: Env & { MOCK_COMPANY: DurableObjectNamespace }): Promise<Response> {
    const id = companyIdFromHost(new URL(request.url).hostname);
    return id ? env.MOCK_COMPANY.getByName(id).fetch(request) : worker.fetch(request, env);
  }
} satisfies ExportedHandler<Env & { MOCK_COMPANY: DurableObjectNamespace }>;
