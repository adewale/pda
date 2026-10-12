/**
 * The `calculate` tool's arithmetic: a recursive-descent parser over a small
 * grammar, evaluated with exact rational numbers (BigInt numerator and
 * denominator), so `0.1 + 0.2` is `0.3` and sums of money come out to the
 * cent. Only `sqrt`, a power with a fractional exponent and an answer that
 * doesn't end in decimal are approximate, and the result says so. No `eval`,
 * no `Function`: the input is only ever read as this grammar.
 *
 *   expression := term (("+" | "-") term)*
 *   term       := unary (("*" | "/" | "mod") unary)*
 *   unary      := ("-" | "+") unary | power
 *   power      := postfix ("^" unary)?          right-associative; -2^2 is -4
 *   postfix    := primary "%"*                   50% is 0.5
 *   primary    := number | "(" expression ")" | name "(" arguments ")" | "pi" | "e"
 *
 * `×`, `÷` and `−` are read as `*`, `/` and `-`; `**` as `^`; currency signs
 * and thin spaces are skipped. Pure: no Worker APIs, so the property tests
 * run it in Node.
 */

/** Longest expression, in characters. */
export const MAX_EXPRESSION = 500;
/** Deepest nesting of parentheses, calls and unary signs. */
export const MAX_DEPTH = 50;
/** Largest numerator or denominator, in bits (about 1,200 decimal digits). */
const MAX_BITS = 4000;
/** Largest integer exponent. */
const MAX_EXPONENT = 1000;
/** Significant digits in an approximate answer. */
export const APPROXIMATE_DIGITS = 15;
/** Most decimal places shown for an exact answer before it is rounded. */
const MAX_PLACES = 20;

/** A refusal or a mistake in the expression, worded for the model. */
export class CalcError extends Error {
  override name = "CalcError";
}

/** A rational number n/d with d > 0, in lowest terms, and whether it is exact. */
type Q = { readonly n: bigint; readonly d: bigint; readonly exact: boolean };

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function bits(x: bigint): number {
  return abs(x).toString(2).length;
}

function q(n: bigint, d: bigint = 1n, exact = true): Q {
  if (d === 0n) throw new CalcError("Division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  if (g > 1n) {
    n /= g;
    d /= g;
  }
  if (bits(n) > MAX_BITS || bits(d) > MAX_BITS) throw new CalcError("A number in the calculation is too large");
  return { n, d, exact };
}

const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d, a.exact && b.exact);
const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d, a.exact && b.exact);
const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d, a.exact && b.exact);
function div(a: Q, b: Q): Q {
  if (b.n === 0n) throw new CalcError("Division by zero");
  return q(a.n * b.d, a.d * b.n, a.exact && b.exact);
}
const compare = (a: Q, b: Q) => {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
};

/** The largest integer not above x. */
function floorInt(x: Q): bigint {
  const t = x.n / x.d;
  return x.n < 0n && t * x.d !== x.n ? t - 1n : t;
}

/** Remainder with the sign of the divisor, as in most calculators: -7 mod 3 is 2. */
function mod(a: Q, b: Q): Q {
  if (b.n === 0n) throw new CalcError("Division by zero (mod 0)");
  return sub(a, mul(b, q(floorInt(div(a, b)))));
}

/** A double, as the exact rational it is in decimal, marked approximate. */
function fromFloat(x: number): Q {
  if (!Number.isFinite(x)) throw new CalcError(Number.isNaN(x) ? "The result isn't a number" : "A number in the calculation is too large");
  const parsed = parseDecimal(String(x));
  return { ...parsed, exact: false };
}

function toFloat(x: Q): number {
  // Scale so the division keeps 20 significant digits even for huge n and d.
  const shift = Math.max(0, bits(x.d) - 60);
  const scaledN = shift > 0 ? x.n >> BigInt(shift) : x.n;
  const scaledD = shift > 0 ? x.d >> BigInt(shift) : x.d;
  return Number(scaledN) / Number(scaledD);
}

/** A decimal literal (`12`, `0.5`, `.5`, `1.5e3`) as an exact rational. */
function parseDecimal(text: string): Q {
  const match = /^([+-])?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) throw new CalcError(`${text} isn't a number`);
  const whole = match[2] ?? "";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (Math.abs(exponent) > MAX_EXPONENT) throw new CalcError(`${text} is too large or too small`);
  let n = BigInt(`${whole}${fraction}` || "0");
  if (match[1] === "-") n = -n;
  const scale = exponent - fraction.length;
  return scale >= 0 ? q(n * 10n ** BigInt(scale)) : q(n, 10n ** BigInt(-scale));
}

// ---------------------------------------------------------------- Tokens

type Token =
  | { readonly kind: "number"; readonly text: string; readonly at: number }
  | { readonly kind: "name"; readonly text: string; readonly at: number }
  | { readonly kind: "op"; readonly text: "+" | "-" | "*" | "/" | "^" | "%" | "(" | ")" | ","; readonly at: number };

const SKIPPED = /[\s   $£€¥_]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (SKIPPED.test(char)) {
      i++;
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) {
      tokens.push({ kind: "number", text: number[0], at: i });
      i += number[0].length;
      continue;
    }
    const name = /^[a-zA-Z]+/.exec(source.slice(i));
    if (name) {
      tokens.push({ kind: "name", text: name[0].toLowerCase(), at: i });
      i += name[0].length;
      continue;
    }
    if (source.startsWith("**", i)) {
      tokens.push({ kind: "op", text: "^", at: i });
      i += 2;
      continue;
    }
    const op = ({ "+": "+", "-": "-", "−": "-", "*": "*", "×": "*", "⋅": "*", "/": "/", "÷": "/", "^": "^", "%": "%", "(": "(", ")": ")", ",": "," } as const)[
      char as "+"
    ];
    if (!op) throw new CalcError(`Unexpected ${JSON.stringify(char)} at position ${i + 1}`);
    tokens.push({ kind: "op", text: op, at: i });
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------- Parser and evaluator

const FUNCTIONS = ["round", "floor", "ceil", "min", "max", "sqrt", "abs"] as const;
type FunctionName = (typeof FUNCTIONS)[number];

class Parser {
  #tokens: Token[];
  #at = 0;
  #depth = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#at];
  }

  #isOp(text: string): boolean {
    const token = this.#peek();
    return token?.kind === "op" && token.text === text;
  }

  #expect(text: string): void {
    if (!this.#isOp(text)) throw new CalcError(`Expected ${JSON.stringify(text)} ${this.#where()}`);
    this.#at++;
  }

  #where(): string {
    const token = this.#peek();
    return token ? `at position ${token.at + 1}` : "at the end";
  }

  #nest<T>(run: () => T): T {
    if (++this.#depth > MAX_DEPTH) throw new CalcError(`The expression is nested more than ${MAX_DEPTH} deep`);
    try {
      return run();
    } finally {
      this.#depth--;
    }
  }

  parse(): Q {
    if (this.#tokens.length === 0) throw new CalcError("The expression is empty");
    const value = this.#expression();
    if (this.#peek()) throw new CalcError(`Unexpected ${JSON.stringify(this.#peek()!.text)} ${this.#where()}`);
    return value;
  }

  #expression(): Q {
    let value = this.#term();
    for (;;) {
      if (this.#isOp("+")) {
        this.#at++;
        value = add(value, this.#term());
      } else if (this.#isOp("-")) {
        this.#at++;
        value = sub(value, this.#term());
      } else return value;
    }
  }

  #term(): Q {
    let value = this.#unary();
    for (;;) {
      const token = this.#peek();
      if (this.#isOp("*")) {
        this.#at++;
        value = mul(value, this.#unary());
      } else if (this.#isOp("/")) {
        this.#at++;
        value = div(value, this.#unary());
      } else if (token?.kind === "name" && token.text === "mod") {
        this.#at++;
        value = mod(value, this.#unary());
      } else return value;
    }
  }

  #unary(): Q {
    return this.#nest(() => {
      if (this.#isOp("-")) {
        this.#at++;
        const value = this.#unary();
        return q(-value.n, value.d, value.exact);
      }
      if (this.#isOp("+")) {
        this.#at++;
        return this.#unary();
      }
      return this.#power();
    });
  }

  #power(): Q {
    const base = this.#postfix();
    if (!this.#isOp("^")) return base;
    this.#at++;
    return power(base, this.#unary());
  }

  #postfix(): Q {
    let value = this.#primary();
    while (this.#isOp("%")) {
      this.#at++;
      value = div(value, q(100n));
    }
    return value;
  }

  #primary(): Q {
    const token = this.#peek();
    if (!token) throw new CalcError("The expression ends too soon");
    if (token.kind === "number") {
      this.#at++;
      return parseDecimal(token.text);
    }
    if (token.kind === "op" && token.text === "(") {
      this.#at++;
      const value = this.#nest(() => this.#expression());
      this.#expect(")");
      return value;
    }
    if (token.kind === "name") {
      this.#at++;
      if (token.text === "pi") return fromFloat(Math.PI);
      if (token.text === "e") return fromFloat(Math.E);
      if (!(FUNCTIONS as readonly string[]).includes(token.text)) {
        throw new CalcError(`Unknown name ${JSON.stringify(token.text)}; the functions are ${FUNCTIONS.join(", ")}, and the constants pi and e`);
      }
      this.#expect("(");
      const args = this.#nest(() => {
        const list = [this.#expression()];
        while (this.#isOp(",")) {
          this.#at++;
          list.push(this.#expression());
        }
        return list;
      });
      this.#expect(")");
      return call(token.text as FunctionName, args);
    }
    throw new CalcError(`Unexpected ${JSON.stringify(token.text)} ${this.#where()}`);
  }
}

function isInteger(x: Q): boolean {
  return x.d === 1n;
}

function power(base: Q, exponent: Q): Q {
  if (isInteger(exponent) && exponent.exact) {
    if (abs(exponent.n) > BigInt(MAX_EXPONENT)) throw new CalcError(`Exponents go up to ${MAX_EXPONENT}`);
    const k = exponent.n;
    if (k < 0n && base.n === 0n) throw new CalcError("Division by zero (0 to a negative power)");
    // Refuse before computing a power that couldn't fit.
    if (Number(abs(k)) * Math.max(bits(base.n), bits(base.d)) > MAX_BITS + 64) throw new CalcError("A number in the calculation is too large");
    const up = abs(k);
    const result = q(base.n ** up, base.d ** up, base.exact);
    return k < 0n ? div(q(1n), result) : result;
  }
  const value = Math.pow(toFloat(base), toFloat(exponent));
  if (Number.isNaN(value)) throw new CalcError("A negative number to a fractional power isn't a real number");
  return fromFloat(value);
}

function call(name: FunctionName, args: Q[]): Q {
  const count = (min: number, max: number) => {
    if (args.length < min || args.length > max) {
      throw new CalcError(`${name} takes ${min === max ? min : `${min} to ${max === Infinity ? "any number of" : max}`} argument${max === 1 ? "" : "s"}`);
    }
  };
  switch (name) {
    case "round": {
      count(1, 2);
      const places = args[1] ?? q(0n);
      if (!isInteger(places) || abs(places.n) > 100n) throw new CalcError("round's second argument is a whole number of decimal places, up to 100");
      const scale = 10n ** abs(places.n);
      const factor = places.n >= 0n ? q(scale) : q(1n, scale);
      // Half away from zero, as people round money: round(2.5) is 3, round(-2.5) is -3.
      const scaled = mul(args[0]!, factor);
      const half = q(1n, 2n);
      const magnitude = q(floorInt(add(q(abs(scaled.n), scaled.d), half)));
      const rounded = scaled.n < 0n ? q(-magnitude.n) : magnitude;
      return { ...div(rounded, factor), exact: args[0]!.exact };
    }
    case "floor":
      count(1, 1);
      return q(floorInt(args[0]!), 1n, args[0]!.exact);
    case "ceil": {
      count(1, 1);
      const x = args[0]!;
      return q(-floorInt(q(-x.n, x.d)), 1n, x.exact);
    }
    case "abs":
      count(1, 1);
      return q(abs(args[0]!.n), args[0]!.d, args[0]!.exact);
    case "min":
    case "max": {
      count(1, Infinity);
      return args.reduce((best, x) => ((name === "min" ? compare(x, best) < 0 : compare(x, best) > 0) ? x : best));
    }
    case "sqrt": {
      count(1, 1);
      const x = args[0]!;
      if (x.n < 0n) throw new CalcError("The square root of a negative number isn't a real number");
      const exactRoot = (v: bigint) => {
        const r = BigInt(Math.floor(Math.sqrt(Number(v))));
        for (const c of [r - 1n, r, r + 1n]) if (c >= 0n && c * c === v) return c;
        return undefined;
      };
      const rn = bits(x.n) < 100 ? exactRoot(x.n) : undefined;
      const rd = bits(x.d) < 100 ? exactRoot(x.d) : undefined;
      if (rn !== undefined && rd !== undefined) return q(rn, rd, x.exact);
      return fromFloat(Math.sqrt(toFloat(x)));
    }
  }
}

// ---------------------------------------------------------------- Output

/** x as a decimal: exactly when it ends within 20 places, otherwise to 15 significant digits. */
function decimal(x: Q): { text: string; exact: boolean } {
  // A denominator of only 2s and 5s ends in decimal.
  let d = x.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  const places = Math.max(twos, fives);
  if (x.exact && d === 1n && places <= MAX_PLACES) {
    const scaled = abs(x.n) * 10n ** BigInt(places) / x.d;
    const digits = scaled.toString().padStart(places + 1, "0");
    const whole = digits.slice(0, digits.length - places);
    const fraction = digits.slice(digits.length - places);
    return { text: `${x.n < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`, exact: x.exact };
  }
  return { text: significant(x, APPROXIMATE_DIGITS), exact: false };
}

/** x rounded to `digits` significant digits, half away from zero, without exponent notation for ordinary sizes. */
function significant(x: Q, digits: number): string {
  if (x.n === 0n) return "0";
  const negative = x.n < 0n;
  const n = abs(x.n);
  // The power of ten of the leading digit.
  let exponent = n.toString().length - x.d.toString().length;
  if (n * 10n ** BigInt(Math.max(0, -exponent)) < x.d * 10n ** BigInt(Math.max(0, exponent))) exponent--;
  const shift = digits - 1 - exponent;
  const scaledNum = shift >= 0 ? n * 10n ** BigInt(shift) : n;
  const scaledDen = shift >= 0 ? x.d : x.d * 10n ** BigInt(-shift);
  let rounded = (2n * scaledNum + scaledDen) / (2n * scaledDen);
  let places = shift;
  if (rounded.toString().length > digits) {
    rounded /= 10n;
    places--;
  }
  let text: string;
  if (places <= 0) text = (rounded * 10n ** BigInt(-places)).toString();
  else {
    const raw = rounded.toString().padStart(places + 1, "0");
    text = `${raw.slice(0, raw.length - places)}.${raw.slice(raw.length - places)}`.replace(/\.?0+$/, "");
  }
  if (text.length > 40) {
    const mantissa = rounded.toString();
    const power = mantissa.length - 1 - places;
    text = `${mantissa[0]}${mantissa.length > 1 ? `.${mantissa.slice(1).replace(/0+$/, "")}` : ""}e${power >= 0 ? "+" : ""}${power}`.replace(".e", "e");
  }
  return `${negative ? "-" : ""}${text}`;
}

export type Calculation = {
  readonly expression: string;
  /** The answer as a decimal. */
  readonly result: string;
  /** False when a step was approximate (sqrt, a fractional power, pi, e) or the answer was rounded to 15 significant digits. */
  readonly exact: boolean;
  /** The answer as a JavaScript number, for tests and comparisons. */
  readonly value: number;
};

/** Evaluate `expression`. Throws only `CalcError`. */
export function calculate(expression: string): Calculation {
  if (typeof expression !== "string") throw new CalcError("The expression is text");
  if (expression.length > MAX_EXPRESSION) throw new CalcError(`The expression is longer than ${MAX_EXPRESSION} characters`);
  let value: Q;
  try {
    value = new Parser(tokenize(expression)).parse();
  } catch (error) {
    if (error instanceof CalcError) throw error;
    // A RangeError from BigInt on a size the checks above missed, or a stack overflow: still a clean refusal.
    throw new CalcError("The expression couldn't be worked out: it is too large or too deep");
  }
  const shown = decimal(value);
  return { expression: expression.trim(), result: shown.text, exact: shown.exact, value: toFloat(value) };
}
