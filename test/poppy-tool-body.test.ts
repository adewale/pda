import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { poppyExtension } from "../src/poppy/tools";
import type { PoppyClient } from "../src/poppy/client";

/**
 * poppy_api_call's body arguments as pi checks them: pi-durable runs pi-ai's
 * validateToolArguments on every call before the tool, so these are what a
 * model's call meets first. What the agent does with a body that passes is in
 * test/print-journey.test.ts, against the mock print shop.
 */
const apiTool = poppyExtension(
  () => ({}) as PoppyClient,
  () => {
    throw new Error("No browser needed");
  }
).tools!.find((tool) => tool.name === "poppy_api_call")!;

const order = { product: "prints", items: [{ photoId: "photo_1", quantity: 3 }] };

function check(args: Record<string, unknown>) {
  return validateToolArguments(apiTool, {
    type: "toolCall",
    id: "call_1",
    name: "poppy_api_call",
    arguments: { domain: "prints.example", operation: "orderPrints", ...args }
  });
}

describe("poppy_api_call's body in pi's argument check", () => {
  it("takes body as an object and refuses a string of one", () => {
    expect(check({ body: order }).body).toEqual(order);
    expect(() => check({ body: JSON.stringify(order) })).toThrow(/Validation failed for tool "poppy_api_call"/);
    expect(check({})).not.toHaveProperty("body");
  });

  it.each([[["a", { nested: true }]], ["literal string"], [42], [false], [null]])("takes a body that isn't an object as bodyValue: %j", (bodyValue) => {
    expect(check({ bodyValue }).bodyValue).toEqual(bodyValue);
  });
});
