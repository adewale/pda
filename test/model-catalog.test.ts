/**
 * The models the configuration names, resolved as the deploy check resolves
 * them (`src/model-catalog.ts`, run by `scripts/check-deployment.ts`).
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { demoCatalogModel, demoCompatProblem, modelCatalogProblems } from "../src/model-catalog";

describe("the models a deployment names", () => {
  it("all resolve for the test configuration", () => {
    expect(modelCatalogProblems(env)).toEqual([]);
  });

  it("refuses a demo model whose compat flags wouldn't carry the compaction fix", () => {
    const demo = demoCatalogModel(env);
    expect(demoCompatProblem(demo, env.DEMO_MODEL_ID)).toBeNull();
    // An Anthropic model pi-ai's own Anthropic catalog doesn't list.
    const unknown = { ...demo, id: "anthropic/claude-unlisted-9.9" } as Model<Api>;
    expect(demoCompatProblem(unknown, "anthropic/claude-unlisted-9.9")?.message).toMatch(/^DEMO_MODEL_ID: expected an Anthropic model pi-ai's own Anthropic catalog lists too/);
    // Another vendor's demo model has no such flags to carry.
    expect(demoCompatProblem({ ...demo, api: "openai-completions" } as Model<Api>, "openai/gpt-6.1-sol")).toBeNull();
  });

  it("names a demo model the gateway's catalog spells differently", () => {
    const [problem, ...rest] = modelCatalogProblems({ ...env, DEMO_MODEL_ID: "anthropic/claude-sonnet-5-5" });
    expect(rest).toEqual([]);
    expect(problem).toMatch(/^DEMO_MODEL_ID: expected a model in AI Gateway's catalog, spelled as that catalog spells it, got "anthropic\/claude-sonnet-5-5"/);
    expect(problem).toContain("anthropic/claude-sonnet-5.5");
  });
});
