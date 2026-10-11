/**
 * Version-independent building blocks. A profile (one per major version of
 * the protocol) combines these into rules; a new version reuses them and
 * changes only the rules that differ.
 */
import { pointer, type Position } from "./json.ts";
import { MESSAGES, type MessageId, type Ref, type Severity } from "./messages.ts";

/** Which document a message is about. */
export type DocumentKind = "poppy" | "oauth-metadata" | "client-metadata" | "jwks";

export type Message = {
  readonly id: MessageId;
  readonly severity: Severity;
  readonly document: DocumentKind;
  /** JSON Pointer (RFC 6901) to the value; "" is the whole document. */
  readonly pointer: string;
  readonly line?: number;
  readonly column?: number;
  readonly text: string;
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

  report(id: MessageId, at: string, text: string, ref?: Ref, position: Position | undefined = this.#position(at)): void {
    const definition = MESSAGES[id];
    this.messages.push({
      id,
      severity: definition.severity,
      document: this.document,
      pointer: at,
      ...(position ? { line: position.line, column: position.column } : {}),
      text,
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

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

type Expected = "object" | "string" | "array" | "boolean";

function hasType(value: unknown, expected: Expected): boolean {
  if (expected === "object") return isObject(value);
  if (expected === "array") return Array.isArray(value);
  return typeof value === expected;
}

/**
 * A member of `parent` of the expected type. Missing: reported if
 * `required` (a string says when it's required), else undefined. Wrong type:
 * reported, and undefined.
 */
export function member<T>(
  c: Checker,
  parent: Obj,
  parentAt: string,
  key: string,
  expected: Expected,
  required: boolean | string,
  ref?: Ref
): T | undefined {
  const at = pointer(parentAt, key);
  if (!(key in parent)) {
    if (required) {
      const when = typeof required === "string" ? ` ${required}` : "";
      c.report("missing-member", at, `${label(at)} is required${when}.`, ref);
    }
    return undefined;
  }
  const value = parent[key];
  if (!hasType(value, expected)) {
    const article = expected === "array" || expected === "object" ? "an" : "a";
    c.report("wrong-type", at, `${label(at)} must be ${article} ${expected}, not ${typeName(value)}.`, ref);
    return undefined;
  }
  return value as T;
}

/** Report members this version doesn't define. They're ignored, which the spec allows. */
export function unknownMembers(c: Checker, value: Obj, at: string, known: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      c.report("unknown-member", pointer(at, key), `${label(pointer(at, key))} isn't defined in this version; agents ignore it.`);
    }
  }
}

/** An absolute HTTPS URL with no fragment, or undefined after reporting why not. */
export function httpsUrl(c: Checker, value: unknown, at: string, ref?: Ref): URL | undefined {
  if (typeof value !== "string") {
    c.report("wrong-type", at, `${label(at)} must be a URL string, not ${typeName(value)}.`, ref);
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    c.report("not-a-url", at, `${label(at)} isn't an absolute URL: ${JSON.stringify(value)}.`, ref);
    return undefined;
  }
  if (url.protocol !== "https:") {
    c.report("not-https-url", at, `${label(at)} must be an HTTPS URL, not ${url.protocol.replace(":", "")}: ${value}.`, ref);
    return undefined;
  }
  if (value.includes("#")) {
    c.report("url-has-fragment", at, `${label(at)} can't contain a #fragment: ${value}.`, ref);
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
  required: boolean | string,
  ref?: Ref
): URL | undefined {
  const at = pointer(parentAt, key);
  if (!(key in parent)) {
    if (required) {
      const when = typeof required === "string" ? ` ${required}` : "";
      c.report("missing-member", at, `${label(at)} is required${when}.`, ref);
    }
    return undefined;
  }
  return httpsUrl(c, parent[key], at, ref);
}

/** An array whose items are all strings; bad items are reported and dropped. */
export function stringList(c: Checker, value: unknown[], at: string, ref?: Ref): string[] {
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string") out.push(item);
    else c.report("wrong-type", pointer(at, index), `${label(pointer(at, index))} must be a string, not ${typeName(item)}.`, ref);
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

/** Host comparison that ignores case and one leading `www.` (spec 3.1). */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** RFC 8707 resource indicator: an absolute URI without a fragment. */
export function resourceIndicator(c: Checker, value: unknown, at: string): void {
  if (typeof value !== "string") {
    c.report("wrong-type", at, `${label(at)} must be a string, not ${typeName(value)}.`);
    return;
  }
  let ok = false;
  try {
    ok = !!new URL(value).protocol && !value.includes("#");
  } catch {
    ok = false;
  }
  if (!ok) c.report("resource-invalid", at, `${label(at)} must be an absolute URI without a fragment: ${JSON.stringify(value)}.`);
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
