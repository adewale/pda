/** Test-only process barriers. No production route, authentication override or deployment config. */
import worker, { PersonalAgent as TestAgent } from "../worker";
import { companyIdFromHost } from "../mock-company";
import type { Fetcher } from "../../src/poppy/fetch";
import { completeDirectSignIn } from "../../src/poppy/signin";
import { isObject } from "../../src/poppy/json";

export { CompanyLimiter, DomainBudget, MockCompany, StorageProbe } from "../worker";

type Point = "before-dispatch" | "after-effect" | "after-commit" | "after-notification";

export class PersonalAgent extends TestAgent {
  #armed: { point: Point; approvalId: string } | undefined;

  async crashArm(point: Point, approvalId: string): Promise<void> {
    this.#armed = { point, approvalId };
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
      let approval = request.headers.has("Poppy-Approval");
      if (!approval && request.method === "POST" && new URL(request.url).pathname === "/mcp") {
        const body: unknown = await request.clone().json();
        approval = isObject(body) && isObject(body.params) && isObject(body.params._meta) && body.params._meta["personalagentprotocol.org/approval"] !== undefined;
      }
      if (approval && this.#armed?.point === "before-dispatch") await this.#barrier("before-dispatch");
      const response = await fetch(request);
      if (approval && this.#armed?.point === "after-effect") await this.#barrier("after-effect");
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
