/**
 * Conformance levels: what a finding rests on (its basis) decides how much it
 * counts, the same way in the validator, the mock Company and the interop
 * grid. The policy, and the conventions of other conformance suites it
 * follows, are in docs/conformance-levels.md. No Worker APIs: the validator's
 * CLI and the interop runner import this under Node.
 */

/**
 * What a requirement rests on, in the supported Personal Agent Protocol drafts,
 * which uses the BCP 14 key words only in capitals (RFC 2119, RFC 8174):
 *
 * - `MUST`: MUST, MUST NOT or a required field.
 * - `RFC`: a MUST of a standard the draft builds on (RFC 9449 for DPoP).
 * - `Rule`: a normative statement without a key word ("the Personal Agent
 *   sends `session_id` when it exchanges the code"). RFC 8174: normative
 *   text doesn't need the key words.
 * - `SHOULD`: SHOULD or SHOULD NOT, in the draft or an RFC it builds on.
 * - `Guides`: the Guides, which say each item is "a recommendation, in the
 *   sense of SHOULD" and that following them "is not required to comply".
 * - `Reading`: our answer to a question the draft leaves open
 *   (docs/readings.md, docs/spec-issues.md).
 * - `MAY`: optional.
 */
export const BASES = ["MUST", "RFC", "Rule", "SHOULD", "Guides", "Reading", "MAY"] as const;
export type Basis = (typeof BASES)[number];

/**
 * - `failure`: the draft requires it. A validator error; a mock violation; a
 *   grid check that fails the cell and is blamed by rule 1.
 * - `warning`: the draft recommends it. Reported, never fails a document or
 *   a cell; only a strict run of our own code (our conformance tests,
 *   `poppy-validate --strict`) treats it as a failure.
 * - `tentative`: our reading of an open question. Reported like a warning; a
 *   failure it causes is the spec's, not the other side's.
 * - `none`: optional. Never checked against the side that takes the option.
 */
export type Level = "failure" | "warning" | "tentative" | "none";

export const LEVELS: Readonly<Record<Basis, Level>> = {
  MUST: "failure",
  RFC: "failure",
  Rule: "failure",
  SHOULD: "warning",
  Guides: "warning",
  Reading: "tentative",
  MAY: "none"
};

export function levelOf(basis: Basis): Level {
  return LEVELS[basis];
}

export type Severity = "error" | "warning" | "info";

/** How a report shows a level: an error fails; a warning (or a tentative reading) doesn't; info is optional. */
export function severityOf(level: Level): Severity {
  return level === "failure" ? "error" : level === "none" ? "info" : "warning";
}

export function isBasis(value: unknown): value is Basis {
  return typeof value === "string" && (BASES as readonly string[]).includes(value);
}
