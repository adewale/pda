import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsFor, breakingChanges, compare, markdown, missingApis, newer, satisfies, typeErrorCount } from "./upgrade-report.ts";

test("versions compare by number, and ranges take what npm's would", () => {
  assert.ok(compare("1.10.0", "1.9.9") > 0);
  assert.equal(compare("1.6.1", "1.6.1"), 0);
  assert.ok(satisfies("1.6.4", "~1.6.1"));
  assert.ok(!satisfies("1.7.0", "~1.6.1"));
  assert.ok(!satisfies("1.6.0", "~1.6.1"));
  assert.ok(satisfies("1.9.0", "^1.0.0"));
  assert.ok(!satisfies("2.0.0", "^1.0.0"));
  assert.ok(satisfies("0.34.2", "^0.34.1") && !satisfies("0.35.0", "^0.34.1"));
  assert.ok(satisfies("1.6.1", "1.6.1") && !satisfies("1.6.2", "1.6.1"));
  assert.deepEqual(newer(["1.3.0", "1.4.0", "1.6.1", "1.6.0", "2.0.0-beta.1", "1.2.0"], "1.3.0"), ["1.4.0", "1.6.0", "1.6.1"]);
});

test("picks the newest agents release, never an older one, whose pi-ai peer takes the candidate", () => {
  const peers = {
    "0.28.1": { "@earendil-works/pi-ai": "^1.0.0" },
    "0.29.0": { "@earendil-works/pi-ai": "~1.3.0" },
    "0.33.0": { "@earendil-works/pi-ai": "~1.5.0" },
    "0.34.0": { "@earendil-works/pi-ai": "~1.6.0" },
    "0.34.1": { "@earendil-works/pi-ai": "~1.6.1" },
    "0.35.0-next.1": { "@earendil-works/pi-ai": "~1.7.0" }
  };
  assert.equal(agentsFor("1.6.1", peers, "0.28.1"), "0.34.1");
  assert.equal(agentsFor("1.6.0", peers, "0.28.1"), "0.34.0");
  // 0.28.1's loose ^1.0.0 doesn't count for a pi it predates, and agents never goes back.
  assert.equal(agentsFor("1.7.0", peers, "0.34.1"), null);
  assert.equal(agentsFor("1.3.0", peers, "0.29.0"), "0.29.0");
});

const CHANGELOG = `# Changelog

## [Unreleased]

### Breaking Changes

- Not released yet.

## [1.6.1] - 2026-11-25

### Breaking Changes

- Tool parks are tagged: \`{ kind: "sleep" }\`.
  A second line that is not kept.
- \`CommitResult\` is tagged.

### Fixed

- A fix, not a breaking change.

## [1.6.0] - 2026-11-20

### Added

- Signals.

## [1.5.0] - 2026-11-02

### Breaking Changes

- The main entry no longer re-exports TypeBox.

## [1.3.0] - 2026-10-15

### Breaking Changes

- Already installed; not listed.
`;

test("lists the breaking changes of each release after the installed one, up to the candidate", () => {
  assert.deepEqual(breakingChanges(CHANGELOG, "1.3.0", "1.6.1"), [
    { version: "1.6.1", items: ["Tool parks are tagged: `{ kind: \"sleep\" }`.", "`CommitResult` is tagged."] },
    { version: "1.5.0", items: ["The main entry no longer re-exports TypeBox."] }
  ]);
  assert.deepEqual(breakingChanges(CHANGELOG, "1.5.0", "1.6.0"), []);
  assert.equal(breakingChanges(CHANGELOG, "1.3.0", "1.6.1", 12)[0].items[0], "Tool parks …");
});

const TSC = `src/agent-log.ts(21,15): error TS2305: Module '"@earendil-works/pi-durable"' has no exported member 'AgentEvent'.
src/sockets.ts(125,57): error TS2339: Property 'events' does not exist on type 'PiSession'.
src/compaction.ts(195,9): error TS2322: Type 'X' is not assignable to type 'Y'.
  Property 'kind' is missing in type 'X'.`;

test("reads the APIs a trial typecheck says are gone, and counts its errors", () => {
  assert.deepEqual(missingApis(TSC), [
    { file: "src/agent-log.ts", line: 21, name: "AgentEvent", from: "@earendil-works/pi-durable" },
    { file: "src/sockets.ts", line: 125, name: "events", from: "PiSession" }
  ]);
  assert.equal(typeErrorCount(TSC), 3);
});

test("reports a move, what blocks it and what a trial found, as Markdown", () => {
  const text = markdown({
    installed: { pi: "1.3.0", agents: "0.28.1" },
    target: { pi: "1.6.1", agents: "0.34.1" },
    breaking: { "@earendil-works/pi-durable": breakingChanges(CHANGELOG, "1.3.0", "1.6.1"), "@earendil-works/chord": [] },
    issues: [{ repository: "earendil-works/pi", number: 12181, title: "a host restart | mid-answer", url: "https://github.com/earendil-works/pi/issues/12181", createdAt: "2026-11-15T00:00:00Z" }],
    trial: { steps: [{ name: "npm install", status: 0, tail: "" }, { name: "npm run typecheck", status: 2, tail: "error TS2305" }], missing: missingApis(TSC), typeErrors: 3 }
  });
  assert.match(text, /\| Candidate \| 1\.6\.1 \| 0\.34\.1 \|/);
  assert.match(text, /#### @earendil-works\/pi-durable\n\n- \*\*1\.6\.1\*\*\n  - Tool parks/);
  assert.doesNotMatch(text, /@earendil-works\/chord/);
  assert.match(text, /\[earendil-works\/pi#12181\]\(https:\/\/github\.com\/earendil-works\/pi\/issues\/12181\) \| 2026-11-15 \| a host restart \\\| mid-answer/);
  assert.match(text, /\| npm run typecheck \| failed \(exit 2\) \|/);
  assert.match(text, /\| src\/agent-log\.ts:21 \| AgentEvent \| @earendil-works\/pi-durable \|/);
  assert.match(text, /<summary>npm run typecheck: the end of its output<\/summary>/);
  assert.match(markdown({ installed: { pi: "1.6.1", agents: "0.34.1" }, target: null, breaking: {}, issues: [], trial: { skipped: "" } }), /Nothing newer to try/);
  assert.match(markdown({ installed: { pi: "1.6.1", agents: "0.34.1" }, target: { pi: "1.7.0", agents: null }, breaking: {}, issues: { skipped: "no token" }, trial: { skipped: "no agents release" } }), /No `agents` release accepts this pi yet/);
});
