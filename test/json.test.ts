import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JsonError, parseStrictJson } from "../src/poppy/json";
import { parseJson } from "../src/validator/json";

/**
 * The two strict JSON parsers: the client's (`src/poppy/json.ts`), which
 * throws on a duplicate member name, and the validator's
 * (`src/validator/json.ts`), which records it with a pointer and position.
 * `JSON.parse` is the oracle for everything else. Fixed seed, so a failure
 * reproduces; fast-check prints the shrunk counterexample.
 */
const RUNS = { seed: 42, numRuns: 500 } as const;

/** JSON values, kept well inside both parsers' nesting limit of 64. */
const jsonValue = fc.jsonValue({ maxDepth: 6 });

/** The ways a document can be laid out; JSON allows only space, tab, LF and CR. */
const layouts: ReadonlyArray<(value: unknown) => string> = [
  (value) => JSON.stringify(value),
  (value) => JSON.stringify(value, null, 2),
  (value) => JSON.stringify(value, null, "\t"),
  (value) => ` \r\n${JSON.stringify(value, null, 1).replace(/\n/g, "\r\n")}\t `
];
const layout = fc.constantFrom(...layouts);

/** JSON.parse's answer, or `undefined` for invalid JSON. */
function oracle(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** The client parser's answer, or `undefined` if it threw a JsonError; anything else is rethrown. */
function strict(text: string): { value: unknown } | undefined {
  try {
    return { value: parseStrictJson(text) };
  } catch (error) {
    if (error instanceof JsonError) return undefined;
    throw error;
  }
}

/** Every JSON Pointer in a value, as the validator's parser records them. */
function pointers(value: unknown, at = ""): string[] {
  const children =
    Array.isArray(value)
      ? value.flatMap((item, index) => pointers(item, `${at}/${index}`))
      : typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, item]) => pointers(item, `${at}/${escape(key)}`))
        : [];
  return [at, ...children];
}

/** RFC 6901, written out here rather than imported from the parser under test. */
function escape(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

function resolve(value: unknown, at: string): unknown {
  if (at === "") return value;
  return at
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((parent, key) => (parent as Record<string, unknown>)[key], value);
}

/** How a value's text begins. */
function firstCharacter(value: unknown): string {
  return JSON.stringify(value)[0]!;
}

/** 1-based line and column of an offset, counting LF as the line break. */
function lineColumn(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/** A valid document with one edit: a character deleted, inserted or replaced. */
const edited = fc
  .tuple(
    jsonValue,
    layout,
    fc.nat(),
    fc.constantFrom("delete", "insert", "replace"),
    fc.oneof(
      fc.constantFrom(..."{}[],:\"\\ \t\n0123456789-+.eEtrufalsn/"),
      fc.string({ unit: "binary", minLength: 1, maxLength: 1 })
    )
  )
  .map(([value, format, at, edit, char]) => {
    const text = format(value);
    const i = at % (text.length + 1);
    if (edit === "insert") return text.slice(0, i) + char + text.slice(i);
    if (edit === "delete") return text.slice(0, i) + text.slice(i + 1);
    return text.slice(0, i) + char + text.slice(i + 1);
  })
  // A BOM is the one prefix the validator accepts and JSON.parse doesn't; it has its own test.
  .filter((text) => !text.startsWith("\uFEFF"));

/**
 * Short runs of JSON tokens and near-misses: trailing commas, leading zeros,
 * whitespace JSON doesn't allow, half-written literals.
 */
const tokens = fc
  .array(
    fc.constantFrom(
      "{", "}", "[", "]", ",", ":", '"a"', '"b"', '"\\u0061"', '"\\x"', "0", "-0", "01", "1.", ".5", "1e", "1e+2",
      "-", "+1", "true", "tru", "null", "nul", "false", " ", "\t", "\n", "\r", "\f", "\v", " ", " "
    ),
    { maxLength: 12 }
  )
  .map((parts) => parts.join(""));

/** Anything at all: random code points (lone surrogates included) and decoded random bytes. */
const garbage = fc.oneof(
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ unit: fc.constantFrom(..."{}[],:\"\\ 01-.eEtrufalsn"), maxLength: 200 }),
  fc.uint8Array({ maxLength: 200 }).map((bytes) => new TextDecoder().decode(bytes)),
  fc.uint8Array({ maxLength: 200 }).map((bytes) => String.fromCharCode(...bytes))
);

/**
 * A document with exactly one duplicate member name, inside an object found
 * at `path` (member names and array indices). Returns the text, and the
 * pointer and offset of the duplicate's name.
 */
const duplicated = fc
  .record({
    path: fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.nat({ max: 3 })), { maxLength: 4 }),
    members: fc.uniqueArray(fc.tuple(fc.string({ maxLength: 8 }), jsonValue), {
      minLength: 1,
      maxLength: 5,
      selector: ([name]) => name
    }),
    which: fc.nat(),
    again: jsonValue,
    pretty: fc.boolean()
  })
  .map(({ path, members, which, again, pretty }) => {
    const sep = pretty ? "\n  " : "";
    let prefix = "";
    let suffix = "";
    for (const segment of path) {
      if (typeof segment === "string") {
        prefix += `{${sep}${JSON.stringify(segment)}:${sep}`;
        suffix = `${sep}}${suffix}`;
      } else {
        prefix += `[${`null,${sep}`.repeat(segment)}`;
        suffix = `]${suffix}`;
      }
    }
    const name = members[which % members.length]![0];
    const body = members.map(([key, value]) => `${JSON.stringify(key)}:${sep}${JSON.stringify(value)}`);
    const before = `${prefix}{${sep}${body.join(`,${sep}`)},${sep}`;
    const text = `${before}${JSON.stringify(name)}:${JSON.stringify(again)}${sep}}${suffix}`;
    return {
      text,
      name,
      pointer: [...path, name].map((segment) => `/${escape(segment)}`).join(""),
      offset: before.length
    };
  });

describe("both JSON parsers agree with JSON.parse", () => {
  it("parse every valid document, in any layout, to what JSON.parse gives", () => {
    fc.assert(
      fc.property(jsonValue, layout, (value, format) => {
        const text = format(value);
        const expected = JSON.parse(text);
        expect(parseStrictJson(text)).toStrictEqual(expected);
        const parsed = parseJson(text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value).toStrictEqual(expected);
        expect(parsed.duplicates).toEqual([]);
        expect(parsed.bom).toBe(false);
        // A position for every value, and nothing else, each at the value's first character.
        expect([...parsed.positions.keys()].sort()).toEqual(pointers(expected).sort());
        const lines = text.split("\n");
        for (const [at, { line, column }] of parsed.positions) {
          const first = lines[line - 1]![column - 1];
          expect(first, at).toBe(firstCharacter(resolve(expected, at)));
        }
      }),
      RUNS
    );
  });

  it("accept an edited document or a run of tokens exactly when JSON.parse does, unless it repeats a name", () => {
    fc.assert(
      fc.property(fc.oneof(edited, tokens), (text) => {
        const expected = oracle(text);
        const client = strict(text);
        const validator = parseJson(text);
        if (expected === undefined) {
          expect(client).toBeUndefined();
          expect(validator.ok).toBe(false);
          return;
        }
        expect(validator.ok).toBe(true);
        if (!validator.ok) return;
        // JSON.parse keeps the last of two equal names, and so does the validator, which records it.
        expect(validator.value).toStrictEqual(expected.value);
        if (validator.duplicates.length > 0) expect(client).toBeUndefined();
        else expect(client).toStrictEqual(expected);
      }),
      RUNS
    );
  });

  it("accept a number of any length, as JSON.parse does", () => {
    for (const text of [
      "1" + "0".repeat(500),
      "0." + "1".repeat(1000),
      "-" + "9".repeat(401) + ".5e-3",
      `[1, ${"2".repeat(450)}, 3]`,
      `{"long": ${"7".repeat(400)}.${"7".repeat(400)}}`
    ]) {
      const expected = JSON.parse(text);
      expect(parseStrictJson(text)).toStrictEqual(expected);
      const parsed = parseJson(text);
      expect(parsed, text.slice(0, 40)).toMatchObject({ ok: true, value: expected });
    }
  });
});

describe("duplicate member names", () => {
  it("are refused by the client parser and recorded, with pointer and position, by the validator's", () => {
    fc.assert(
      fc.property(duplicated, ({ text, name, pointer, offset }) => {
        expect(() => parseStrictJson(text)).toThrow(JsonError);
        expect(() => parseStrictJson(text)).toThrow(/Duplicate member name/);
        const parsed = parseJson(text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.duplicates).toEqual([{ pointer, name, position: lineColumn(text, offset) }]);
      }),
      RUNS
    );
  });

  it("make the client parser throw, at any depth", () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(new JsonError('Duplicate member name "a" at position 10'));
    expect(() => parseStrictJson('{"a":1,"b":{"c":[{"d":true,"d":true}]}}')).toThrow(/Duplicate member name "d"/);
    // Equal after unescaping is equal.
    expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow(/Duplicate member name "a"/);
    expect(parseStrictJson('{"a":1,"b":{"a":2}}')).toEqual({ a: 1, b: { a: 2 } });
  });

  it("keep __proto__ as a plain member in both parsers", () => {
    const text = '{"__proto__":{"polluted":true}}';
    const client = parseStrictJson(text) as Record<string, unknown>;
    expect(Object.getPrototypeOf(client)).toBe(Object.prototype);
    expect(Object.keys(client)).toEqual(["__proto__"]);
    const parsed = parseJson(text);
    expect(parsed.ok && Object.keys(parsed.value as object)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("malformed input", () => {
  it("only ever makes the client parser throw a JsonError, and the validator's return ok: false", () => {
    fc.assert(
      fc.property(garbage, (text) => {
        const expected = oracle(text);
        const client = strict(text); // rethrows anything but a JsonError
        const parsed = parseJson(text); // must not throw at all
        if (parsed.ok) {
          // Only a BOM separates what the validator accepts from JSON.parse.
          expect(oracle(parsed.bom ? text.slice(1) : text)).toBeDefined();
          return;
        }
        expect(expected).toBeUndefined();
        expect(client).toBeUndefined();
        // Positions count from after a BOM.
        const lines = text.replace(/^﻿/, "").split("\n");
        expect(parsed.position.line).toBeGreaterThanOrEqual(1);
        expect(parsed.position.line).toBeLessThanOrEqual(lines.length);
        expect(parsed.position.column).toBeGreaterThanOrEqual(1);
        expect(parsed.position.column).toBeLessThanOrEqual(lines[parsed.position.line - 1]!.length + 1);
      }),
      RUNS
    );
  });

  it("refuses what JSON.parse refuses that other parsers often allow", () => {
    for (const text of [
      "", " ", "01", "-01", "+1", ".5", "1.", "1e", "0x10", "NaN", "Infinity", "-", "tru", "nul",
      "[1,]", '{"a":1,}', "[,1]", '{,"a":1}', "{'a':1}", '{a:1}', '"\\x"', '"\t"', '"abc', "[1 2]",
      "\f1", "1\f", "\v1", "[ ]", "  1", "1 // comment", "/* c */ 1", "[1]]", "{}{}"
    ]) {
      expect(oracle(text), JSON.stringify(text)).toBeUndefined();
      expect(() => parseStrictJson(text), JSON.stringify(text)).toThrow(JsonError);
      expect(parseJson(text).ok, JSON.stringify(text)).toBe(false);
    }
  });

  it("refuses a value nested more than 64 deep without overflowing the stack", () => {
    for (const text of ["[".repeat(100_000), `${"[".repeat(65)}1${"]".repeat(65)}`, `${'{"a":'.repeat(65)}1${"}".repeat(65)}`]) {
      expect(() => parseStrictJson(text)).toThrow(/Nesting too deep/);
      expect(parseJson(text)).toMatchObject({ ok: false, error: "Nesting too deep" });
    }
    for (const deepest of [`${"[".repeat(64)}1${"]".repeat(64)}`, `${'{"a":'.repeat(64)}1${"}".repeat(64)}`]) {
      expect(parseStrictJson(deepest)).toEqual(JSON.parse(deepest));
      expect(parseJson(deepest)).toMatchObject({ ok: true, value: JSON.parse(deepest) });
    }
  });

  it("strips and records a byte order mark in the validator only", () => {
    const text = '\uFEFF{"a":1}';
    expect(parseJson(text)).toMatchObject({ ok: true, bom: true, value: { a: 1 } });
    expect(() => parseStrictJson(text)).toThrow(JsonError);
  });
});
