/**
 * JSON parsing for Company documents and responses. `JSON.parse` silently
 * keeps the last of two members with the same name; the Guides ask both
 * sides to reject such objects ("Transport and JSON"), so this parser does.
 */
export class JsonError extends Error {
  override name = "JsonError";
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function parseStrictJson(text: string): Json {
  let i = 0;
  const fail = (message: string): never => {
    throw new JsonError(`${message} at position ${i}`);
  };
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const value = (depth: number): Json => {
    if (depth > 64) fail("Nesting too deep");
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
      if (text[i] !== '"') fail("Expected a member name");
      const key = string();
      if (seen.has(key)) fail(`Duplicate member name ${JSON.stringify(key)}`);
      seen.add(key);
      space();
      if (text[i] !== ":") fail("Expected ':'");
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
      fail("Expected ',' or '}'");
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
      fail("Expected ',' or ']'");
    }
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      else if (text.charCodeAt(i) < 0x20) fail("Control character in string");
      i++;
    }
    if (text[i] !== '"') fail("Unterminated string");
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail("Bad string escape");
    }
  };
  const number = (): number => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) fail("Unexpected character");
    i += match![0].length;
    return Number(match![0]);
  };
  const result = value(0);
  space();
  if (i !== text.length) fail("Trailing characters");
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
