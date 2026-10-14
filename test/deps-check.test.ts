import { describe, expect, it } from "vitest";
import { npmError, outdatedSection } from "../scripts/deps-report";

/**
 * `npm run deps:check`'s outdated section (scripts/deps-report.ts), on what
 * `npm outdated --json --long` prints: a report of packages, an empty one, or
 * npm's own `{"error": …}` when it fails, which is the check's error to
 * report, never a package named "error".
 */
describe("the dependency check's outdated section", () => {
  it("reports npm's own failure as the check's, not as a package named error", () => {
    const failed = { json: { error: { code: "ENOTFOUND", summary: "request to https://registry.npmjs.org/agents failed", detail: "Check your network." } } };
    expect(npmError(failed.json)).toBe("ENOTFOUND: request to https://registry.npmjs.org/agents failed");
    const lines = outdatedSection(failed);
    expect(lines[0]).toBe("Couldn't list outdated packages: ENOTFOUND: request to https://registry.npmjs.org/agents failed");
    expect(lines.join("\n")).not.toContain("| error |");
    expect(lines.join("\n")).not.toContain("not installed");
    // An error npm gives only a detail for still reads as one.
    expect(outdatedSection({ json: { error: { detail: "No lockfile" } } })[0]).toBe('Couldn\'t list outdated packages: {"detail":"No lockfile"}');
  });

  it("lists a package that really is named error", () => {
    const lines = outdatedSection({
      json: { error: { current: "1.0.0", wanted: "1.0.1", latest: "2.0.0", type: "dependencies" } }
    }).join("\n");
    expect(npmError({ error: { current: "1.0.0", wanted: "1.0.1", latest: "2.0.0" } })).toBeNull();
    expect(lines).toContain("| error | prod | 1.0.0 | 1.0.1 | 2.0.0 | update in range, new major |");
  });

  it("lists outdated packages, says when none are, and reports npm not running", () => {
    const lines = outdatedSection({
      json: {
        vitest: { current: "4.1.0", wanted: "4.1.11", latest: "4.1.11", type: "devDependencies" },
        jose: [{ current: "6.2.12", wanted: "6.2.12", latest: "7.0.0", type: "dependencies" }],
        zod: { wanted: "4.5.4", latest: "4.5.4", type: "dependencies" }
      }
    }).join("\n");
    expect(lines).toContain("3 direct dependencies are behind.");
    expect(lines).toContain("| jose | prod | 6.2.12 | 6.2.12 | 7.0.0 | new major |");
    expect(lines).toContain("| vitest | dev | 4.1.0 | 4.1.11 | 4.1.11 | update in range |");
    expect(lines).toContain("| zod | prod | missing | 4.5.4 | 4.5.4 | not installed |");
    expect(outdatedSection({ json: {} })).toEqual(["Every direct dependency is at its latest version.", ""]);
    expect(outdatedSection({ error: "npm outdated printed nothing" })[0]).toBe("Couldn't list outdated packages: npm outdated printed nothing");
  });
});
