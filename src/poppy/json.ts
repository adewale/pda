/**
 * JSON parsing for Company documents and responses. `JSON.parse` silently
 * keeps the last of two members with the same name; the Guides ask both
 * sides to reject such objects ("Transport and JSON"), so this parser does.
 */
import { departure, ours, ProblemError, show, shown, type Problem, type ProblemOrText, type Shown } from "../diagnostic";

export class JsonError extends ProblemError {
  override name = "JsonError";
  constructor(problem: ProblemOrText) {
    super(problem as Problem);
  }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function parseStrictJson(text: string): Json {
  let i = 0;
  /** What is at the position: a character, or the end of the text. */
  const here = (at = i): Shown => (at < text.length ? show.value(text[at]) : ours("the end of the text"));
  const fail = (expected: Shown, got: Shown = here(), at = i): never => {
    throw new JsonError(departure(shown`position ${at}`, expected, got));
  };
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const value = (depth: number): Json => {
    if (depth > 64) fail(ours("nesting at most 64 deep"), ours("a 65th level"));
    space();
    const char = text[i];
    if (char === "{") return object(depth);
    if (char === "[") return array(depth);
    if (char === '"') return string();
    if (char === "t" && text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (char === "f" && text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (char === "n" && text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    return number();
  };
  const object = (depth: number): Json => {
    i++;
    const result: { [key: string]: Json } = {};
    const seen = new Set<string>();
    space();
    if (text[i] === "}") {
      i++;
      return result;
    }
    for (;;) {
      space();
      if (text[i] !== '"') fail(ours("a member name in double quotes"));
      const start = i;
      const key = string();
      if (seen.has(key)) fail(ours("a member name not already in this object"), show.value(key), start);
      seen.add(key);
      space();
      if (text[i] !== ":") fail(ours("':' after the member name"));
      i++;
      Object.defineProperty(result, key, {
        value: value(depth + 1),
        enumerable: true,
        writable: true,
        configurable: true
      });
      space();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return result;
      }
      fail(ours("',' or '}'"));
    }
  };
  const array = (depth: number): Json => {
    i++;
    const result: Json[] = [];
    space();
    if (text[i] === "]") {
      i++;
      return result;
    }
    for (;;) {
      result.push(value(depth + 1));
      space();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return result;
      }
      fail(ours("',' or ']'"));
    }
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        // An escape JSON defines (RFC 8259 7): one of these characters, or u and four hex digits.
        const escape = /^\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})/.exec(text.slice(i, i + 6))?.[0];
        if (!escape) fail(ours("an escape JSON defines (\\\", \\\\, \\/, \\b, \\f, \\n, \\r, \\t, or \\u and four hex digits)"), show.value(text.slice(i, text[i + 1] === "u" ? i + 6 : i + 2)));
        i += escape!.length;
        continue;
      }
      if (text.charCodeAt(i) < 0x20) fail(ours("a control character only as an escape"));
      i++;
    }
    if (text[i] !== '"') fail(ours("'\"' to close the string"));
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      // Unreachable: every escape and character was checked above.
      return fail(ours("a JSON string"), ours("one JSON.parse refuses"), start);
    }
  };
  const number = (): number => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) fail(ours("a JSON value"));
    i += match![0].length;
    return Number(match![0]);
  };
  const result = value(0);
  space();
  if (i !== text.length) fail(ours("the end of the text"));
  return result;
}

/**
 * A value our own code built that is JSON in shape: typed objects (readonly,
 * with optional members) and arrays of them. `toJson` takes one where a
 * `Json` is wanted, so the compiler checks the shape instead of a cast.
 */
export type JsonLike = null | boolean | number | string | readonly JsonLike[] | { readonly [key: string]: JsonLike | undefined };

/** `value` as `Json`: a copy, with members that are `undefined` left out, as `JSON.stringify` would. */
export function toJson(value: JsonLike): Json {
  if (value === null || typeof value !== "object") return value;
  if (isList(value)) return value.map(toJson);
  const out: { [key: string]: Json } = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) Object.defineProperty(out, key, { value: toJson(member), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function isList(value: readonly JsonLike[] | { readonly [key: string]: JsonLike | undefined }): value is readonly JsonLike[] {
  return Array.isArray(value);
}

/** A JSON value as text with every object's members sorted, so member order can't make two equal values differ. */
export function canonicalJson(value: Json | undefined): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
