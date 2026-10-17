import { describe, expect, it } from "vitest";
import { CalcError, calculate, MAX_EXPRESSION } from "../../src/tools/calculate";
import {
  addDays,
  addMonths,
  addToDate,
  addToInstant,
  civil,
  dateDifference,
  dateMath,
  dayNumber,
  daysInMonth,
  instantDifference,
  instantOf,
  negate,
  parseDuration,
  TimeError,
  wallAt,
  weekday,
  ZERO,
  type CalendarDate
} from "../../src/tools/clock";
import { gs, property } from "./hegel";

/**
 * The general tools' pure parts (src/tools/calculate.ts, src/tools/clock.ts)
 * against their documented contracts: the calculator agrees with plain
 * arithmetic, is exact on money, and refuses bad input only with a
 * CalcError; date arithmetic round-trips where the calendar lets it, and
 * refuses bad input only with a TimeError.
 */

type TC = Parameters<Parameters<typeof property>[0]>[0];

// ---------------------------------------------------------------- calculate

/**
 * The reference: a plain fraction of two BigInts, written here apart from
 * the calculator's own, evaluating a tree rather than parsing text.
 */
type F = { n: bigint; d: bigint };

/** Bits in the largest numerator or denominator the reference has made since it was last reset. */
let largestBits = 0;

function frac(n: bigint, d = 1n): F {
  largestBits = Math.max(largestBits, (n < 0n ? -n : n).toString(2).length, (d < 0n ? -d : d).toString(2).length);
  if (d < 0n) [n, d] = [-n, -d];
  let [a, b] = [n < 0n ? -n : n, d];
  while (b) [a, b] = [b, a % b];
  return a > 1n ? { n: n / a, d: d / a } : { n, d };
}
const F_ADD = (a: F, b: F) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const F_SUB = (a: F, b: F) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const F_MUL = (a: F, b: F) => frac(a.n * b.n, a.d * b.d);
const F_DIV = (a: F, b: F) => frac(a.n * b.d, a.d * b.n);
const F_LESS = (a: F, b: F) => a.n * b.d < b.n * a.d;
/** Floor of a fraction, by repeated subtraction's closed form: the integer below or at it. */
function fFloor(a: F): bigint {
  const t = a.n / a.d;
  return t * a.d > a.n ? t - 1n : t;
}

/** A decimal string (`-12.5`, `3`, `1.5e+3`) as a fraction. */
function decimalFraction(text: string): F {
  const [mantissa = "", exponent = "0"] = text.toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  const [whole = "0", part = ""] = mantissa.replace("-", "").split(".");
  const shift = Number(exponent) - part.length;
  const n = BigInt(`${whole}${part}`) * (negative ? -1n : 1n);
  return shift >= 0 ? frac(n * 10n ** BigInt(shift)) : frac(n, 10n ** BigInt(-shift));
}

/** A literal's power of ten: none often, a few dozen either way, or anything a literal may have (up to 1,000), far outside a double's range. */
const powersOfTen = gs.oneOf(gs.just(0), gs.integers({ minValue: -40, maxValue: 40 }), gs.integers({ minValue: -1000, maxValue: 1000 }));

/**
 * A decimal literal: small numbers often (0, 1 and their neighbours are where
 * arithmetic goes wrong), any up to a trillion too, with up to 8 places, and
 * sometimes in exponent notation (`1.5e-300`).
 */
function literal(tc: TC): { text: string; value: F } {
  const whole = tc.draw(gs.oneOf(gs.integers({ minValue: 0, maxValue: 12 }), gs.integers({ minValue: 0, maxValue: 999_999_999_999 })));
  const places = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
  const fraction = places ? tc.draw(gs.integers({ minValue: 0, maxValue: 10 ** places - 1 })) : 0;
  const exponent = tc.draw(powersOfTen);
  const text = `${places ? `${whole}.${String(fraction).padStart(places, "0")}` : String(whole)}${exponent ? `e${exponent}` : ""}`;
  return { text, value: decimalFraction(text) };
}

const size = (x: F) => frac(x.n < 0n ? -x.n : x.n, x.d);
/** Decode the exact binary value, independently of the calculator's decimal/parser code. */
function binaryFraction(bits: bigint): F {
  if (bits === 0x7ff0000000000000n) return frac(1n << 1024n); // virtual neighbour above MAX_VALUE
  const exponent = Number(bits >> 52n);
  const significand = (bits & 0xfffffffffffffn) + (exponent === 0 ? 0n : 1n << 52n);
  const shift = Math.max(1, exponent) - 1075;
  return shift >= 0 ? frac(significand << BigInt(shift)) : frac(significand, 1n << BigInt(-shift));
}

/** Check exact rounding intervals, including ties-to-even, signed underflow and overflow. */
function expectNearest(value: number, exact: F, context: string): void {
  expect(Number.isNaN(value), context).toBe(false);
  if (exact.n === 0n) {
    expect(value, context).toBe(0);
    return;
  }
  expect(value < 0 || Object.is(value, -0), context).toBe(exact.n < 0n);
  const magnitude = size(exact);
  const overflow = frac((1n << 1024n) - (1n << 970n));
  if (!Number.isFinite(value)) {
    expect(F_LESS(magnitude, overflow), context).toBe(false);
    return;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const middle = binaryFraction(bits);
  const even = (bits & 1n) === 0n;
  const above = F_DIV(F_ADD(middle, binaryFraction(bits + 1n)), frac(2n));
  // Cross multiply the exact rational against both adjacent midpoints. No epsilon.
  const upper = magnitude.n * above.d - above.n * magnitude.d;
  expect(upper < 0n || (upper === 0n && even), context).toBe(true);
  if (bits > 0n) {
    const below = F_DIV(F_ADD(middle, binaryFraction(bits - 1n)), frac(2n));
    const lower = magnitude.n * below.d - below.n * magnitude.d;
    expect(lower > 0n || (lower === 0n && even), context).toBe(true);
  }
}

/**
 * An expression and its exact value, built together as a tree. Every
 * operator's operands are parenthesised, so the reference never needs the
 * parser's precedence (the next property checks that). `value` is null
 * once something divides by zero.
 */
type Built = { text: string; value: F | null };

function expression(tc: TC, depth: number): Built {
  const kind = depth <= 0 ? "literal" : tc.draw(gs.sampledFrom(["literal", "binary", "binary", "negate", "percent", "power", "call"] as const));
  if (kind === "literal") return literal(tc);
  const a = expression(tc, depth - 1);
  const map = (text: string, op: (x: F) => F | null): Built => ({ text, value: a.value === null ? null : op(a.value) });
  if (kind === "negate") return map(`-(${a.text})`, (x) => frac(-x.n, x.d));
  if (kind === "percent") return map(`(${a.text})%`, (x) => frac(x.n, x.d * 100n));
  if (kind === "power") {
    const k = tc.draw(gs.integers({ minValue: -2, maxValue: 3 }));
    return map(`(${a.text})^${k}`, (x) => (k >= 0 ? frac(x.n ** BigInt(k), x.d ** BigInt(k)) : x.n === 0n ? null : frac(x.d ** BigInt(-k), x.n ** BigInt(-k))));
  }
  if (kind === "call") {
    const name = tc.draw(gs.sampledFrom(["abs", "floor", "ceil", "min", "max", "round", "roundN"] as const));
    if (name === "min" || name === "max") {
      const b = expression(tc, depth - 1);
      const value = a.value === null || b.value === null ? null : (name === "min" ? F_LESS(b.value, a.value) : F_LESS(a.value, b.value)) ? b.value : a.value;
      return { text: `${name}(${a.text}, ${b.text})`, value };
    }
    if (name === "abs") return map(`abs(${a.text})`, (x) => frac(x.n < 0n ? -x.n : x.n, x.d));
    if (name === "floor") return map(`floor(${a.text})`, (x) => frac(fFloor(x)));
    if (name === "ceil") return map(`ceil(${a.text})`, (x) => frac(-fFloor(frac(-x.n, x.d))));
    // Half away from zero.
    const places = name === "roundN" ? tc.draw(gs.integers({ minValue: -100, maxValue: 100 })) : 0;
    const factor = places >= 0 ? frac(10n ** BigInt(places)) : frac(1n, 10n ** BigInt(-places));
    return map(`round(${a.text}${name === "roundN" ? `, ${places}` : ""})`, (x) => {
      const scaled = F_MUL(x, factor);
      const magnitude = fFloor(F_ADD(frac(scaled.n < 0n ? -scaled.n : scaled.n, scaled.d), frac(1n, 2n)));
      return F_DIV(frac(scaled.n < 0n ? -magnitude : magnitude), factor);
    });
  }
  const op = tc.draw(gs.sampledFrom(["+", "-", "*", "/", "mod"] as const));
  const b = expression(tc, depth - 1);
  const text = `(${a.text}) ${op} (${b.text})`;
  if (a.value === null || b.value === null) return { text, value: null };
  if ((op === "/" || op === "mod") && b.value.n === 0n) return { text, value: null };
  if (op === "mod") return { text, value: F_SUB(a.value, F_MUL(b.value, frac(fFloor(F_DIV(a.value, b.value))))) };
  return { text, value: (op === "+" ? F_ADD : op === "-" ? F_SUB : op === "*" ? F_MUL : F_DIV)(a.value, b.value) };
}

describe("calculate", () => {
  it(
    "agrees exactly with fraction arithmetic on any expression of decimals, operators and functions, refusing only division by zero",
    property((tc) => {
      largestBits = 0;
      const built = expression(tc, tc.draw(gs.integers({ minValue: 0, maxValue: 4 })));
      const bits = largestBits;
      tc.note(built.text);
      // The calculator refuses numbers over 4,000 bits; the reference has no limit, so a refusal must follow a huge step.
      let result: ReturnType<typeof calculate> | undefined;
      if (built.value !== null) {
        try {
          result = calculate(built.text);
        } catch (error) {
          expect(error).toBeInstanceOf(CalcError);
          expect((error as Error).message, built.text).toMatch(/too large/);
          expect(bits, built.text).toBeGreaterThan(3000);
          return;
        }
      }
      if (built.value === null) {
        expect(() => calculate(built.text)).toThrow(CalcError);
        expect(() => calculate(built.text)).toThrow(/Division by zero/);
        return;
      }
      if (!result) return;
      const shown = decimalFraction(result.result);
      const exact = built.value;
      if (result.exact) {
        expect(shown, `${built.text} = ${result.result}`).toEqual(exact);
      } else {
        // Not a terminating decimal within 20 places: 15 significant digits (an integer's trailing zeros aren't), so within a unit in the 15th.
        const digits = result.result.replace(/e.*/, "").replace(/^-/, "").replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
        expect(digits.length, result.result).toBeLessThanOrEqual(15);
        const error = F_SUB(shown, exact);
        expect(F_LESS(F_MUL(size(error), frac(10n ** 14n)), size(exact)), `${built.text} = ${result.result}`).toBe(true);
      }
    })
  );

  it(
    "rounds an exact rational answer to the nearest binary64 value with ties to even",
    property((tc) => {
      const built = expression(tc, tc.draw(gs.integers({ minValue: 0, maxValue: 4 })));
      tc.note(built.text);
      if (built.value === null) return;
      let result: ReturnType<typeof calculate>;
      try {
        result = calculate(built.text);
      } catch (error) {
        // The independent arithmetic property judges size refusals.
        expect(error).toBeInstanceOf(CalcError);
        return;
      }
      expectNearest(result.value, built.value, built.text);
    })
  );

  it("rounds at and on both sides of binary64 midpoints, including zero, subnormals and overflow", property((tc) => {
    const bits = tc.draw(gs.oneOf(
      gs.bigIntegers({ minValue: 0n, maxValue: 0x7fefffffffffffffn }),
      gs.sampledFrom([0n, 1n, 0xfffffffffffffn, 0x10000000000000n, 0x3ff0000000000000n, 0x7fefffffffffffffn])
    ));
    const low = binaryFraction(bits), high = binaryFraction(bits + 1n);
    const gap = F_SUB(high, low);
    const offset = tc.draw(gs.integers({ minValue: -1, maxValue: 1 }));
    const precision = tc.draw(gs.integers({ minValue: 2, maxValue: 100 }));
    const sign = tc.draw(gs.booleans()) ? -1n : 1n;
    const exact = F_MUL(F_ADD(F_DIV(F_ADD(low, high), frac(2n)), F_MUL(gap, frac(BigInt(offset), 1n << BigInt(precision)))), frac(sign));
    const text = `(${exact.n}) / (${exact.d})`;
    tc.note(`${bits.toString(16)} offset=${offset}/2^${precision} ${text}`);
    expectNearest(calculate(text).value, exact, text);
  }));

  it("keeps sticky bits below a midpoint instead of rounding an already-truncated quotient", () => {
    const denominator = 1n << 100n;
    const numerator = denominator + (1n << 47n) + 1n;
    expect(calculate(`${numerator}/${denominator}`).value).toBe(1 + Number.EPSILON);
  });

  /** A fractional power p/r (r from 2 to 6, p not a multiple of r), written as `sqrt`, a fraction or, when it ends, a decimal. */
  function fractionalPower(tc: TC): { write: (base: string) => string; p: number; r: number } {
    const r = tc.draw(gs.integers({ minValue: 2, maxValue: 6 }));
    const p = tc.draw(gs.integers({ minValue: -12, maxValue: 12 }).filter((value) => value % r !== 0));
    const how = tc.draw(gs.sampledFrom(["sqrt", "fraction", "decimal"] as const));
    if (how === "sqrt" && p === 1 && r === 2) return { write: (base) => `sqrt(${base})`, p, r };
    if (how === "decimal" && (r === 2 || r === 4 || r === 5)) return { write: (base) => `(${base})^${p / r}`, p, r };
    return { write: (base) => `(${base})^(${p}/${r})`, p, r };
  }

  it(
    "takes a square root or a fractional power of any positive number in range, however small or large, to 15 significant digits: raised back, it is the number",
    property((tc) => {
      // x = mantissa × 10^exponent, with the exponent anywhere a literal allows.
      const digits = tc.draw(gs.integers({ minValue: 1, maxValue: 999_999_999 }));
      const exponent = tc.draw(gs.oneOf(gs.integers({ minValue: -40, maxValue: 40 }), gs.integers({ minValue: -1000, maxValue: 1000 })));
      const text = `${digits}e${exponent}`;
      const x = decimalFraction(text);
      // x^(p/r), so (x^(p/r))^r = x^p.
      const { write, p, r } = fractionalPower(tc);
      const expression = write(text);
      tc.note(expression);
      // The answer's size in powers of two; past about 4,000 bits the calculator refuses, and only then.
      const bitsOfAnswer = (Math.log2(digits) + exponent * Math.log2(10)) * (p / r);
      let result: ReturnType<typeof calculate>;
      try {
        result = calculate(expression);
      } catch (error) {
        expect(error, expression).toBeInstanceOf(CalcError);
        expect((error as Error).message, expression).toMatch(/too large/);
        expect(Math.abs(bitsOfAnswer), expression).toBeGreaterThan(3900);
        return;
      }
      const answer = decimalFraction(result.result);
      expect(answer.n, `${expression} = ${result.result}`).not.toBe(0n);
      const significant = result.result.replace(/e.*/, "").replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
      expect(significant.length, result.result).toBeLessThanOrEqual(15);
      // 15 significant digits put the answer within 1e-14 of the root, so its r-th power is within r × 1e-14 of x^p.
      const raise = (v: F, k: number): F => (k >= 0 ? frac(v.n ** BigInt(k), v.d ** BigInt(k)) : frac(v.d ** BigInt(-k), v.n ** BigInt(-k)));
      const back = raise(answer, r);
      const target = raise(x, p);
      expect(F_LESS(F_MUL(size(F_SUB(back, target)), frac(10n ** 14n)), F_MUL(size(target), frac(BigInt(r)))), `${expression} = ${result.result}`).toBe(true);
    })
  );

  it(
    "refuses a square root or a fractional power of any negative number, however small or large, as not a real number",
    property((tc) => {
      const digits = tc.draw(gs.integers({ minValue: 1, maxValue: 999_999_999 }));
      const exponent = tc.draw(gs.oneOf(gs.integers({ minValue: -40, maxValue: 40 }), gs.integers({ minValue: -1000, maxValue: 1000 })));
      const expression = fractionalPower(tc).write(`-${digits}e${exponent}`);
      tc.note(expression);
      expect(() => calculate(expression), expression).toThrow(CalcError);
      expect(() => calculate(expression), expression).toThrow(/isn't a real number/);
    })
  );

  it(
    "binds ^ tighter than unary minus, unary minus tighter than * and /, and those tighter than + and -, left to right except ^",
    property((tc) => {
      const [a, b, c] = [0, 1, 2].map(() => tc.draw(gs.integers({ minValue: 1, maxValue: 50 })));
      const k = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
      const same = (left: string, right: string) => expect(calculate(left).result, `${left} vs ${right}`).toBe(calculate(right).result);
      same(`${a} + ${b} * ${c}`, `${a} + (${b} * ${c})`);
      same(`${a} - ${b} - ${c}`, `(${a} - ${b}) - ${c}`);
      same(`${a} / ${b} / ${c}`, `(${a} / ${b}) / ${c}`);
      same(`${a} * ${b} mod ${c}`, `(${a} * ${b}) mod ${c}`);
      same(`-${a}^${k}`, `-(${a}^${k})`);
      same(`2^${k}^2`, `2^(${k}^2)`);
      same(`${a} * -${b}`, `${a} * (-${b})`);
      same(`${a} + ${b}%`, `${a} + (${b} / 100)`);
    })
  );

  it(
    "adds and multiplies money exactly: a sum of amounts in cents is the sum of the cents",
    property((tc) => {
      const cents = tc.draw(gs.arrays(gs.integers({ minValue: -100_000_000_000, maxValue: 100_000_000_000 }), { minSize: 1, maxSize: 12 }));
      const show = (value: bigint) => {
        const negative = value < 0n;
        const size = negative ? -value : value;
        const text = `${size / 100n}.${String(size % 100n).padStart(2, "0")}`.replace(/\.?0+$/, "").replace(/^$/, "0");
        return `${negative && text !== "0" ? "-" : ""}${text}`;
      };
      const amounts = cents.map((value) => show(BigInt(value)));
      const quantity = tc.draw(gs.integers({ minValue: 1, maxValue: 1000 }));
      const total = cents.reduce((sum, value) => sum + BigInt(value), 0n);
      const sum = calculate(amounts.map((amount) => `(${amount})`).join(" + "));
      expect(sum).toMatchObject({ result: show(total), exact: true });
      expect(calculate(`(${sum.result}) * ${quantity}`)).toMatchObject({ result: show(total * BigInt(quantity)), exact: true });
    })
  );

  it(
    "rounds half away from zero to any number of places, exactly",
    property((tc) => {
      const places = tc.draw(gs.integers({ minValue: -100, maxValue: 100 }));
      const whole = BigInt(tc.draw(gs.integers({ minValue: 0, maxValue: 10_000_000 })));
      const digit = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
      const sign = tc.draw(gs.booleans()) ? -1n : 1n;
      const input = `${sign < 0n ? "-" : ""}${whole * 10n + BigInt(digit)}e${-places - 1}`;
      const rounded = sign * (whole + (digit >= 5 ? 1n : 0n));
      const expected = places >= 0 ? frac(rounded, 10n ** BigInt(places)) : frac(rounded * 10n ** BigInt(-places));
      // Parsing the returned decimal is independent of the calculator under test.
      expect(decimalFraction(calculate(`round(${input}, ${places})`).result), input).toEqual(expected);
    })
  );

  it(
    "refuses anything that isn't an expression with a CalcError, and nothing else",
    property((tc) => {
      const input = tc.draw(
        gs.oneOf(
          gs.text(),
          gs.text({ alphabet: "0123456789.+-*/^%(),e ×÷−mod sqrt round pi", maxSize: 80 }),
          gs.integers({ minValue: 0, maxValue: 200 }).map((n) => `${"(".repeat(n)}1${")".repeat(n)}`),
          gs.integers({ minValue: 0, maxValue: 200 }).map((n) => `${"-".repeat(n)}2^${"9^".repeat(n % 5)}9`),
          gs.integers({ minValue: MAX_EXPRESSION - 2, maxValue: MAX_EXPRESSION + 2 }).map((n) => "1".repeat(n))
        )
      );
      try {
        const result = calculate(input);
        expect(typeof result.result).toBe("string");
        expect(result.result).toMatch(/^-?(\d+(\.\d+)?|\d(\.\d+)?e[+-]\d+)$/);
      } catch (error) {
        expect(error, input).toBeInstanceOf(CalcError);
      }
    })
  );
});

// ---------------------------------------------------------------- dates

/** Any date from year 1 to 9999. */
const dates = gs.integers({ minValue: dayNumber(1, 1, 1), maxValue: dayNumber(9999, 12, 31) }).map(civil);

const ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

/** Any instant from year 1 to 9999 (before 1970 the zone database gives local mean time, offsets with seconds). */
const instants = gs.integers({ minValue: dayNumber(1, 1, 2) * 86_400_000, maxValue: dayNumber(9999, 12, 30) * 86_400_000 });

function inRange(date: CalendarDate): boolean {
  return date.year >= 1 && date.year <= 9999;
}

describe("date_math", () => {
  it(
    "numbers every day once: a date's day number gives the date back, and the next day is the next weekday",
    property((tc) => {
      const day = tc.draw(gs.integers({ minValue: dayNumber(1, 1, 1), maxValue: dayNumber(9999, 12, 31) - 1 }));
      const date = civil(day);
      expect(dayNumber(date.year, date.month, date.day)).toBe(day);
      expect(date.day).toBeLessThanOrEqual(daysInMonth(date.year, date.month));
      const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
      expect(days.indexOf(weekday(civil(day + 1)))).toBe((days.indexOf(weekday(date)) + 1) % 7);
    })
  );

  it(
    "adding days or weeks, then subtracting them, gives back the date",
    property((tc) => {
      const date = tc.draw(dates);
      const days = tc.draw(gs.integers({ minValue: -3_000_000, maxValue: 3_000_000 }));
      const unit = tc.draw(gs.sampledFrom(["days", "weeks"] as const));
      const amount = unit === "weeks" ? Math.trunc(days / 7) : days;
      let there: CalendarDate;
      try {
        there = addToDate(date, { ...ZERO, [unit]: amount });
      } catch (error) {
        expect(error).toBeInstanceOf(TimeError);
        expect(inRange(civil(dayNumber(date.year, date.month, date.day) + (unit === "weeks" ? amount * 7 : amount)))).toBe(false);
        return;
      }
      expect(addToDate(there, negate({ ...ZERO, [unit]: amount }))).toEqual(date);
    })
  );

  it(
    "adding months moves the month by exactly that many, keeping the day or taking the month's last; up to day 28 it round-trips",
    property((tc) => {
      const date = tc.draw(dates);
      const months = tc.draw(gs.integers({ minValue: -12_000, maxValue: 12_000 }));
      let there: CalendarDate;
      try {
        there = addMonths(date, months);
      } catch (error) {
        expect(error).toBeInstanceOf(TimeError);
        const target = (date.year - 1) * 12 + date.month - 1 + months;
        expect(target < 0 || target >= 9999 * 12, "an in-range month addition must succeed").toBe(true);
        return;
      }
      expect(there.year * 12 + there.month - (date.year * 12 + date.month)).toBe(months);
      expect(there.day).toBe(Math.min(date.day, daysInMonth(there.year, there.month)));
      if (date.day <= 28) expect(addMonths(there, -months)).toEqual(date);
    })
  );

  it(
    "the difference between two dates, in years, months and days, added to the first gives the second",
    property((tc) => {
      const from = tc.draw(dates);
      const to = tc.draw(dates);
      const difference = dateDifference(from, to);
      const total = dayNumber(to.year, to.month, to.day) - dayNumber(from.year, from.month, from.day);
      expect(difference.total_days).toBe(total);
      expect(difference.weeks * 7 + difference.weekdays_left).toBe(total);
      const parts = [difference.years, difference.months, difference.days];
      expect(parts.every((part) => Math.sign(part) === 0 || Math.sign(part) === Math.sign(total))).toBe(true);
      expect(Math.abs(difference.months)).toBeLessThan(12);
      expect(addDays(addMonths(from, difference.years * 12 + difference.months), difference.days)).toEqual(to);
    })
  );

  it(
    "adding hours, minutes and seconds to an instant, then subtracting them, gives back the instant, in any zone",
    property((tc) => {
      const at = tc.draw(instants);
      const zone = tc.draw(gs.sampledFrom(ZONES));
      const duration = parseDuration({
        hours: tc.draw(gs.integers({ minValue: -100_000, maxValue: 100_000 })),
        minutes: tc.draw(gs.integers({ minValue: -10_000, maxValue: 10_000 })),
        seconds: tc.draw(gs.integers({ minValue: -100_000, maxValue: 100_000 }))
      });
      let there: number;
      try {
        there = addToInstant(at, duration, zone);
      } catch (error) {
        // Refused only past the years it handles (a day's slack for the zone's offset).
        expect(error).toBeInstanceOf(TimeError);
        const sum = at + ((duration.hours * 60 + duration.minutes) * 60 + duration.seconds) * 1000;
        expect(sum < dayNumber(1, 1, 2) * 86_400_000 || sum > dayNumber(9999, 12, 30) * 86_400_000).toBe(true);
        return;
      }
      expect(addToInstant(there, negate(duration), zone)).toBe(at);
      expect(instantDifference(at, there).total_seconds).toBe(Math.trunc((there - at) / 1000));
    })
  );

  it(
    "reads back every wall-clock time it shows: the instant it names shows the same wall-clock time",
    property((tc) => {
      const at = tc.draw(instants);
      const zone = tc.draw(gs.sampledFrom(ZONES));
      const wall = wallAt(at, zone);
      const back = instantOf(wall, zone);
      expect(wallAt(back, zone)).toEqual(wall);
      // In a repeated hour it picks the earlier instant, never a later one.
      expect(back).toBeLessThanOrEqual(at);
    })
  );

  it(
    "reads an ISO 8601 duration as the units it names",
    property((tc) => {
      const fields = {
        years: tc.draw(gs.integers({ minValue: 0, maxValue: 10_000 })),
        months: tc.draw(gs.integers({ minValue: 0, maxValue: 120_000 })),
        weeks: tc.draw(gs.integers({ minValue: 0, maxValue: 530_000 })),
        days: tc.draw(gs.integers({ minValue: 0, maxValue: 3_700_000 })),
        hours: tc.draw(gs.integers({ minValue: 0, maxValue: 88_000_000 })),
        minutes: tc.draw(gs.integers({ minValue: 0, maxValue: 5_300_000_000 })),
        seconds: tc.draw(gs.integers({ minValue: 0, maxValue: 320_000_000_000 }))
      };
      const negative = tc.draw(gs.booleans());
      const keep = Object.fromEntries(Object.entries(fields).filter(() => tc.draw(gs.booleans()))) as Partial<typeof fields>;
      tc.assume(Object.keys(keep).length > 0);
      const date = `${keep.years !== undefined ? `${keep.years}Y` : ""}${keep.months !== undefined ? `${keep.months}M` : ""}${keep.weeks !== undefined ? `${keep.weeks}W` : ""}${keep.days !== undefined ? `${keep.days}D` : ""}`;
      const time = `${keep.hours !== undefined ? `${keep.hours}H` : ""}${keep.minutes !== undefined ? `${keep.minutes}M` : ""}${keep.seconds !== undefined ? `${keep.seconds}S` : ""}`;
      const text = `${negative ? "-" : ""}P${date}${time ? `T${time}` : ""}`;
      const sign = negative ? -1 : 1;
      const expected = Object.fromEntries(Object.keys(fields).map((unit) => [unit, (keep[unit as keyof typeof fields] ?? 0) * sign || 0]));
      expect(parseDuration(text)).toEqual(expected);

    })
  );

  it("refuses a near-valid duration with misplaced units, fractional units or trailing garbage", property((tc) => {
    const n = tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 }));
    const invalid = tc.draw(gs.sampledFrom([`P${n}.5D`, `P${n}H`, `PT${n}D`, `P${n}D!`, `P${n}DT`, "P", "PT"]));
    expect(() => parseDuration(invalid)).toThrow(TimeError);
  }));

  it(
    "refuses any start, duration or end it can't read with a TimeError, and nothing else",
    property((tc) => {
      const text = () => tc.draw(gs.oneOf(gs.text({ maxSize: 40 }), gs.text({ alphabet: "0123456789-:TZPYMWDHS+. ", maxSize: 30 }), gs.sampledFrom(["now", "today", "2026-02-29", "0000-01-01", "9999-12-31T23:59:59Z"])));
      const input = {
        start: text(),
        ...(tc.draw(gs.booleans()) ? { add: text() } : {}),
        ...(tc.draw(gs.booleans()) ? { until: text() } : {})
      };
      const zone = tc.draw(gs.sampledFrom(ZONES));
      try {
        dateMath(input, zone, Date.UTC(2026, 9, 12, 12));
      } catch (error) {
        expect(error, JSON.stringify(input)).toBeInstanceOf(TimeError);
      }
    })
  );
});
