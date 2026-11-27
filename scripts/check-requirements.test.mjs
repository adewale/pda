import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, quoteProblem } from "./check-requirements.mjs";

const pin = (version, ...paragraphs) => ({ version, paragraphs: paragraphs.map(normalize) });
// 0.3's 4.7 before and after its text of 3 November.
const MUST_TEXT = "The Company MUST describe each scope in `scopes_supported`, so the Personal Agent can choose the ones a task needs.";
const SHOULD_TEXT = "The Company SHOULD describe each scope it offers Personal Agents, so the Personal Agent can choose the ones a task needs.";

test("a MUST quoted from an older text fails once the pin says SHOULD", () => {
  const quote = "The Company MUST describe each scope in scopes_supported";
  assert.equal(quoteProblem("MUST", quote, [pin("0.3", MUST_TEXT)]), undefined);
  assert.equal(quoteProblem("MUST", quote, [pin("0.4", SHOULD_TEXT)]), "not in the 0.4 text");
});

test("the quote carries its basis's key word", () => {
  const quote = "The Company SHOULD describe each scope it offers Personal Agents";
  assert.match(quoteProblem("MUST", quote, [pin("0.4", SHOULD_TEXT)]), /has no MUST/);
  assert.equal(quoteProblem("SHOULD", quote, [pin("0.4", SHOULD_TEXT)]), undefined);
  assert.match(quoteProblem("Rule", quote, [pin("0.4", SHOULD_TEXT)]), /has SHOULD/);
});

test("every runtime pin must have the sentence", () => {
  const quote = "The Company SHOULD describe each scope it offers Personal Agents";
  assert.equal(quoteProblem("SHOULD", quote, [pin("0.4", SHOULD_TEXT), pin("1.0", MUST_TEXT)]), "not in the 1.0 text");
});

test("links, code marks and … skips are normalized; parts stay in order within a paragraph", () => {
  const text = "On every request with the Session header ([5.2](/docs/0.4/spec#session-header)), the Personal Agent sends the protocol version it implements, compatible with the chosen one, in `Poppy-Version`.";
  assert.equal(quoteProblem("Rule", "On every request with the Session header (5.2), the Personal Agent sends … in Poppy-Version", [pin("0.4", text)]), undefined);
  assert.equal(quoteProblem("Rule", "in Poppy-Version … the Personal Agent sends", [pin("0.4", text)]), "not in the 0.4 text");
  assert.equal(quoteProblem("Rule", "the Personal Agent sends … in Poppy-Version", [pin("0.4", "the Personal Agent sends", "in Poppy-Version")]), "not in the 0.4 text");
});

test("a required member counts as a MUST", () => {
  assert.equal(quoteProblem("MUST", "| protocol_version | Yes |", [pin("0.4", "| protocol_version | Yes | The protocol version |")]), undefined);
  assert.equal(quoteProblem("MUST", "resource: Required.", [pin("0.4", "- `resource`: Required.")]), undefined);
});
