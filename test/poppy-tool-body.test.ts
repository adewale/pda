import { describe, expect, it, vi } from "vitest";
import { Validator } from "@cfworker/json-schema";
import { callOpenApi } from "../src/poppy/apis";
import { poppyExtension } from "../src/poppy/tools";
import type { PoppyClient } from "../src/poppy/client";

vi.mock("../src/poppy/apis", async (original) => ({
  ...await original<typeof import("../src/poppy/apis")>(),
  callOpenApi: vi.fn(async () => ({ status: 200 }))
}));

const company = vi.fn(async () => ({ name: "Print shop" }));
const apiTool = poppyExtension(
  () => ({ company }) as unknown as PoppyClient,
  () => { throw new Error("No browser needed"); }
).tools!.find((tool) => tool.name === "poppy_api_call")!;

async function invoke(args: Record<string, unknown>) {
  vi.mocked(callOpenApi).mockClear();
  company.mockClear();
  return apiTool.execute(
    { domain: "prints.example", operation: "orderPrints", ...args } as never,
    { conversationId: "test", callId: "body" } as never,
    {} as never
  );
}

describe("poppy_api_call model-facing body", () => {
  it("advertises an object body and rejects a stringified object in the tool schema", () => {
    const schema = JSON.parse(JSON.stringify(apiTool.parameters));
    expect(schema.properties.body.type).toBe("object");
    const validator = new Validator(schema);
    const args = { domain: "prints.example", operation: "orderPrints" };
    const body = { product: "prints", items: [{ photoId: "photo_1", quantity: 3 }] };
    expect(validator.validate({ ...args, body }).valid).toBe(true);
    expect(validator.validate({ ...args, body: JSON.stringify(body) }).valid).toBe(false);
    expect(validator.validate(args).valid).toBe(true);
  });

  it("passes the object unchanged to the existing OpenAPI validation and approval flow", async () => {
    const body = { product: "prints", items: [{ photoId: "photo_1", quantity: 3 }] };
    await invoke({ body });
    expect(vi.mocked(callOpenApi).mock.calls[0][3].body).toBe(body);
  });

  it.each([["a", { nested: true }], "literal string", 42, false, null].map((value) => [value]))(
    "preserves a non-object JSON body: %j", async (bodyValue) => {
      const validator = new Validator(JSON.parse(JSON.stringify(apiTool.parameters)));
      expect(validator.validate({ domain: "prints.example", operation: "orderPrints", bodyValue }).valid).toBe(true);
      await invoke({ bodyValue });
      expect(vi.mocked(callOpenApi).mock.calls[0][3].body).toEqual(bodyValue);
    }
  );

  it("rejects ambiguous bodies before discovery or a request, including null", async () => {
    const result = await invoke({ body: {}, bodyValue: null });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Pass either body or bodyValue");
    expect(company).not.toHaveBeenCalled();
    expect(callOpenApi).not.toHaveBeenCalled();
  });

  it("omits the request body when neither field is present", async () => {
    await invoke({});
    expect(vi.mocked(callOpenApi).mock.calls[0][3]).not.toHaveProperty("body");
  });
});
