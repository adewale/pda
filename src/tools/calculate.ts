/**
 * The `calculate` tool's arithmetic: a recursive-descent parser over a small
 * grammar, evaluated with exact rational numbers (BigInt numerator and
 * denominator), so `0.1 + 0.2` is `0.3` and sums of money come out to the
 * cent. Only `sqrt`, a power with a fractional exponent and an answer that
 * doesn't end in decimal are approximate, and the result says so. Those
 * steps work on a number's binary mantissa and exponent apart, so a value
 * far outside a double's range keeps its size: `sqrt(2e-20)` is 1.414…e-10,
 * never 0, and an answer past the limits is refused, not rounded. No `eval`,
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

/**
 * n/d (both positive) as m·2^e, m a double between 1/√2 and √2 correct to its
 * last bit. The numerator and denominator are never shifted on their own, so
 * a value far outside a double's range keeps its digits and its exponent.
 */
function binary(n: bigint, d: bigint): { m: number; e: number } {
  // 64 bits of quotient: (n/d)·2^s lies in [2^63, 2^65).
  const s = 64 - (bits(n) - bits(d));
  const scaled = s >= 0 ? (n << BigInt(s)) / d : n / (d << BigInt(-s));
  const top = bits(scaled) - 1;
  const m = Number(scaled) / 2 ** top;
  return m > Math.SQRT2 ? { m: m / 2, e: top - s + 1 } : { m, e: top - s };
}

/** n/d (d > 0) as the nearest double, or 0 or ±Infinity beyond a double's range. */
function ratio(n: bigint, d: bigint): number {
  if (n === 0n) return 0;
  const sign = n < 0n ? -1 : 1;
  n = abs(n);
  let exponent = bits(n) - bits(d);
  if (exponent >= 0 ? n < (d << BigInt(exponent)) : (n << BigInt(-exponent)) < d) exponent--;
  if (exponent > 1023) return sign * Infinity;
  if (exponent < -1075) return sign * 0;
  // Round the exact quotient once, directly at binary64's spacing. Keep the
  // remainder: truncating guard bits loses which side of a midpoint it is
  // on, and rounding a normal mantissa before scaling can round twice when
  // the final value is subnormal.
  const shift = Math.max(exponent - 52, -1074);
  const numerator = shift < 0 ? n << BigInt(-shift) : n;
  const denominator = shift > 0 ? d << BigInt(shift) : d;
  let significand = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  if (twiceRemainder > denominator || (twiceRemainder === denominator && (significand & 1n) !== 0n)) significand++;
  return sign * Number(significand) * 2 ** shift;
}

function toFloat(x: Q): number {
  return ratio(x.n, x.d);
}

/** A finite double as the exact fraction it is (the denominator a power of two). */
function exactDouble(v: number): { n: bigint; d: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  const high = view.getUint32(0);
  const biased = (high >>> 20) & 0x7ff;
  let significand = (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  if (biased !== 0) significand |= 1n << 52n;
  if (high >>> 31) significand = -significand;
  const shift = Math.max(biased, 1) - 1075;
  return shift >= 0 ? { n: significand << BigInt(shift), d: 1n } : { n: significand, d: 1n << BigInt(-shift) };
}

const TOO_FAR = "A number in the calculation is too large or too small";

/** x·2^k, marked approximate, refused when it is beyond the calculator's limits. */
function timesPowerOfTwo(x: Q, k: number): Q {
  if (!(Math.abs(k) <= 2 * MAX_BITS)) throw new CalcError(TOO_FAR);
  return k >= 0 ? q(x.n << BigInt(k), x.d, false) : q(x.n, x.d << BigInt(-k), false);
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

/** The largest integer whose square is at most v (v ≥ 0), by Newton's method in integers. */
function squareRoot(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt(Math.ceil(bits(v) / 2));
  for (;;) {
    const next = (x + v / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
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
  const y = toFloat(exponent);
  if (!Number.isFinite(y)) throw new CalcError("A number in the calculation is too large");
  if (base.n === 0n) return fromFloat(Math.pow(0, y));
  if (base.n < 0n && !Number.isInteger(y)) throw new CalcError("A negative number to a fractional power isn't a real number");
  // |base| = m·2^e with m near 1, so |base|^y = m^y·2^(y·e), and y·e splits exactly into a whole k and a fraction f.
  // Nothing passes through a double whose range the answer might leave.
  const { m, e } = binary(abs(base.n), base.d);
  const ye = mul(exponent, q(BigInt(e)));
  const k = floorInt(ye);
  if (abs(k) > BigInt(2 * MAX_BITS)) throw new CalcError(TOO_FAR);
  const f = toFloat(sub(ye, q(k)));
  // m and y are doubles, a bit off the exact m' and y' when those aren't; a large y magnifies that, so correct by
  // m'^y' = m^y·e^c, c = y·ln(m'/m) + (y' − y)·ln m, each difference worked out in exact integers.
  const mm = exactDouble(m);
  const scaledBase = e >= 0 ? { n: abs(base.n), d: base.d << BigInt(e) } : { n: abs(base.n) << BigInt(-e), d: base.d };
  const yy = exactDouble(y);
  const c =
    y * Math.log1p(ratio(scaledBase.n * mm.d - mm.n * scaledBase.d, mm.n * scaledBase.d)) +
    ratio(exponent.n * yy.d - yy.n * exponent.d, exponent.d * yy.d) * Math.log(m);
  // m^y·2^f leaves a double's range only for a large y (0.999^1000000): take its 2^j-th root, which divides y exactly, and square back in fractions.
  const size = Math.abs(y * Math.log2(m) + f);
  if (!(size <= MAX_BITS + 1)) throw new CalcError(TOO_FAR);
  let j = 0;
  while (size / 2 ** j > 1000) j++;
  let mantissa = fromFloat(Math.pow(m, y / 2 ** j) * 2 ** (f / 2 ** j) * Math.exp(c / 2 ** j));
  for (let i = 0; i < j; i++) mantissa = mul(mantissa, mantissa);
  // A negative base gets here only with a whole y (an approximate one, such as round(pi)).
  if (base.n < 0n && Math.abs(y % 2) === 1) mantissa = q(-mantissa.n, mantissa.d, false);
  return timesPowerOfTwo(mantissa, Number(k));
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
      // A square over a square has an exact root, at any size: sqrt(1.44e-30) is 1.2e-15.
      const exactRoot = (v: bigint) => {
        const r = squareRoot(v);
        return r * r === v ? r : undefined;
      };
      const rn = exactRoot(x.n);
      const rd = exactRoot(x.d);
      if (rn !== undefined && rd !== undefined) return q(rn, rd, x.exact);
      // x = m·2^e with e made even, so sqrt(x) = sqrt(m)·2^(e/2), whatever x's size.
      const { m, e } = binary(x.n, x.d);
      return e % 2 === 0 ? timesPowerOfTwo(fromFloat(Math.sqrt(m)), e / 2) : timesPowerOfTwo(fromFloat(Math.sqrt(2 * m)), (e - 1) / 2);
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
  /** The rational answer rounded to the nearest binary64, ties to even; signed zero or infinity outside its range. */
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
