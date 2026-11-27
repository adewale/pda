/**
 * Diagnostics, as types (src/diagnostic.ts): `npm run typecheck` checks this
 * file, and each `@ts-expect-error` fails the check if the line under it
 * ever compiles. A raw string can't become shown text, a departure can't be
 * built without what was expected and what was got, and no error of ours
 * takes a free string. Never run: test/diagnostic.test.ts checks what the
 * constructors do with values at run time.
 */
import { departure, ours, ProblemError, show, shown, type Departure, type Problem } from "../src/diagnostic";
import { AttachmentError } from "../src/attachments";
import { ConfigError } from "../src/config";
import { DecodeError } from "../src/decode";
import { PoppyError } from "../src/poppy/client";
import { DiscoveryError } from "../src/poppy/discovery";
import { PoppyFetchError } from "../src/poppy/fetch";
import { JsonError } from "../src/poppy/json";
import { InstructionRefused } from "../src/poppy/instructions";
import { OperationOutcomeUnknown, TermsRequested } from "../src/poppy/operations";
import { AuthError } from "../src/session";
import { CalcError } from "../src/tools/calculate";
import { TimeError } from "../src/tools/clock";
import { MemoryError } from "../src/tools/memory-store";
import { ScheduleError } from "../src/tools/schedule-store";
import { ReadError } from "../src/tools/web";
import { InputError } from "../src/validator/input";

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
  // Every diagnostic error class, the same.
  const problem = ours("Nothing will be resent");
  errors.push(new PoppyError("refused", problem, 0), new ConfigError(problem), new DecodeError(problem));
  // @ts-expect-error a free string
  errors.push(new PoppyError("refused", text, 0));
  // @ts-expect-error a free string
  errors.push(new DiscoveryError(text));
  // @ts-expect-error a free string
  errors.push(new PoppyFetchError(text));
  // @ts-expect-error a free string
  errors.push(new JsonError(text));
  // @ts-expect-error a free string
  errors.push(new ConfigError(text));
  // @ts-expect-error a free string
  errors.push(new DecodeError(text));
  // @ts-expect-error a free string
  errors.push(new AuthError(text));
  // @ts-expect-error a free string
  errors.push(new AttachmentError(400, text));
  // @ts-expect-error a free string
  errors.push(new InputError(text));
  // @ts-expect-error a free string
  errors.push(new InstructionRefused(text));
  // @ts-expect-error a free string
  errors.push(new TermsRequested(text, "apr_1"));
  // @ts-expect-error a free string
  errors.push(new OperationOutcomeUnknown(text));
  errors.push(new TermsRequested(problem, "apr_1"), new CalcError(problem), new TimeError(problem), new MemoryError(problem), new ScheduleError(problem), new ReadError(problem));
  // @ts-expect-error a free string
  errors.push(new CalcError(text));
  // @ts-expect-error a free string
  errors.push(new TimeError(text));
  // @ts-expect-error a free string
  errors.push(new MemoryError(text));
  // @ts-expect-error a free string
  errors.push(new ScheduleError(text));
  // @ts-expect-error a free string
  errors.push(new ReadError(text));
  return errors;
}
