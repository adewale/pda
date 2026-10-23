/** The shapes docs/interop-spec.md defines, as the runner reads and writes them. */
import type { Basis } from "../../src/validator/levels.ts";

export type Role = "agent" | "company";

export type RegistryEntry = {
  readonly name: string;
  readonly role: Role;
  readonly source: string;
  readonly commit: string;
  /** `"self"` marks an implementation this project owns. Adversarial cells run only against self-owned honest sides. */
  readonly owner?: "self";
  /** An implementation that misbehaves on purpose (evil-personal-agent, evil-company). The live lane refuses it (spec §10). */
  readonly adversarial?: boolean;
  /**
   * A fake implementation, built to test the other side: the fake Personal Agents
   * (lenient-, strict- and sloppy-personal-agent). The live lane never runs it (spec §10).
   */
  readonly fake?: boolean;
  /** A directory holding a Dockerfile (local lane). */
  readonly build?: string;
  /** Public source pins passed into a shared build; never credentials. */
  readonly buildArgs?: Readonly<Record<string, string>>;
  /** The Docker build context, relative to the repository root; the build directory when absent. */
  readonly context?: string;
  /** A running deployment's domain or URL (live lane). */
  readonly url?: string;
  /** Expected declared version of a live Company; old entries default to 0.1. */
  readonly protocolVersion?: string;
  /**
   * A live Company's fixture (spec §10): it has no adapter, so no `fixture`
   * hook, and a scenario that calls one of its operations needs to know which
   * (`openapi_public` for N). Merged over the lane's one greeting.
   */
  readonly fixture?: Readonly<Record<string, unknown>>;
  /** Subdomains of `<name>.company.interop.test` the Company serves, beyond the defaults. */
  readonly subdomains?: readonly string[];
  /** Extra environment for the container. */
  readonly env?: Readonly<Record<string, string>>;
  /** Provisioning helper for a one-sided vector lane; excluded from default M×N selection. */
  readonly vectorsOnly?: boolean;
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
  /** `error` for a failure, `warning` for the rest; from `basis` where there is one (docs/conformance-levels.md). */
  readonly severity: Severity;
  /** What the check rests on (src/validator/levels.ts): `Reading` makes a warning tentative. Absent or null: unknown, and the severity decides. */
  readonly basis?: Basis | null;
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
export type Rule = "adversarial" | "violation" | "warning" | "grid" | "reading" | "unattributed" | null;

export type Cell = {
  protocolVersion?: string;
  specificationRevision?: string;
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

/**
 * A failure we know about (spec section 9). Its cell (`agent`, `company`,
 * `scenario`, each a name or `*`) says where it may happen; `blame`,
 * `checks` and `errors` say what it looks like, so a different failure in
 * the same cell is still unexpected.
 */
export type KnownFailure = {
  readonly protocolVersion?: string;
  readonly agent: string;
  readonly company: string;
  readonly scenario: string;
  /**
   * The blame attribution gives the cell (`null`: unattributed), or the list
   * of them where one root cause is blamed differently across the cells it
   * spans (rule 2 can decide a cell its neighbours leave unattributed).
   */
  readonly blame: Blame | readonly Blame[];
  /** Every error check the cell may show: one outside this list makes it unexpected. Absent: none. */
  readonly checks?: readonly string[];
  /** The first failed step's code (`failureCode` in attribution.ts) the cell may show. Absent: none, so the cell may only fail on checks. */
  readonly errors?: readonly string[];
  readonly issue: string;
  readonly reason?: string;
};
