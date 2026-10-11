import { describe, expect, it } from "vitest";
import { authorization, decodeJwt, exchanges, type Har, type HarEntry } from "../../interop/runner/har";
import { compare, interpolate, lookup, ScenarioError } from "../../interop/runner/scenario";
import { gs, jsonValues, property, type Json } from "./hegel";

/**
 * The interop runner's pure parts: scenario `${…}` references and
 * comparisons (interop/runner/scenario.ts), and reading the recording
 * (interop/runner/har.ts). Attribution and known-failure matching live in
 * attribution.ts, which another change is rewriting; they aren't here.
 */

/** Saved results: objects whose member names a reference can spell (no `.`, `{`, `}` or spaces). */
function savedValues(depth = 3): gs.Generator<Json> {
  const name = gs.fromRegex("[A-Za-z_][A-Za-z0-9_-]{0,8}", { fullmatch: true });
  if (depth === 0) return jsonValues(0);
  const inner = savedValues(depth - 1);
  return gs.oneOf<Json>(jsonValues(0), gs.arrays(inner, { maxSize: 4 }), gs.maps(name, inner, { maxSize: 4 }).map((map) => Object.fromEntries(map)));
}

const saved = gs.maps(gs.fromRegex("[A-Za-z_][A-Za-z0-9_-]{0,8}", { fullmatch: true }), savedValues(), { minSize: 1, maxSize: 4 }).map((map) => Object.fromEntries(map) as Record<string, Json>);

/** Every path to a value inside `value`, as a reference spells it, with the value. */
function references(value: Json, at: string[] = []): [string, Json][] {
  const here: [string, Json][] = at.length ? [[at.join("."), value]] : [];
  if (Array.isArray(value)) return [...here, ...value.flatMap((item, index) => references(item, [...at, String(index)]))];
  if (value !== null && typeof value === "object") return [...here, ...Object.entries(value).flatMap(([key, item]) => references(item, [...at, key]))];
  return here;
}

/** A path into `values` and what it names. */
function pathInto(values: Record<string, Json>) {
  const all = references(values);
  return gs.sampledFrom(all);
}

describe("scenario references (interop spec 6)", () => {
  it(
    "lookup finds the value at every path into the saved results",
    property((tc) => {
      const values = tc.draw(saved);
      const [path, value] = tc.draw(pathInto(values));
      expect(lookup(path, values)).toStrictEqual(value);
    })
  );

  it(
    "a string that is exactly one reference becomes the referenced value, whatever its type",
    property((tc) => {
      const values = tc.draw(saved);
      const [path, value] = tc.draw(pathInto(values));
      expect(interpolate(`\${${path}}`, values)).toStrictEqual(value);
    })
  );

  it(
    "a reference inside a longer string is spliced in as text: a string as it is, anything else as JSON",
    property((tc) => {
      const values = tc.draw(saved);
      const [path, value] = tc.draw(pathInto(values));
      const before = tc.draw(gs.text({ maxSize: 10, excludeCharacters: "$" }));
      const after = tc.draw(gs.text({ maxSize: 10, excludeCharacters: "$" }));
      tc.assume(before !== "" || after !== "");
      expect(interpolate(`${before}\${${path}}${after}`, values)).toBe(`${before}${typeof value === "string" ? value : JSON.stringify(value)}${after}`);
    })
  );

  it(
    "leaves a value without references as it was, at any depth",
    property((tc) => {
      const value = tc.draw(jsonValues(4));
      tc.assume(!JSON.stringify(value).includes("${"));
      expect(interpolate(value, tc.draw(saved))).toStrictEqual(value);
    })
  );

  it(
    "refuses, strictly, a reference to nothing",
    property((tc) => {
      const values = tc.draw(saved);
      const missing = tc.draw(gs.fromRegex("[A-Za-z_][A-Za-z0-9_-]{0,8}", { fullmatch: true }));
      tc.assume(!(missing in values));
      const text = tc.draw(gs.booleans()) ? `\${${missing}}` : `x \${${missing}.y}`;
      expect(() => interpolate(text, values)).toThrow(ScenarioError);
    })
  );

  it(
    "compares any value equal to itself",
    property((tc) => {
      const value = tc.draw(jsonValues(4));
      // An object of operators only ({"$in": …}) is an expectation, not a value.
      tc.assume(!(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => key.startsWith("$"))));
      expect(compare(structuredClone(value), value)).toBeNull();
    })
  );

  it(
    "compares two values unequal when they differ",
    property((tc) => {
      const a = tc.draw(jsonValues(3));
      const b = tc.draw(jsonValues(3));
      tc.assume(JSON.stringify(a) !== JSON.stringify(b) && !(b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).some((key) => key.startsWith("$"))));
      // Objects that differ only in member order are equal; JSON text isn't the oracle for those.
      const sorted = (value: Json): Json =>
        Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, sorted(v)])) : value;
      tc.assume(JSON.stringify(sorted(a)) !== JSON.stringify(sorted(b)));
      expect(compare(a, b)).not.toBeNull();
    })
  );
});

describe("reading the recording (interop/runner/har.ts)", () => {
  it(
    "decodes any compact JWS's header and claims, and gives null for anything that isn't one",
    property((tc) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const header = tc.draw(gs.maps(gs.text({ maxSize: 6 }), jsonValues(1), { maxSize: 3 }).map((map) => Object.fromEntries(map)));
      const payload = tc.draw(gs.maps(gs.text({ maxSize: 6 }), jsonValues(2), { maxSize: 4 }).map((map) => Object.fromEntries(map)));
      const signature = Buffer.from(tc.draw(gs.binary({ maxSize: 64 }))).toString("base64url");
      // What the token carries is the JSON text: -0 becomes 0.
      const carried = JSON.parse(JSON.stringify({ header, payload })) as unknown;
      expect(decodeJwt(`${encode(header)}.${encode(payload)}.${signature}`)).toStrictEqual(carried);
      const junk = tc.draw(gs.text({ maxSize: 40 }));
      const decoded = decodeJwt(junk);
      if (decoded !== null) expect(junk.split(".")).toHaveLength(3);
    })
  );

  it(
    "reads the Authorization scheme and token, and joins repeated headers whatever their case",
    property((tc) => {
      const scheme = tc.draw(gs.sampledFrom(["DPoP", "Bearer", "Basic"]));
      const token = tc.draw(gs.fromRegex("[A-Za-z0-9._~+/-]{1,40}=*", { fullmatch: true }));
      const extra = tc.draw(gs.arrays(gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789", minSize: 1, maxSize: 8 }), { maxSize: 3 }));
      const spell = (name: string) => [...name].map((char) => (tc.draw(gs.booleans()) ? char.toUpperCase() : char)).join("");
      const entry: HarEntry = {
        startedDateTime: new Date(tc.draw(gs.integers({ minValue: 0, maxValue: 4_000_000_000_000 }))).toISOString(),
        time: tc.draw(gs.integers({ minValue: 0, maxValue: 100_000 })),
        request: {
          method: "GET",
          url: "https://api.shop.company.interop.test/x",
          headers: [{ name: spell("authorization"), value: `${scheme} ${token}` }, ...extra.map((value) => ({ name: spell("x-extra"), value }))]
        },
        response: { status: 200, headers: [], content: { mimeType: "application/json" } }
      };
      const [exchange] = exchanges({ log: { entries: [entry] } } satisfies Har);
      expect(authorization(exchange!)).toEqual({ scheme, token });
      expect(exchange!.requestHeaders.get("x-extra")).toBe(extra.length ? extra.join(", ") : undefined);
      expect(exchange!.direction).toBe("to-company");
      expect(exchange!.ended - exchange!.started).toBe(entry.time);
    })
  );
});
