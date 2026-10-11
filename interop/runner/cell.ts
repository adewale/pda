/**
 * One cell: a scenario's steps against one agent and one Company (spec
 * sections 5 and 6). The adapters are behind a `Driver`, so this runs the
 * same against containers and against fakes in the unit tests.
 */
import { actorOf, evaluate, expectedRefusals, interpolate, ScenarioError, type Saved } from "./scenario.ts";
import type { Outcome, Scenario, StepRecord } from "./types.ts";

/** What an adapter call came to. */
export type Reply =
  | { readonly kind: "ok"; readonly result: unknown }
  /** `{ok: false, poppy_error}`: a Poppy error the Company returned, or a refusal. */
  | { readonly kind: "refused"; readonly poppyError: string; readonly status?: number; readonly detail?: string }
  /** 501: the adapter doesn't support it. */
  | { readonly kind: "unsupported"; readonly detail: string }
  /** 4xx/5xx with `{error, detail}`. */
  | { readonly kind: "failed"; readonly status: number; readonly error: string; readonly detail: string }
  /** The adapter didn't answer: a harness error. */
  | { readonly kind: "broken"; readonly detail: string };

export type RunnerReply =
  | { readonly kind: "ok"; readonly result?: unknown }
  | { readonly kind: "failed"; readonly detail: string }
  /** An `assert_trace` that has nothing to judge (no nonce was asked for, say): the cell is unsupported. */
  | { readonly kind: "inapplicable"; readonly detail: string };

export type Driver = {
  agent(op: string, params: unknown): Promise<Reply>;
  company(hook: string, params: unknown): Promise<Reply>;
  runner(op: string, params: unknown): Promise<RunnerReply>;
};

export type CellRun = {
  readonly outcome: Outcome;
  readonly steps: StepRecord[];
  readonly saved: Saved;
  readonly reason?: string;
};

export async function runCell(scenario: Scenario, fixture: unknown, driver: Driver): Promise<CellRun> {
  const saved: Saved = { fixture };
  const steps: StepRecord[] = [];
  const mayRefuse = expectedRefusals(scenario);
  const end = (outcome: Outcome, reason?: string): CellRun => ({ outcome, steps, saved, ...(reason ? { reason } : {}) });

  for (const [index, step] of scenario.steps.entries()) {
    const { actor, op } = actorOf(step);
    const started = Date.now();
    const record = (ok: boolean, extra: { error?: string; result?: unknown } = {}) =>
      steps.push({ actor, op, ms: Date.now() - started, ok, ...extra });

    if (actor === "expect") {
      const failures = evaluate(step.expect!, saved);
      record(failures.length === 0, failures.length ? { error: failures.join("; ") } : {});
      if (failures.length) return end("fail", `step ${index} (expect): ${failures.join("; ")}`);
      continue;
    }

    let params: unknown;
    try {
      params = interpolate(step.params ?? {}, saved);
    } catch (error) {
      const message = error instanceof ScenarioError ? error.message : String(error);
      record(false, { error: message });
      return end("fail", `step ${index} (${actor} ${op}): ${message}`);
    }

    if (actor === "runner") {
      const reply = await driver.runner(op, params);
      if (reply.kind === "inapplicable") {
        record(false, { error: reply.detail });
        return end("unsupported", `step ${index} (runner ${op}): ${reply.detail}`);
      }
      if (reply.kind === "failed") {
        record(false, { error: reply.detail });
        return end("fail", `step ${index} (runner ${op}): ${reply.detail}`);
      }
      record(true, reply.result === undefined ? {} : { result: reply.result });
      if (step.save) saved[step.save] = reply.result;
      continue;
    }

    const reply = actor === "agent" ? await driver.agent(op, params) : await driver.company(op, params);
    switch (reply.kind) {
      case "ok":
        record(true, { result: reply.result });
        if (step.save) saved[step.save] = reply.result;
        break;
      case "refused": {
        const refusal = {
          refused: true,
          poppy_error: reply.poppyError,
          ...(reply.status !== undefined ? { status: reply.status } : {}),
          ...(reply.detail ? { detail: reply.detail } : {})
        };
        if (step.save && mayRefuse.has(step.save)) {
          record(true, { result: refusal });
          saved[step.save] = refusal;
          break;
        }
        record(false, { error: `poppy_error ${reply.poppyError}${reply.detail ? `: ${reply.detail}` : ""}`, result: refusal });
        return end("fail", `step ${index} (${actor} ${op}) refused: ${reply.poppyError}${reply.detail ? ` (${reply.detail})` : ""}`);
      }
      case "unsupported":
        record(false, { error: `unsupported: ${reply.detail}` });
        if (step.optional) break;
        return end("unsupported", `step ${index} (${actor} ${op}) is unsupported: ${reply.detail}`);
      case "failed":
        record(false, { error: `${reply.status} ${reply.error}: ${reply.detail}` });
        return end("fail", `step ${index} (${actor} ${op}) failed: ${reply.status} ${reply.error}: ${reply.detail}`);
      case "broken":
        record(false, { error: reply.detail });
        return end("error", `step ${index} (${actor} ${op}): ${reply.detail}`);
    }
  }
  return end("pass");
}

/** An adapter's HTTP answer as a `Reply` (spec section 5). */
export function toReply(status: number, body: unknown, agentStep: boolean): Reply {
  const object = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (status === 501) return { kind: "unsupported", detail: String(object?.detail ?? object?.error ?? "501") };
  if (status === 0 || object === null) return { kind: "broken", detail: `no JSON answer (HTTP ${status})` };
  if (status >= 400) {
    return { kind: "failed", status, error: String(object.error ?? "error"), detail: String(object.detail ?? "") };
  }
  if (!agentStep) return { kind: "ok", result: object };
  if (object.ok === true) return { kind: "ok", result: object.result ?? {} };
  if (object.ok === false && typeof object.poppy_error === "string") {
    return {
      kind: "refused",
      poppyError: object.poppy_error,
      ...(typeof object.status === "number" ? { status: object.status } : {}),
      ...(typeof object.detail === "string" ? { detail: object.detail } : {})
    };
  }
  return { kind: "broken", detail: `an answer without ok: ${JSON.stringify(object).slice(0, 200)}` };
}
