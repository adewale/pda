/**
 * Version-independent building blocks. A profile (one per supported wire
 * version) combines these into rules; a new version reuses them and changes
 * only the rules that differ.
 */
import { departure, isDeparture, ours, sentence, show, shown, type Shown } from "../diagnostic.ts";
import { pointer, type Position } from "./json.ts";
import { MESSAGES, type Basis, type MessageId, type ProblemFor, type Ref, type Severity } from "./messages.ts";

/** Which document a message is about. */
export type DocumentKind = "poppy" | "oauth-metadata" | "client-metadata" | "jwks" | "protected-resource";

export type Message = {
  readonly id: MessageId;
  /** What the message rests on (src/validator/levels.ts); the severity follows from it. */
  readonly basis: Basis;
  readonly severity: Severity;
  /** Whether our own client refuses a Company over it: every error it doesn't tolerate, and the warnings that guard against hostile documents. */
  readonly refuses: boolean;
  readonly document: DocumentKind;
  /** JSON Pointer (RFC 6901) to the value; "" is the whole document. */
  readonly pointer: string;
  readonly line?: number;
  readonly column?: number;
  /** The message as a sentence: for a departure, "subject: expected X, got Y." */
  readonly text: Shown;
  /** For a departure (every error and warning but a few the catalog marks `fact`): what was checked, such as `agent.protocols` or a URL. */
  readonly subject?: Shown;
  /** For a departure: what the rule wants, in its words. */
  readonly expected?: Shown;
  /** For a departure: what the document or the fetch gave, quoted and bounded as src/diagnostic.ts shows values. */
  readonly got?: Shown;
  /** For a departure, when it has one: what follows from it, or what to do, as a sentence of its own. */
  readonly detail?: Shown;
  readonly ref: Ref;
};

/** Collects the messages for one document, with positions when it was parsed from text. */
export class Checker {
  readonly messages: Message[] = [];
  readonly document: DocumentKind;
  #positions: ReadonlyMap<string, Position> = new Map();

  constructor(document: DocumentKind) {
    this.document = document;
  }

  /** Where each value starts, once the document has been parsed from text. */
  usePositions(positions: ReadonlyMap<string, Position>): void {
    this.#positions = positions;
  }

  /** The value's position, or its nearest ancestor's when the value is missing. */
  #position(at: string): Position | undefined {
    for (let path = at; ; path = path.slice(0, path.lastIndexOf("/"))) {
      const found = this.#positions.get(path);
      if (found || path === "") return found;
    }
  }

  /**
   * Reports `id` at `at`. What it takes follows from the catalog
   * (`ProblemFor`): a departure, with what was expected and what was got,
   * for every message but the facts, so a report can't leave a side out.
   */
  report<Id extends MessageId>(id: Id, at: string, problem: ProblemFor<Id>, ref?: Ref, position: Position | undefined = this.#position(at)): void {
    const definition = MESSAGES[id];
    this.messages.push({
      id,
      basis: definition.basis,
      severity: definition.severity,
      refuses: definition.refuses,
      document: this.document,
      pointer: at,
      ...(position ? { line: position.line, column: position.column } : {}),
      text: sentence(problem),
      ...(isDeparture(problem)
        ? { subject: problem.subject, expected: problem.expected, got: problem.got, ...(problem.then === undefined ? {} : { detail: problem.then }) }
        : {}),
      ref: ref ?? definition.ref
    });
  }

  get errorCount(): number {
    return this.messages.filter((message) => message.severity === "error").length;
  }
}

export type Obj = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `/a/b` → `a.b`, for messages. */
export function label(at: string): string {
  return at === "" ? "the document" : at.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
}

type Expected = "object" | "string" | "array" | "boolean";

const AN: Readonly<Record<Expected, Shown>> = { object: ours("an object"), string: ours("a string"), array: ours("an array"), boolean: ours("a boolean") };

/** The member at `at`, as a message names it: `agent.protocols[0].type`. */
export function subject(at: string): Shown {
  return show.path(at);
}

/** A missing member: a value expected (with why, when it is required only sometimes), none got. */
function missing(at: string, required: true | Shown): ReturnType<typeof departure> {
  return departure(subject(at), required === true ? ours("a value") : shown`a value, ${required}`, ours("none"));
}

function hasType(value: unknown, expected: Expected): boolean {
  if (expected === "object") return isObject(value);
  if (expected === "array") return Array.isArray(value);
  return typeof value === expected;
}

/**
 * A member of `parent` of the expected type. Missing: reported if
 * `required` (shown text says why, when it's required only sometimes), else undefined. Wrong type:
 * reported, and undefined.
 */
export function member<T>(
  c: Checker,
  parent: Obj,
  parentAt: string,
  key: string,
  expected: Expected,
  required: boolean | Shown,
  ref?: Ref
): T | undefined {
  const at = pointer(parentAt, key);
  if (!(key in parent)) {
    if (required) c.report("missing-member", at, missing(at, required), ref);
    return undefined;
  }
  const value = parent[key];
  if (!hasType(value, expected)) {
    c.report("wrong-type", at, departure(subject(at), AN[expected], show.kind(value)), ref);
    return undefined;
  }
  return value as T;
}

/** Report members this version doesn't define. They're ignored, which the spec allows. */
export function unknownMembers(c: Checker, value: Obj, at: string, known: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      c.report("unknown-member", pointer(at, key), shown`${subject(pointer(at, key))} isn't defined in this version; agents ignore it`);
    }
  }
}

/**
 * Where a URL's no-fragment rule is our reading rather than an RFC's
 * (spec-issues N9): `url-has-fragment-unstated`, a warning. Every URL the
 * protocol defines is HTTPS by its own MUST (3).
 */
export type UrlRules = { readonly fragment?: "unstated" };

/** An absolute HTTPS URL with no fragment, or undefined after reporting why not. */
export function httpsUrl(c: Checker, value: unknown, at: string, ref?: Ref, rules: UrlRules = {}): URL | undefined {
  if (typeof value !== "string") {
    c.report("wrong-type", at, departure(subject(at), ours("a URL string"), show.kind(value)), ref);
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    c.report("not-a-url", at, departure(subject(at), ours("an absolute URL"), show.value(value)), ref);
    return undefined;
  }
  if (url.protocol !== "https:") {
    c.report("not-https-url", at, departure(subject(at), ours("an https URL"), show.url(url)), ref);
    return undefined;
  }
  // The URL parser accepts hosts such as "." (https://.) or "a..b", which name no server.
  const host = url.hostname.replace(/\.$/, "");
  if (host === "" || host.split(".").some((part) => part === "")) {
    c.report("not-a-url", at, departure(subject(at), ours("a URL with a host name"), show.value(value)), ref);
    return undefined;
  }
  if (value.includes("#")) {
    c.report(rules.fragment === "unstated" ? "url-has-fragment-unstated" : "url-has-fragment", at, departure(subject(at), ours("a URL without a #fragment"), ours("a URL with one")), ref);
    return undefined;
  }
  return url;
}

/** A required or optional HTTPS URL member. */
export function httpsMember(
  c: Checker,
  parent: Obj,
  parentAt: string,
  key: string,
  required: boolean | Shown,
  ref?: Ref,
  rules: UrlRules = {}
): URL | undefined {
  const at = pointer(parentAt, key);
  if (!(key in parent)) {
    if (required) c.report("missing-member", at, missing(at, required), ref);
    return undefined;
  }
  return httpsUrl(c, parent[key], at, ref, rules);
}

/** An array whose items are all strings; bad items are reported and dropped. */
export function stringList(c: Checker, value: unknown[], at: string, ref?: Ref): string[] {
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string") out.push(item);
    else c.report("wrong-type", pointer(at, index), departure(subject(pointer(at, index)), ours("a string"), show.kind(item)), ref);
  });
  return out;
}

/** RFC 6749 §3.3 scope-token: %x21 / %x23-5B / %x5D-7E, at least one. */
export function isScopeToken(value: string): boolean {
  return /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(value);
}

/** A DNS host name: labels of letters, digits and hyphens, at least two labels. */
export function isHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value)
  );
}

/**
 * Whether two hosts are on the same domain. The spec doesn't define "same
 * domain"; without the Public Suffix List we accept the same host or one a
 * subdomain of the other.
 */
export function sameDomain(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}
