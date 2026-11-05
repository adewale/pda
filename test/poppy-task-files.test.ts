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

  it("keeps the recipient set fixed when Company content arrives", () => {
    const scope = new TaskCompanyScope();
    scope.update(access());
    expect(scope.allow("shop.example")).toBe(true);
    scope.receivedCompanyContent();
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
});
