import { describe, expect, it } from "vitest";
import { latestSpecPage, walkthroughs } from "../../scripts/spec-snapshot.mjs";
import { ledgerSection } from "../../scripts/spec-ledger.mjs";

describe("snapshot and requirement views", () => {
  it("selects the newest versioned spec page when the sitemap contains old and new versions", () => {
    const old = { name: "0.1-spec", markdownText: "draft version 0.1" };
    const current = { name: "0.2-spec", markdownText: "draft version 0.2" };
    expect(latestSpecPage([old, current])).toBe(current);
  });

  it("reads a walkthrough's imported version constant without evaluating the bundle", () => {
    const js = 'let v="Atlas",a=[{id:"one",steps:[{text:`uses ${x.LATEST.id}`}]}];';
    expect(walkthroughs(js, { "LATEST.id": "0.2" })[0].steps[0].text).toBe("uses 0.2");
  });

  it("escapes prose pipes in the table generated from the reviewed requirement ledger", () => {
    expect(ledgerSection({ changes: [{ change: "A | B", disposition: "shared", implementation: "src/a.ts", evidence: "test/a.ts", notes: "one\ntwo" }] })).toContain("A \\| B");
  });
});
