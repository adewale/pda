/**
 * Helpers for tests that drive the Worker as a browser would: identities,
 * session cookies, the chat WebSocket, and a view folded from its frames.
 */
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { Provider } from "../src/config";
import type { PiServerMessage } from "../src/protocol";
import { createSession, type Identity } from "../src/session";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../src/view";
import worker from "./worker";

export const ORIGIN = "https://agent.example.com";

/** A Google Workspace account at an allowlisted domain, or an allowlisted GitHub id. */
export function person(sub = `user-${crypto.randomUUID()}`, provider: Provider = "google"): Identity {
  return provider === "google"
    ? { provider, sub, email: `${sub}@workspace.example`, domain: "workspace.example" }
    : { provider, sub, email: `${sub}@example.com`, domain: null };
}

/** `name=value` from a `Set-Cookie` header, ready for a `Cookie` header. */
export function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

export async function sessionCookie(identity: Identity, now?: number): Promise<string> {
  return cookiePair(await createSession(identity, env.SESSION_SECRET, now));
}

export function wsRequest(
  init: { cookie?: string; origin?: string; upgrade?: boolean; query?: string } = {}
): Request {
  const headers = new Headers();
  if (init.upgrade !== false) headers.set("Upgrade", "websocket");
  headers.set("Origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("Cookie", init.cookie);
  return new Request(`${ORIGIN}/ws${init.query ?? ""}`, { headers });
}

export async function fetchWorker(request: Request, overrides: Partial<Env> = {}) {
  return worker.fetch(request, { ...env, ...overrides });
}

/** Folds every `events` frame into a view, as the browser hook does. */
export function follow(socket: WebSocket) {
  let view: PiSessionView = EMPTY_VIEW;
  const frames: Array<PiServerMessage | { type: string; name?: string }> = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as PiServerMessage | { type: string };
    frames.push(message);
    if (message.type === "events") {
      view = reduceEvents(
        view,
        (message as Extract<PiServerMessage, { type: "events" }>).events
      );
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    if (!check()) throw new Error("Condition never held");
  };
  const texts = () =>
    view.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "text" ? [`${message.role}: ${part.text}`] : []
      )
    );
  return { view: () => view, frames, until, texts };
}

export async function connect(identity: Identity | string, query = "") {
  const cookie = typeof identity === "string" ? identity : await sessionCookie(identity);
  const response = await fetchWorker(wsRequest({ cookie, query }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const client = follow(socket);
  await client.until(() => client.frames.some((f) => f.type === "events"));
  return { socket, client };
}

export async function chat(
  socket: WebSocket,
  client: ReturnType<typeof follow>,
  text: string,
  expected?: string
) {
  socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: text }));
  // Without an expected answer, any turn number will do: the agent may have history.
  await client.until(() =>
    expected === undefined
      ? client.texts().some((t) => t.startsWith(`assistant: echo: ${text} (turn `))
      : client.texts().includes(`assistant: ${expected}`)
  );
  await client.until(() => !client.view().running);
}
