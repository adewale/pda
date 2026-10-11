/** The shapes docs/interop-spec.md defines, as the runner reads and writes them. */

export type Role = "agent" | "company";

export type RegistryEntry = {
  readonly name: string;
  readonly role: Role;
  readonly source: string;
  readonly commit: string;
  /** `"self"` marks an implementation this project owns. Adversarial cells run only against self-owned honest sides. */
  readonly owner?: "self";
  /** An implementation that misbehaves on purpose (evil-agent, evil-company). The live lane refuses it (spec §10). */
  readonly adversarial?: boolean;
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
  /** Attack ids this adversarial adapter can `arm` (spec §4). An unknown attack answers 501, so the cell is `unsupported`. */
  readonly attacks?: readonly string[];
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
  /** A `${...}` reference: the step runs only when it names something other than null or false. */
  readonly when?: string;
  readonly expect?: Expectations;
  readonly note?: string;
};

/** `{"${a.b}": value-or-operator}`, or `{"step": "name", "poppy_error": "code"}`, or a list of either. */
export type Expectations = Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[];

/** A network fault the recording proxy injects (spec §6, Part B of docs/adversarial-interop.md). */
export type Fault = {
  /** Which exchanges this fault acts on. */
  readonly match: {
    readonly host?: string;
    readonly path?: string;
    readonly method?: string;
    readonly direction?: "to-company" | "to-agent";
    /** Act only on the nth matching exchange (1-based); every match when absent. */
    readonly nth?: number;
  };
  readonly action: "replay" | "duplicate" | "drop_response" | "delay" | "truncate" | "reset" | "status";
  /** `delay`: milliseconds. `truncate`: bytes to keep. `status`: the HTTP status to answer. `replay`: milliseconds to wait before resending. */
  readonly ms?: number;
  readonly bytes?: number;
  readonly status?: number;
};

export type Scenario = {
  readonly id: string;
  readonly title: string;
  readonly requirements?: readonly string[];
  /** Open questions (spec section 7) a failure here may depend on, for attribution rule 3. */
  readonly readings?: readonly string[];
  readonly needs?: { readonly agent?: readonly string[]; readonly company?: readonly string[] };
  /** Scenarios the live lane may run. */
  readonly live?: boolean;
  /**
   * An adversarial scenario (docs/adversarial-interop.md, Part B): the side that
   * misbehaves. `"network"` is the fault-injection proxy; `"company"`/`"agent"`
   * need an adversarial implementation of that role. Attribution applies rule 0.
   */
  readonly adversary?: "company" | "agent" | "network";
  /** The draft requirement (`"N10"`) that permits the attack, so a failure is the spec's, not the honest side's. */
  readonly permitted_by?: string;
  /** Network faults the recording proxy injects for this scenario (spec §6). */
  readonly faults?: readonly Fault[];
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
export type Rule = "adversarial" | "violation" | "grid" | "reading" | "unattributed" | null;

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
  /** An adversarial cell (an adversarial side, or a proxy `faults` list): shown in the security grid, never in interop pass rates (spec §9). */
  security?: boolean;
  /** Failed or errored, then passed when run again: recorded as a pass, never a known failure. */
  flaky?: boolean;
  /** Each run of a cell that was run again, in order; the cell itself is the last. */
  attempts?: Attempt[];
};

export type Attempt = { readonly outcome: Outcome; readonly reason?: string; readonly har: string | null };

export type KnownFailure = {
  readonly agent: string;
  readonly company: string;
  readonly scenario: string;
  readonly issue: string;
  readonly reason?: string;
};
