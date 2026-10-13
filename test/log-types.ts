/**
 * The wide events' privacy, as types (src/log.ts): `npm run typecheck`
 * checks this file, and each `@ts-expect-error` fails the check if the line
 * under it ever compiles. A raw string, an email, a token, a URL or a
 * person's words can't be put in an event field, an error's code or step,
 * a frame's or job's name, or a Poppy exchange; only values the allow-listed
 * constructors made can. Never run: test/log.test.ts checks what the
 * constructors do with values at run time.
 */
import type { Identity } from "../src/session";
import {
  code,
  id,
  join,
  literal,
  message,
  origin,
  plainUnits,
  recordPoppyExchange,
  reportError,
  toolName,
  wideEvent,
  type Field,
  type Safe,
  type ToolCall,
  type WideEvent
} from "../src/log";

export function rawValuesAreTypeErrors(event: WideEvent, identity: Identity, text: string, token: string, url: string): void {
  // A raw string, from anywhere.
  // @ts-expect-error a string isn't Safe
  event.set({ note: text });
  // An email, as a literal and from the signed-in person.
  // @ts-expect-error a string literal isn't Safe either: only `literal(...)` makes one
  event.set({ email: "ada@example.com" });
  // @ts-expect-error
  event.set({ email: identity.email });
  // @ts-expect-error a provider account id
  event.set({ who: identity.sub });
  // A token, a key or a URL with its query.
  // @ts-expect-error
  event.set({ token });
  // @ts-expect-error
  event.set({ authorization: `Bearer ${token}` });
  // @ts-expect-error
  event.set({ url });
  // Nested, in a list, or in an object field.
  // @ts-expect-error
  event.set({ ids: [token] });
  // @ts-expect-error
  event.set({ poppy: { issuer: url } });
  // @ts-expect-error
  const field: Field = text;
  void field;
  // When the event is made, or a unit started.
  // @ts-expect-error
  wideEvent("job", { job: text });
  // @ts-expect-error
  void plainUnits.job({ schedule_id: token }, async () => undefined);
  // @ts-expect-error a frame's name
  void plainUnits.frame(text, {}, async () => undefined);
  // An error's code and step, and a handled failure's source.
  // @ts-expect-error
  event.fail(new Error("x"), { code: token });
  // @ts-expect-error
  event.fail(new Error("x"), { step: text });
  // @ts-expect-error
  reportError(new Error("x"), { source: text });
  // A Poppy exchange's issuer and error.
  // @ts-expect-error
  recordPoppyExchange({ issuer: url, step: literal("discovery"), status: 200, error: null, outcome: literal("ok") });
  // @ts-expect-error
  recordPoppyExchange({ issuer: origin(url) ?? null, step: literal("discovery"), status: 400, error: text, outcome: literal("error") });
  // A tool call's name and outcome.
  // @ts-expect-error
  const call: ToolCall = { name: text, outcome: literal("success"), duration_ms: 0 };
  void call;
  // A counter's name is written in our code too.
  // @ts-expect-error
  event.count(text);
  // A field read back is Safe; a string built from one isn't.
  const route = event.fields.route;
  // @ts-expect-error
  if (typeof route === "string") event.set({ route: `${route}?q=${text}` });
}

export function literalTakesOnlyClosedSets(text: string, token: string, lane: "demo" | "own_key" | "none"): void {
  // A literal, or a union of them, written in our code.
  literal("refused");
  literal(lane);
  literal(`refused_${lane}`);
  // @ts-expect-error a string
  literal(text);
  // @ts-expect-error a template with a hole
  literal(`refused_${token}`);
  // @ts-expect-error
  literal(`${text}`);
}

export function constructorsMakeSafeValues(event: WideEvent, text: string, url: string, error: unknown): void {
  // Each constructor checks its value at run time and gives undefined for one it refuses.
  const fields: Record<string, Safe | undefined> = {
    outcome: literal("success"),
    error_code: code(text),
    operation_id: id(text),
    issuer: origin(url),
    tool: toolName(text),
    message: message(error instanceof Error ? error.message : text)
  };
  event.set(fields);
  event.set({ tools_used: join([literal("calculate"), literal("now")], " "), count: 1, blocking: false, pool: null });
  event.fail(error, { code: literal("config"), step: literal("web_push") });
}
