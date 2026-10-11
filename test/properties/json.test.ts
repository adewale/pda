import { describe, expect, it } from "vitest";
import { JsonError, parseStrictJson } from "../../src/poppy/json";
import { parseJson } from "../../src/validator/json";
import { gs, jsonValues, property, type Json } from "./hegel";

/**
 * The two strict JSON parsers: the client's (`src/poppy/json.ts`), which
 * throws on a duplicate member name, and the validator's
 * (`src/validator/json.ts`), which records it with a pointer and position.
 * `JSON.parse` is the oracle for everything else. Hegel prints the shrunk
 * counterexample of a failure.
 */

/** The ways a document can be laid out; JSON allows only space, tab, LF and CR. */
const layouts: ReadonlyArray<(value: unknown) => string> = [
  (value) => JSON.stringify(value),
  (value) => JSON.stringify(value, null, 2),
  (value) => JSON.stringify(value, null, "\t"),
  (value) => ` \r\n${JSON.stringify(value, null, 1).replace(/\n/g, "\r\n")}\t `
];

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

/** RFC 6901, written out here rather than imported from the parser under test. */
function escape(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Every JSON Pointer in a value, as the validator's parser records them. */
function pointers(value: unknown, at = ""): string[] {
  const children = Array.isArray(value)
    ? value.flatMap((item, index) => pointers(item, `${at}/${index}`))
    : typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, item]) => pointers(item, `${at}/${escape(key)}`))
      : [];
  return [at, ...children];
}

function resolve(value: unknown, at: string): unknown {
  if (at === "") return value;
  return at
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((parent, key) => (parent as Record<string, unknown>)[key], value);
}

/** 1-based line and column of an offset, counting LF as the line break. */
function lineColumn(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/** One character: JSON's own punctuation and literals, or any code unit at all. */
const oneCharacter = gs.oneOf(gs.sampledFrom([..."{}[],:\"\\ \t\n0123456789-+.eEtrufalsn/"]), gs.characters());

/** A valid document with one edit: a character deleted, inserted or replaced. */
const edited = gs.composite((tc) => {
  const text = tc.draw(gs.sampledFrom(layouts))(tc.draw(jsonValues()));
  const i = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
  const edit = tc.draw(gs.sampledFrom(["delete", "insert", "replace"] as const));
  const char = tc.draw(oneCharacter);
  if (edit === "insert") return text.slice(0, i) + char + text.slice(i);
  if (edit === "delete") return text.slice(0, i) + text.slice(i + 1);
  return text.slice(0, i) + char + text.slice(i + 1);
});

/**
 * Short runs of JSON tokens and near-misses: trailing commas, leading zeros,
 * whitespace JSON doesn't allow, half-written literals.
 */
const tokens = gs
  .arrays(
    gs.sampledFrom([
      "{", "}", "[", "]", ",", ":", '"a"', '"b"', '"\\u0061"', '"\\x"', "0", "-0", "01", "1.", ".5", "1e", "1e+2",
      "-", "+1", "true", "tru", "null", "nul", "false", " ", "\t", "\n", "\r", "\f", "\v", "\u00a0", "\u2028"
    ]),
    { maxSize: 12 }
  )
  .map((parts) => parts.join(""));

/** Anything at all: any string (lone surrogates included), JSON's alphabet, decoded random bytes. */
const garbage = gs.oneOf(
  gs.text({ maxSize: 200 }),
  gs.text({ alphabet: "{}[],:\"\\ 01-.eEtrufalsn", maxSize: 200 }),
  gs.binary({ maxSize: 200 }).map((bytes) => new TextDecoder().decode(bytes)),
  gs.binary({ maxSize: 200 }).map((bytes) => String.fromCharCode(...bytes))
);

/**
 * A document with exactly one duplicate member name, inside an object found
 * at `path` (member names and array indices). Returns the text, and the
 * pointer and offset of the duplicate's name.
 */
const duplicated = gs.composite((tc) => {
  const path = tc.draw(gs.arrays(gs.oneOf<string | number>(gs.text({ maxSize: 8 }), gs.integers({ minValue: 0, maxValue: 3 })), { maxSize: 4 }));
  const members = [...tc.draw(gs.maps(gs.text({ maxSize: 8 }), jsonValues(), { minSize: 1, maxSize: 5 }))];
  const name = members[tc.draw(gs.integers({ minValue: 0, maxValue: members.length - 1 }))]![0];
  const again = tc.draw(jsonValues());
  const sep = tc.draw(gs.booleans()) ? "\n  " : "";
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
  it(
    "the client's parses every valid document, in any layout, to what JSON.parse gives",
    property((tc) => {
      const text = tc.draw(gs.sampledFrom(layouts))(tc.draw(jsonValues()));
      expect(parseStrictJson(text)).toStrictEqual(JSON.parse(text));
    })
  );

  it(
    "the validator's parses every valid document, in any layout, to what JSON.parse gives, with no duplicates or BOM",
    property((tc) => {
      const text = tc.draw(gs.sampledFrom(layouts))(tc.draw(jsonValues()));
      expect(parseJson(text)).toMatchObject({ ok: true, value: JSON.parse(text), duplicates: [], bom: false });
    })
  );

  it(
    "the validator's records a position for every value, and nothing else, each at the value's first character",
    property((tc) => {
      const text = tc.draw(gs.sampledFrom(layouts))(tc.draw(jsonValues()));
      const expected = JSON.parse(text) as Json;
      const parsed = parseJson(text);
      if (!parsed.ok) throw new Error(`refused a valid document: ${parsed.error}`);
      expect([...parsed.positions.keys()].sort()).toEqual(pointers(expected).sort());
      const lines = text.split("\n");
      for (const [at, { line, column }] of parsed.positions) {
        expect(lines[line - 1]![column - 1], at).toBe(JSON.stringify(resolve(expected, at))[0]);
      }
    })
  );

  it(
    "the client's accepts an edited document or a run of tokens exactly when JSON.parse does and no name repeats",
    property((tc) => {
      const text = tc.draw(gs.oneOf(edited, tokens));
      const expected = oracle(text);
      const validator = parseJson(text);
      // Whether a name repeats is the validator's to say; its own property, below, checks it.
      const repeats = validator.ok && validator.duplicates.length > 0;
      expect(strict(text)).toStrictEqual(expected === undefined || repeats ? undefined : expected);
    })
  );

  it(
    "the validator's accepts an edited document or a run of tokens exactly when JSON.parse does, to the same value",
    property((tc) => {
      const text = tc.draw(gs.oneOf(edited, tokens));
      // A BOM is the one prefix the validator accepts and JSON.parse doesn't; it has its own test.
      tc.assume(!text.startsWith("\uFEFF"));
      const expected = oracle(text);
      const validator = parseJson(text);
      // JSON.parse keeps the last of two equal names, and so does the validator, which records it.
      expect(validator.ok ? { value: validator.value } : undefined).toStrictEqual(expected);
    })
  );

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
      expect(parseJson(text), text.slice(0, 40)).toMatchObject({ ok: true, value: expected });
    }
  });
});

describe("duplicate member names", () => {
  it(
    "are refused by the client parser, which names the duplicate",
    property((tc) => {
      const { text, name } = tc.draw(duplicated);
      expect(() => parseStrictJson(text)).toThrow(new RegExp(`^Duplicate member name ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} at position \\d+$`));
      expect(() => parseStrictJson(text)).toThrow(JsonError);
    })
  );

  it(
    "are recorded, with pointer and position, by the validator's",
    property((tc) => {
      const { text, name, pointer, offset } = tc.draw(duplicated);
      expect(parseJson(text)).toMatchObject({ ok: true, duplicates: [{ pointer, name, position: lineColumn(text, offset) }] });
    })
  );

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
  it(
    "makes the client parser throw only a JsonError, exactly when JSON.parse refuses or a name repeats",
    property((tc) => {
      const text = tc.draw(garbage);
      const expected = oracle(text);
      const validator = parseJson(text);
      const repeats = validator.ok && validator.duplicates.length > 0;
      // strict() rethrows anything but a JsonError.
      expect(strict(text)).toStrictEqual(expected === undefined || repeats ? undefined : expected);
    })
  );

  it(
    "makes the validator's return ok: false, never throw, exactly when JSON.parse refuses it (after any BOM)",
    property((tc) => {
      const text = tc.draw(garbage);
      const parsed = parseJson(text);
      const unmarked = parsed.ok && parsed.bom ? text.slice(1) : text;
      expect(parsed.ok).toBe(oracle(unmarked) !== undefined);
    })
  );

  it(
    "puts the validator's refusal at a line and column inside the text, counted after any BOM",
    property((tc) => {
      const text = tc.draw(garbage);
      const parsed = parseJson(text);
      tc.assume(!parsed.ok);
      if (parsed.ok) return;
      const lines = text.replace(/^\uFEFF/, "").split("\n");
      expect(parsed.position.line).toBeGreaterThanOrEqual(1);
      expect(parsed.position.line).toBeLessThanOrEqual(lines.length);
      expect(parsed.position.column).toBeGreaterThanOrEqual(1);
      expect(parsed.position.column).toBeLessThanOrEqual(lines[parsed.position.line - 1]!.length + 1);
    })
  );

  it("refuses what JSON.parse refuses that other parsers often allow", () => {
    for (const text of [
      "", " ", "01", "-01", "+1", ".5", "1.", "1e", "0x10", "NaN", "Infinity", "-", "tru", "nul",
      "[1,]", '{"a":1,}', "[,1]", '{,"a":1}', "{'a':1}", "{a:1}", '"\\x"', '"\t"', '"abc', "[1 2]",
      "\f1", "1\f", "\v1", "[\u00a0]", "\u2028 1", "1 // comment", "/* c */ 1", "[1]]", "{}{}"
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
