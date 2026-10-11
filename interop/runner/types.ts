/** The shapes docs/interop-spec.md defines, as the runner reads and writes them. */

export type Role = "agent" | "company";

export type RegistryEntry = {
  readonly name: string;
  readonly role: Role;
  readonly source: string;
  readonly commit: string;
  /** A directory holding a Dockerfile (local lane). */
  readonly build?: string;
  /** The Docker build context, relative to the repository root; the build directory when absent. */
  readonly context?: string;
  /** A running deployment's domain or URL (live lane). */
  readonly url?: string;
  /** Subdomains of `<name>.company.interop.test` the Company serves, beyond the defaults. */
  readonly subdomains?: readonly string[];
  /** Extra environment for the container. */
  readonly env?: Readonly<Record<string, string>>;
  readonly notes?: string;
};

export type Registry = { readonly version: 1; readonly implementations: readonly RegistryEntry[] };

export type Manifest = {
  readonly interop: number;
  readonly name: string;
  readonly role: Role;
  readonly commit: string;
  readonly poppy: readonly string[];
  readonly extensions?: readonly string[];
  readonly scenarios: readonly string[];
  readonly readings?: Readonly<Record<string, string>>;
  readonly relaxations?: readonly string[];
};

export type Actor = "agent" | "company" | "runner";

export type Step = {
  readonly agent?: string;
  readonly company?: string;
  readonly runner?: string;
  readonly params?: unknown;
  readonly save?: string;
  /** A 501 from the adapter skips this step instead of ending the cell as unsupported. */
  readonly optional?: boolean;
  readonly expect?: Expectations;
  readonly note?: string;
};

/** `{"${a.b}": value-or-operator}`, or `{"step": "name", "poppy_error": "code"}`, or a list of either. */
export type Expectations = Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[];

export type Scenario = {
  readonly id: string;
  readonly title: string;
  readonly requirements?: readonly string[];
  /** Open questions (spec section 7) a failure here may depend on, for attribution rule 3. */
  readonly readings?: readonly string[];
  readonly needs?: { readonly agent?: readonly string[]; readonly company?: readonly string[] };
  /** Scenarios the live lane may run. */
  readonly live?: boolean;
  readonly steps: readonly Step[];
};

export type Severity = "error" | "warning";
export type Side = "agent" | "company";

export type Check = {
  readonly id: string;
  readonly side: Side;
  readonly severity: Severity;
  /** Index of the HAR entry, when one exchange shows it. */
  readonly exchange: number | null;
  readonly detail: string;
  /** "trace", "validator", or "company:<name>" for violations a Company adapter recorded. */
  readonly source: string;
};

export type StepRecord = {
  readonly actor: Actor | "expect";
  readonly op: string;
  readonly ms: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly result?: unknown;
};

export type Outcome = "pass" | "fail" | "unsupported" | "error";
export type Blame = "agent" | "company" | "spec" | "harness" | null;
export type Rule = "violation" | "grid" | "reading" | "unattributed" | null;

export type Cell = {
  readonly agent: string;
  readonly company: string;
  readonly scenario: string;
  outcome: Outcome;
  blame: Blame;
  rule: Rule;
  steps: StepRecord[];
  checks: Check[];
  har: string | null;
  /** Why the cell was unsupported or errored, or what failed first. */
  reason?: string;
  known?: { readonly issue: string; readonly reason?: string };
};

export type KnownFailure = {
  readonly agent: string;
  readonly company: string;
  readonly scenario: string;
  readonly issue: string;
  readonly reason?: string;
};
