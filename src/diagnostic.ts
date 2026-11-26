/**
 * What went wrong, said one way everywhere: the validator's messages, the
 * Poppy client's errors, the tools' refusals, configuration and decoding.
 *
 * A diagnostic about a departure says what was expected and what was got,
 * apart (`Departure`), and is rendered one way, as `src/decode.ts` always
 * has: "subject: expected X, got Y". A reader sees the rule and the
 * evidence side by side, and a tool reads them as fields (the validator's
 * report carries `expected` and `got`). A diagnostic that reports no
 * departure (a state, a refusal of ours, a fetch that got no answer) is a
 * fact, one `Shown` sentence.
 *
 * Correct by construction, as `src/log.ts` is for events: every part is
 * `Shown`, and only the constructors here make one.
 *
 * - `ours` takes a literal written in our code; a computed `string` is a
 *   type error (`Closed`).
 * - The `shown` tag's literal parts are ours by construction, and each
 *   hole must already be `Shown` (or a number).
 * - `show.*` turns a value we can't vouch for (a Company's document or
 *   answer, the model's arguments, a setting) into text: quoted, bounded,
 *   and, for a URL, without its query or fragment, which can carry
 *   one-time values.
 *
 * So no error message can carry a raw value by accident, and no departure
 * can be built without both sides; `test/diagnostic-types.ts` proves it
 * under `npm run typecheck`. Shown text reaches people and the model, not
 * events: an error built around a Company's words is still `ForeignText`
 * there (src/log.ts). Portable: no Worker or Node APIs.
 */
import type { Closed } from "./log.ts";

declare const SHOWN: unique symbol;

/** Text fit to show a person or the model. Only the constructors in this module make one. */
export type Shown = string & { readonly [SHOWN]: true };

function made(text: string): Shown {
  return text as Shown;
}

/** A literal written in our code, or a union of them; a computed `string` is a type error. */
export function ours<const T extends string>(text: T & Closed<T>): Shown {
  return made(text);
}

/** A sentence of ours with holes for values already shown: `` shown`${show.value(x)} isn't a scope` ``. */
export function shown(strings: TemplateStringsArray, ...values: readonly (Shown | number)[]): Shown {
  let text = strings[0] ?? "";
  values.forEach((value, index) => {
    text += String(value) + (strings[index + 1] ?? "");
  });
  return made(text);
}

/** At most `max` characters, with an ellipsis when cut. */
function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Control characters and line breaks as spaces, so a value can't start a line of its own. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
}

/** A JSON Pointer as a path: `/agent/protocols/0` → `agent.protocols[0]`. */
function path(pointer: string): string {
  if (pointer === "") return "the document";
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((out, part) => (/^\d+$/.test(part) ? `${out}[${part}]` : /^[A-Za-z_][\w-]*$/.test(part) ? (out ? `${out}.${part}` : part) : `${out}[${JSON.stringify(bounded(part, 40))}]`), "");
}

export const show = {
  /**
   * A value we can't vouch for, as a reader needs to see it: a string
   * quoted (bounded), a number or boolean as written, and a structure by
   * its kind.
   */
  value(value: unknown): Shown {
    if (value === undefined) return made("nothing");
    if (value === null) return made("null");
    if (typeof value === "string") return made(JSON.stringify(bounded(value, 60)));
    if (typeof value === "number" || typeof value === "boolean") return made(String(value));
    if (Array.isArray(value)) return made(value.length === 0 ? "an empty array" : "an array");
    if (typeof value === "object") return made("an object");
    return made(`a ${typeof value}`);
  },
  /** A value's kind alone, for a type mismatch: "a string", "an array", "null". */
  kind(value: unknown): Shown {
    if (value === undefined) return made("nothing");
    if (value === null) return made("null");
    if (Array.isArray(value)) return made("an array");
    if (typeof value === "object") return made("an object");
    if (typeof value === "number") return made(Number.isFinite(value) ? (Number.isInteger(value) ? "a whole number" : "a number") : "a number that isn't finite");
    return made(`a ${typeof value}`);
  },
  /** Someone else's words (an error_description, a page's text, the model's argument): quoted, on one line, bounded. */
  text(text: string, max = 120): Shown {
    return made(JSON.stringify(bounded(oneLine(text), max)));
  },
  /** A name shown as written, not quoted: a Company's name, a host, a provider. On one line and bounded. */
  name(text: string): Shown {
    return made(bounded(oneLine(text).trim(), 80) || "(no name)");
  },
  /**
   * A URL without its query or fragment, which can carry one-time values (a
   * sign-in request, a state, a code); `asked`, the URL as asked for, is
   * shown whole. Not a URL: shown as text.
   */
  url(url: URL | string, asked?: URL | string): Shown {
    let at: URL;
    try {
      at = typeof url === "string" ? new URL(url) : url;
    } catch {
      return show.text(String(url), 200);
    }
    // javascript:, data: and other URLs without an origin: their scheme alone, since the rest is content.
    if (at.origin === "null") return made(`${bounded(at.protocol, 40)}…`);
    // Never a user name or password: `origin` has neither. A bare origin is shown without the root path's slash.
    const where = at.pathname === "/" && !at.search && !at.hash ? at.origin : `${at.origin}${at.pathname}`;
    if (asked !== undefined && at.href === new URL(String(asked)).href) return made(bounded(`${where}${at.search}${at.hash}`, 300));
    const elided = at.search || at.hash ? "?…" : "";
    return made(bounded(where, 200) + elided);
  },
  /** An HTTP status: "HTTP 503". */
  status(status: number): Shown {
    return made(`HTTP ${status}`);
  },
  /** A media type without its parameters, or "no Content-Type". */
  type(contentType: string | null | undefined): Shown {
    const type = contentType?.split(";")[0]?.trim().toLowerCase();
    return made(type ? bounded(oneLine(type), 80) : "no Content-Type");
  },
  /** A JSON Pointer into a document, as a path: `agent.protocols[0].endpoint`. */
  path(pointer: string): Shown {
    return made(bounded(path(pointer), 160));
  },
  /** A short code a protocol or a provider defines (`invalid_grant`), shown as written when it looks like one, else quoted. */
  code(value: unknown): Shown {
    return typeof value === "string" && /^[A-Za-z0-9_.:+-]{1,64}$/.test(value) ? made(value) : show.value(value);
  },
  /** "1 server", "3 servers". */
  count(count: number, one: Shown, many: Shown): Shown {
    return made(`${count} ${count === 1 ? one : many}`);
  },
  /** Separate items in one line, such as several problems: "a; b; c". */
  join(items: readonly Shown[], separator: "; " | ", " = "; "): Shown {
    return made(items.join(separator));
  },
  /** "a", "a and b", "a, b or c". */
  list(items: readonly Shown[], conjunction: "and" | "or" = "and"): Shown {
    if (items.length <= 1) return made(items[0] ?? "nothing");
    return made(`${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`);
  }
} as const;

/** What was expected and what was got, about `subject`, and optionally what follows from it. */
export type Departure = {
  readonly subject: Shown;
  readonly expected: Shown;
  readonly got: Shown;
  /** What follows from it, or what was done about it: a sentence of its own. */
  readonly then?: Shown;
};

/** A diagnostic: a departure, or a fact (one sentence). */
export type Problem = Departure | Shown;

export function departure(subject: Shown, expected: Shown, got: Shown, then?: Shown): Departure {
  return then === undefined ? { subject, expected, got } : { subject, expected, got, then };
}

export function isDeparture(problem: Problem): problem is Departure {
  return typeof problem === "object";
}

/** The diagnostic as text, without a closing full stop: "subject: expected X, got Y. Then." Shown, since every part is. */
export function render(problem: Problem): Shown {
  if (!isDeparture(problem)) return problem;
  const said = shown`${problem.subject}: expected ${problem.expected}, got ${problem.got}`;
  return problem.then === undefined ? said : shown`${said}. ${problem.then}`;
}

/** The diagnostic as a sentence, with one closing full stop. */
export function sentence(problem: Problem): Shown {
  const text = render(problem);
  return /[.!?…]$/.test(text) ? text : shown`${text}.`;
}

/** Shown text without its closing full stop, to join sentences into one line. */
export function withoutStop(text: Shown): Shown {
  return made(text.replace(/\.$/, ""));
}

/**
 * An error made from a diagnostic, never from a free string: its message is
 * the diagnostic rendered, and `problem` keeps the parts.
 */
export class ProblemError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(render(problem));
    this.problem = problem;
  }
}

