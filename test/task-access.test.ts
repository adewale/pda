import { describe, expect, it } from "vitest";
import { isDeparture } from "../src/diagnostic";
import { clientFrame } from "../src/poppy/frames";
import { companyDomain, TaskAccessError } from "../src/task-access";

/** The composer's selections, refused with what was expected and what came, never the parts of an address that can carry secrets. */
describe("task access", () => {
  it("says what a Company domain was instead, keeping its parts for a tool, and never its path, query or credentials", () => {
    const refusal = (value: string) => {
      try {
        companyDomain(value);
      } catch (error) {
        return error;
      }
      throw new Error(`${value} was accepted`);
    };
    for (const value of ["shop.example/orders?token=abc123", "https://ada:hunter2@shop.example", "http://shop.example", "localhost"]) {
      const error = refusal(value);
      expect(error, value).toBeInstanceOf(TaskAccessError);
      const { problem, message } = error as TaskAccessError;
      expect(isDeparture(problem), value).toBe(true);
      if (!isDeparture(problem)) continue;
      expect(message).toBe(`the Company domain: expected ${problem.expected}, got ${problem.got}.`);
      expect(problem.got).not.toMatch(/orders|token|abc123|ada|hunter2/);
    }
  });

  it("refuses repeated link checks by the index that repeats", () => {
    const check = (index: number) => ({ index, attribute_equal: true, resolved_equal: true });
    expect(() => clientFrame({ type: "poppy.result_links.checked", cardId: "result-1", checks: [check(0), check(3), check(3)] }, "frame")).toThrow(
      "frame.checks: expected link checks with distinct indexes from 0 to 11, got 3"
    );
  });
});
