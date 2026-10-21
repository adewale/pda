/**
 * A JSON parser for validation. Unlike `JSON.parse` it keeps going after a
 * duplicate member name (recording it, since the Guides ask receivers to
 * reject such objects), and it remembers where each value starts, so every
 * message can point at a line and column as well as a JSON Pointer.
 */

export type Position = { readonly line: number; readonly column: number };

export type Duplicate = { readonly pointer: string; readonly name: string; readonly position: Position };

export type Parsed =
  | {
      readonly ok: true;
      readonly value: unknown;
      /** JSON Pointer (RFC 6901) → where that value starts. */
      readonly positions: ReadonlyMap<string, Position>;
      readonly duplicates: readonly Duplicate[];
      readonly bom: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly position: Position; readonly resourceLimit?: true };

/** RFC 6901: `~` becomes `~0` and `/` becomes `~1`. */
export function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

class SyntaxProblem extends Error {}
class ResourceProblem extends SyntaxProblem {}

/**
 * Position keys can repeat a long ancestor name for every child. Count
 * their UTF-16 code units cumulatively, before allocating or hashing each
 * path. One million units bounds the pointer strings themselves to about
 * 2 MB; this is an implementation allowance, not a JSON conformance rule
 * or a bound on all memory used by parsing and validation.
 */
export const JSON_PARSE_LIMITS = { pointerCharacters: 1_000_000 } as const;

const MAX_DEPTH = 64;

const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

export function parseJson(input: string): Parsed {
  const bom = input.startsWith("﻿");
  const text = bom ? input.slice(1) : input;
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") lineStarts.push(k + 1);
  const at = (offset: number): Position => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low]! + 1 };
  };

  const positions = new Map<string, Position>();
  const duplicates: Duplicate[] = [];
  let pointerCharacters = 0;
  let i = 0;
  const fail = (message: string): never => {
    throw new SyntaxProblem(message);
  };
  const childPointer = (parent: string, key: string | number): string => {
    const name = String(key);
    let length = parent.length + 1 + name.length;
    for (const char of name) if (char === "~" || char === "/") length++;
    if (pointerCharacters + length > JSON_PARSE_LIMITS.pointerCharacters) {
      throw new ResourceProblem("The document exceeds the validator's cumulative JSON-pointer allocation allowance");
    }
    pointerCharacters += length;
    return pointer(parent, name);
  };
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const literal = (word: string, value: unknown) => {
    if (!text.startsWith(word, i)) fail("Unexpected character");
    i += word.length;
    return value;
  };

  const value = (path: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) fail("Nesting too deep");
    space();
    positions.set(path, at(i));
    const char = text[i];
    if (char === "{") return object(path, depth);
    if (char === "[") return array(path, depth);
    if (char === '"') return string();
    if (char === "t") return literal("true", true);
    if (char === "f") return literal("false", false);
    if (char === "n") return literal("null", null);
    if (char === undefined) fail("Unexpected end of input");
    return number();
  };

  const object = (path: string, depth: number) => {
    i++;
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    space();
    if (text[i] === "}") {
      i++;
      return result;
    }
    for (;;) {
      space();
      if (text[i] !== '"') fail("Expected a member name in double quotes");
      const keyStart = i;
      const key = string();
      const child = childPointer(path, key);
      if (seen.has(key)) duplicates.push({ pointer: child, name: key, position: at(keyStart) });
      seen.add(key);
      space();
      if (text[i] !== ":") fail("Expected ':' after a member name");
      i++;
      // `defineProperty`, so a member named `__proto__` is kept as data.
      Object.defineProperty(result, key, {
        value: value(child, depth + 1),
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

  const array = (path: string, depth: number) => {
    i++;
    const result: unknown[] = [];
    space();
    if (text[i] === "]") {
      i++;
      return result;
    }
    for (;;) {
      result.push(value(childPointer(path, result.length), depth + 1));
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
      else if (text.charCodeAt(i) < 0x20) fail("Control character in a string");
      i++;
    }
    if (text[i] !== '"') fail("Unterminated string");
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail("Bad escape in a string");
    }
  };

  const number = (): number => {
    // Sticky, so it matches at `i` without copying the rest of the text, and
    // a number of any length is read whole.
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (!match) fail("Unexpected character");
    i += match![0].length;
    return Number(match![0]);
  };

  try {
    const result = value("", 0);
    space();
    if (i !== text.length) fail("Unexpected characters after the JSON value");
    return { ok: true, value: result, positions, duplicates, bom };
  } catch (error) {
    if (!(error instanceof SyntaxProblem)) throw error;
    return { ok: false, error: error.message, position: at(Math.min(i, text.length)), ...(error instanceof ResourceProblem ? { resourceLimit: true as const } : {}) };
  }
}
