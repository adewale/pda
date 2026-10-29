import type { Json } from "./poppy/json";

/**
 * Decoders for data that crosses a boundary into typed code: rows read back
 * from SQLite, approvals stored before a deploy, a Company's token response,
 * frames from the server. Each says what it expects, and a value that
 * doesn't match throws a `DecodeError` naming where, rather than flowing on
 * as a type it isn't. No dependency: a decoder is a function.
 */
export class DecodeError extends Error {
  override name = "DecodeError";
}

export type Decoder<T> = (value: unknown, at: string) => T;

/** What a decoder makes. */
export type Decoded<D> = D extends Decoder<infer T> ? T : never;

function shown(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return value.length > 40 ? "a long string" : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "object" ? "an object" : typeof value;
}

function fail(at: string, expected: string, value: unknown): never {
  throw new DecodeError(`${at || "the value"}: expected ${expected}, got ${shown(value)}`);
}

export const string: Decoder<string> = (value, at) => (typeof value === "string" ? value : fail(at, "a string", value));

/** A finite number. */
export const number: Decoder<number> = (value, at) => (typeof value === "number" && Number.isFinite(value) ? value : fail(at, "a number", value));

export const integer: Decoder<number> = (value, at) => (Number.isInteger(value) ? (value as number) : fail(at, "a whole number", value));

export const boolean: Decoder<boolean> = (value, at) => (typeof value === "boolean" ? value : fail(at, "true or false", value));

/** SQLite's 0 or 1 for a flag, as stored. */
export const flag: Decoder<0 | 1> = (value, at) => (value === 0 || value === 1 ? value : fail(at, "0 or 1", value));

/** Any JSON value: null, a boolean, a finite number, a string, or arrays and plain objects of them. */
export const json: Decoder<Json> = (value, at) => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fail(at, "JSON", value);
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${at}[${index}]`));
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out: { [key: string]: Json } = {};
    for (const [key, member] of Object.entries(value as object)) {
      Object.defineProperty(out, key, { value: json(member, `${at}.${key}`), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return fail(at, "JSON", value);
};

/** A JSON text, as a TEXT column holds one, whose parsed value passes `decoder`. */
export function jsonText<T>(decoder: Decoder<T>): Decoder<T> {
  return (value, at) => {
    if (typeof value !== "string") return fail(at, "JSON text", value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return fail(at, "JSON text", value);
    }
    return decoder(parsed, at);
  };
}

export function literal<const T extends readonly (string | number | boolean | null)[]>(...values: T): Decoder<T[number]> {
  return (value, at) => (values.includes(value as T[number]) ? (value as T[number]) : fail(at, values.map((item) => JSON.stringify(item)).join(" or "), value));
}

export function nullable<T>(decoder: Decoder<T>): Decoder<T | null> {
  return (value, at) => (value === null ? null : decoder(value, at));
}

const OPTIONAL = Symbol("optional");
/** A member an object may leave out (or give as `undefined`); left out of what `object` makes. */
export type Optional<T> = Decoder<T | undefined> & { readonly [OPTIONAL]: true };

export function optional<T>(decoder: Decoder<T>): Optional<T> {
  const optionalDecoder = (value: unknown, at: string) => (value === undefined ? undefined : decoder(value, at));
  return Object.assign(optionalDecoder, { [OPTIONAL]: true as const });
}

export function array<T>(decoder: Decoder<T>): Decoder<readonly T[]> {
  return (value, at) => (Array.isArray(value) ? value.map((item, index) => decoder(item, `${at}[${index}]`)) : fail(at, "an array", value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object's own members, each decoded the same way. */
export function record<T>(decoder: Decoder<T>): Decoder<Record<string, T>> {
  return (value, at) => {
    if (!isPlainObject(value)) return fail(at, "an object", value);
    const out: Record<string, T> = {};
    for (const [key, member] of Object.entries(value)) {
      Object.defineProperty(out, key, { value: decoder(member, `${at}.${key}`), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
}

type Shape = Record<string, Decoder<unknown>>;
type RequiredOf<S extends Shape> = { readonly [K in keyof S as S[K] extends Optional<unknown> ? never : K]: Decoded<S[K]> };
type OptionalOf<S extends Shape> = { readonly [K in keyof S as S[K] extends Optional<unknown> ? K : never]?: Exclude<Decoded<S[K]>, undefined> };
export type ObjectOf<S extends Shape> = { [K in keyof (RequiredOf<S> & OptionalOf<S>)]: (RequiredOf<S> & OptionalOf<S>)[K] };

/**
 * An object with these members. Only the members named are kept, so a
 * decoded value has exactly its type's keys; others are ignored.
 */
export function object<S extends Shape>(shape: S): Decoder<ObjectOf<S>> {
  return (value, at) => {
    if (!isPlainObject(value)) return fail(at, "an object", value);
    const out: Record<string, unknown> = {};
    for (const [key, decoder] of Object.entries(shape)) {
      const member = decoder(Object.hasOwn(value, key) ? value[key] : undefined, `${at}.${key}`);
      if (member !== undefined) out[key] = member;
    }
    return out as ObjectOf<S>;
  };
}

/** One of several shapes, told apart by the string in `key`. */
export function tagged<K extends string, M extends Record<string, Decoder<unknown>>>(key: K, members: M): Decoder<Decoded<M[keyof M]>> {
  return (value, at) => {
    if (!isPlainObject(value)) return fail(at, "an object", value);
    const tag = value[key];
    if (typeof tag !== "string" || !Object.hasOwn(members, tag)) return fail(`${at}.${key}`, Object.keys(members).map((name) => JSON.stringify(name)).join(" or "), tag);
    return members[tag]!(value, at) as Decoded<M[keyof M]>;
  };
}

/** A value decoded, or why not, for a caller that refuses rather than throws. */
export function tryDecode<T>(decoder: Decoder<T>, value: unknown, what: string): { ok: true; value: T } | { ok: false; problem: string } {
  try {
    return { ok: true, value: decoder(value, what) };
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, problem: error.message };
    throw error;
  }
}
