/**
 * Diagnostics, as types (src/diagnostic.ts): `npm run typecheck` checks this
 * file, and each `@ts-expect-error` fails the check if the line under it
 * ever compiles. A raw string can't become shown text, a departure can't be
 * built without what was expected and what was got, and no error of ours
 * takes a free string. Never run: test/diagnostic.test.ts checks what the
 * constructors do with values at run time.
 */
import { departure, ours, ProblemError, show, shown, type Departure, type Problem } from "../src/diagnostic";

export function rawValuesAreTypeErrors(text: string, value: unknown): Problem[] {
  const problems: Problem[] = [];
  // A literal is ours; a computed string isn't.
  problems.push(ours("Nothing will be resent"));
  // @ts-expect-error a computed string
  problems.push(ours(text));
  // @ts-expect-error a template with a hole is computed
  problems.push(ours(`${text} isn't a scope`));
  // @ts-expect-error a raw string is not shown text
  problems.push(text);

  // The tag's literal parts are ours; each hole must be shown already.
  problems.push(shown`${show.value(value)} isn't a scope`);
  problems.push(shown`${3} servers`);
  // @ts-expect-error a raw string in a hole
  problems.push(shown`${text} isn't a scope`);
  // @ts-expect-error an unknown value in a hole
  problems.push(shown`${value} isn't a scope`);
  return problems;
}

export function departuresHaveBothSides(text: string, value: unknown): Departure[] {
  const subject = show.path("/scopes/0");
  const out: Departure[] = [departure(subject, ours("a scope"), show.value(value))];
  // @ts-expect-error what was got is missing
  out.push(departure(subject, ours("a scope")));
  // @ts-expect-error a raw string as what was expected
  out.push(departure(subject, text, show.value(value)));
  // @ts-expect-error a raw string as what was got
  out.push(departure(subject, ours("a scope"), text));
  // @ts-expect-error a literal object needs shown parts too
  out.push({ subject, expected: "a scope", got: show.value(value) });
  return out;
}

export function errorsTakeProblems(text: string): Error[] {
  const errors: Error[] = [new ProblemError(ours("Nothing will be resent"))];
  // @ts-expect-error an error of ours takes a problem, not a free string
  errors.push(new ProblemError(text));
  return errors;
}
