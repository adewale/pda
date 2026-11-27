import { describe, expect, it } from "vitest";
import { readTaskAccess } from "../src/task-access";
import { TaskFiles } from "../src/poppy/task-files";
import { TaskCompanyScope } from "../src/poppy/task-scope";

const photo = "att_aaaaaaaaaaaaaaaaaaaaaa";
const other = "att_bbbbbbbbbbbbbbbbbbbbbb";
const access = () => readTaskAccess({ companies: ["shop.example"], uploads: [{ company: "shop.example", files: [photo] }] });

describe("explicit task access", () => {
  it("binds selected photos to their destination and grants nothing for an absent selection", () => {
    expect(TaskFiles.selected(access(), "shop.example").includes([photo])).toBe(true);
    expect(TaskFiles.selected(access(), "other.example").includes([photo])).toBe(false);
    expect(TaskFiles.selected(access(), "shop.example").includes([other])).toBe(false);
    expect(TaskFiles.selected(undefined, "shop.example").includes([photo])).toBe(false);
    expect(TaskFiles.none().includes([photo])).toBe(false);
  });

  it("allows only the selected recipients, and none once they are withdrawn", () => {
    const scope = new TaskCompanyScope();
    scope.update(access());
    expect(scope.allow("shop.example")).toBe(true);
    expect(scope.allow("excluded.example")).toBe(false);
    scope.update(undefined);
    expect(scope.allow("shop.example")).toBe(false);
  });

  it.each([
    { companies: ["shop.example/path"], uploads: [] },
    { companies: ["https://user:pass@shop.example"], uploads: [] },
    { companies: ["127.0.0.1"], uploads: [] },
    { companies: ["shop.example"], uploads: [{ company: "excluded.example", files: [photo] }] },
    { companies: ["shop.example"], uploads: [{ company: "shop.example", files: ["not-an-id"] }] },
    { companies: ["shop.example"], uploads: [], authorizeAll: true }
  ])("rejects invalid structured permission: %j", input => {
    expect(() => readTaskAccess(input)).toThrow();
  });

  it("says what it expected and what it got, never an address's credentials", () => {
    const refusal = (input: unknown) => { try { readTaskAccess(input); } catch (error) { return (error as Error).message; } return null; };
    expect(refusal({ companies: ["shop.example/path"], uploads: [] })).toBe("the Company domain: expected a public HTTPS Company domain, without a path, query or credentials, got shop.example with a path or query.");
    expect(refusal({ companies: ["https://user:pass@shop.example"], uploads: [] })).toBe("the Company domain: expected a public HTTPS Company domain, without a path, query or credentials, got an address with credentials.");
    expect(refusal({ companies: ["127.0.0.1"], uploads: [] })).toBe("the Company domain: expected a public HTTPS Company domain, without a path, query or credentials, got 127.0.0.1, which isn't public.");
    expect(refusal({ companies: ["shop.example"], uploads: [{ company: "excluded.example", files: [photo] }] })).toBe("a photo selection's company: expected one of the selected Companies, got excluded.example.");
    expect(refusal({ companies: ["shop.example"], uploads: [{ company: "shop.example", files: ["not-an-id"] }] })).toBe('a photo selection\'s files: expected attachment ids, got "not-an-id".');
    expect(refusal({ companies: ["shop.example"], uploads: [], authorizeAll: true })).toBe('the task access: expected companies and uploads only, got also "authorizeAll".');
  });
});
