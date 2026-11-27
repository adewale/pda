import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toIssuer } from "../../src/poppy/issuer";
import type { Card } from "../../src/poppy/wire";
import { CONNECTING, NOT_SENT } from "../../src/ui/connection";
import { Workspace } from "../../src/ui/shell";
import { usePiSession } from "../../src/use-pi-session";

/**
 * The page and its socket together: the real `usePiSession` and page, with
 * a fake socket in place of `useAgent`'s. A message the User sends is never
 * lost, whether the socket is still connecting, open, or drops before the
 * agent answers, and Enter and the Send button behave the same. A card's
 * action is never queued, and never lost silently either.
 */

type Handlers = {
  shouldReconnectOnClose?: (event: CloseEvent) => boolean;
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onMessage?: (event: MessageEvent) => void;
};

type Frame = { readonly type: string; readonly [key: string]: unknown };

/** The page's socket, connecting until a test opens it. It refuses a send while it isn't open, so a frame can't vanish into it. */
class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  handlers: Handlers = {};
  readonly frames: Frame[] = [];
  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("A frame was sent on a socket that isn't open");
    this.frames.push(JSON.parse(data) as Frame);
  }
  open() {
    act(() => {
      this.readyState = WebSocket.OPEN;
      this.handlers.onOpen?.(new Event("open"));
    });
  }
  close(code = 1006, reason = "Network interruption") {
    act(() => {
      this.readyState = WebSocket.CLOSED;
      this.handlers.onClose?.(new CloseEvent("close", { code, reason }));
    });
  }
  receive(frame: Frame) {
    act(() => this.handlers.onMessage?.(new MessageEvent("message", { data: JSON.stringify(frame) })));
  }
  submits() {
    return this.frames.filter((frame) => frame.type === "submit");
  }
}

let socket: FakeSocket;

/** The entries of the last view the page was sent, so an append lands at its end. */
let viewEntries: object[] = [];

/** The agent's view of the session, as a watch starts with it: these entries, nothing running. */
function view(...entries: object[]) {
  viewEntries = entries;
  socket.receive({ type: "view", session: "1", view: { conversation: { id: 1 }, entries, docs: { "pi.live": {} } } });
}

/** pi's operations for an entry appended to the view. */
function appended(entry: object) {
  socket.receive({ type: "ops", session: "1", ops: [["p", ["entries"], viewEntries.length, 0, [entry]]] });
  viewEntries = [...viewEntries, entry];
}

/** pi's operations for a run that starts, or ends. */
function runStarts() {
  socket.receive({ type: "ops", session: "1", ops: [["s", ["docs", "pi.live", "run"], { taskId: 1, inputs: [], turns: 0 }]] });
}
function runEnds() {
  socket.receive({ type: "ops", session: "1", ops: [["d", ["docs", "pi.live", "run"]]] });
}

vi.mock("agents/react", () => ({
  useAgent: (options: Handlers) => {
    socket.handlers = options;
    return socket;
  }
}));

function Page() {
  return <Workspace identity={{ email: "ada@example.com", provider: "google" }} session={usePiSession("workspace-a")} />;
}

const box = () => screen.getByRole("textbox", { name: "Message your agent" }) as HTMLTextAreaElement;

const SEND_WITH = {
  Enter: () => fireEvent.keyDown(box(), { key: "Enter" }),
  "the Send button": () => fireEvent.click(screen.getByRole("button", { name: "Send message" }))
};

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

beforeEach(() => {
  socket = new FakeSocket();
  viewEntries = [];
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/me" ? Response.json({ workspaceId: "workspace-a" }) : new Response("Not found", { status: 404 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a browser session that no longer has access", () => {
  it("stops retrying a policy close, preserves pending text and drafts, and offers explicit sign-in recovery", () => {
    render(<Page />);
    socket.open();
    type("Pending message to preserve");
    SEND_WITH.Enter();
    type("Unsent draft to preserve");
    socket.close(1008, "Sign in again");
    expect(screen.getByText("This connection no longer has access. Sign in again to continue.")).toBeTruthy();
    expect(screen.queryByText(/Reconnecting to your agent/)).toBeNull();
    expect(screen.getByText("Pending message to preserve")).toBeTruthy();
    expect(box().value).toBe("Unsent draft to preserve");
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Reload and check sign-in" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("button", { name: "Copy pending messages" })).toBeTruthy();
    expect(socket.handlers.shouldReconnectOnClose?.(new CloseEvent("close", { code: 1008 }))).toBe(false);
    expect(socket.handlers.shouldReconnectOnClose?.(new CloseEvent("close", { code: 1006 }))).toBe(false);
    SEND_WITH.Enter();
    expect(box().value).toBe("Unsent draft to preserve");
    expect(socket.submits()).toHaveLength(1);
    // An unexpected later socket open cannot silently flush an old account's text.
    socket.open();
    expect(socket.submits()).toHaveLength(1);
    expect(screen.getByText("This connection no longer has access. Sign in again to continue.")).toBeTruthy();
  });

  it("copies pending messages only on request and keeps the unsent draft separate", async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<Page />);
      type("Queued text to keep");
      SEND_WITH.Enter();
      type("Draft not submitted");
      socket.close(1008, "Sign in again");
      expect(writeText).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Copy pending messages" }));
      expect(await screen.findByText("Pending messages copied. Copy any text still in the message box separately.")).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith("Queued text to keep");
      expect(box().value).toBe("Draft not submitted");
      expect(socket.submits()).toEqual([]);
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("recognizes a rejected reconnect upgrade through an authenticated status check without replaying pending text", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/me" ? new Response(null, { status: 401 }) : Response.json({ reviews: [] }));
    vi.stubGlobal("fetch", fetcher);
    render(<Page />);
    socket.open();
    type("Keep this pending message");
    SEND_WITH.Enter();
    type("Keep this draft too");
    socket.close(1006, "Upgrade failed");
    expect(await screen.findByText("This connection no longer has access. Sign in again to continue.")).toBeTruthy();
    expect(fetcher.mock.calls.some(([input]) => input === "/api/me")).toBe(true);
    expect(socket.handlers.shouldReconnectOnClose?.(new CloseEvent("close", { code: 1006 }))).toBe(false);
    socket.open();
    expect(socket.submits()).toHaveLength(1);
    expect(screen.getByText("Keep this pending message")).toBeTruthy();
    expect(box().value).toBe("Keep this draft too");
  });

  it("bounds a stalled identity check while retaining the same workspace-bound reconnect operation", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== "/api/me") return Promise.resolve(Response.json({ reviews: [] }));
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")), { once: true }));
      }));
      render(<Page />);
      socket.open();
      type("Keep this operation on a slow auth check");
      SEND_WITH.Enter();
      const original = socket.submits()[0];
      socket.close();
      socket.open();
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(socket.submits()).toEqual([original]);
      await act(async () => { controller.abort(); });
      await waitFor(() => expect(socket.submits()).toEqual([original, original]));
      expect(screen.queryByText("This connection no longer has access. Sign in again to continue.")).toBeNull();
    } finally { timeout.mockRestore(); }
  });

  it("keeps automatic reconnect and operation IDs when a network close still has valid authentication", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/me" ? Response.json({ provider: "google", email: "ada@example.com", workspaceId: "workspace-a" }) : Response.json({ reviews: [] }));
    vi.stubGlobal("fetch", fetcher);
    render(<Page />);
    socket.open();
    type("Retry the same pending operation");
    SEND_WITH.Enter();
    const original = socket.submits()[0];
    socket.close(1006);
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => input === "/api/me")).toBe(true));
    expect(screen.queryByText("This connection no longer has access. Sign in again to continue.")).toBeNull();
    expect(socket.handlers.shouldReconnectOnClose?.(new CloseEvent("close", { code: 1006 }))).toBe(true);
    socket.open();
    await waitFor(() => expect(socket.submits()).toEqual([original, original]));
  });
});

describe("the Companies your agent can contact", () => {
  const remembered = (companies: string[]) => vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    String(input) === "/api/task-companies" ? Response.json({ companies }) : Response.json({ workspaceId: "workspace-a" })));
  const field = () => screen.getByRole("textbox", { name: "Companies your agent can contact" }) as HTMLInputElement;

  it("stays selected for the next message, and photos' upload grants don't", async () => {
    render(<Page />);
    socket.open();
    fireEvent.change(field(), { target: { value: "shop.example, Another.example" } });
    type("First");
    SEND_WITH.Enter();
    await waitFor(() => expect(box().value).toBe(""));
    expect(field().value).toBe("another.example, shop.example");
    type("Yes, the 6x4 please");
    SEND_WITH.Enter();
    await waitFor(() => expect(socket.submits()).toHaveLength(2));
    expect(socket.submits()[1]).toMatchObject({ input: "Yes, the 6x4 please", taskAccess: { companies: ["another.example", "shop.example"], uploads: [] } });
  });

  it("stops at once when the User clears it", async () => {
    render(<Page />);
    socket.open();
    fireEvent.change(field(), { target: { value: "shop.example" } });
    type("First");
    SEND_WITH.Enter();
    await waitFor(() => expect(box().value).toBe(""));
    fireEvent.change(field(), { target: { value: "" } });
    type("Second");
    SEND_WITH.Enter();
    await waitFor(() => expect(socket.submits()).toHaveLength(2));
    expect(socket.submits()[1]).toMatchObject({ taskAccess: { companies: [], uploads: [] } });
  });

  it("shows the saved selection after a reload, and sending is what grants it", async () => {
    remembered(["shop.example"]);
    render(<Page />);
    socket.open();
    await waitFor(() => expect(field().value).toBe("shop.example"));
    expect(socket.submits()).toEqual([]);
    type("Still there?");
    SEND_WITH.Enter();
    await waitFor(() => expect(socket.submits()).toHaveLength(1));
    expect(socket.submits()[0]).toMatchObject({ taskAccess: { companies: ["shop.example"], uploads: [] } });
  });

  it("doesn't let the saved selection replace what the User has typed", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input) === "/api/task-companies" ? new Promise<Response>(resolve => { answer = resolve; }) : Promise.resolve(Response.json({ workspaceId: "workspace-a" }))));
    render(<Page />);
    socket.open();
    fireEvent.change(field(), { target: { value: "typed.example" } });
    await waitFor(() => expect(answer).toBeDefined());
    answer(Response.json({ companies: ["saved.example"] }));
    await new Promise(resolve => setTimeout(resolve));
    expect(field().value).toBe("typed.example");
  });

  it("states no selection when the saved one couldn't be loaded, so it can't erase it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/task-companies" ? new Response("", { status: 503 }) : Response.json({ workspaceId: "workspace-a" })));
    render(<Page />);
    socket.open();
    await new Promise(resolve => setTimeout(resolve));
    type("Quick");
    SEND_WITH.Enter();
    await waitFor(() => expect(socket.submits()).toHaveLength(1));
    expect(socket.submits()[0]).not.toHaveProperty("taskAccess");
  });

  it("states no selection for a message sent before the saved one arrives, so it can't erase it", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input) === "/api/task-companies" ? new Promise<Response>(() => {}) : Promise.resolve(Response.json({ workspaceId: "workspace-a" }))));
    render(<Page />);
    socket.open();
    type("Quick");
    SEND_WITH.Enter();
    await waitFor(() => expect(socket.submits()).toHaveLength(1));
    expect(socket.submits()[0]).not.toHaveProperty("taskAccess");
  });
});

describe("Clear chat", () => {
  const said = (id: number, text: string) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });
  const reset = (id: number) => ({ id, conversationId: 1, kind: "pi.reset", head: id });
  const snapshot = view;
  const resetArrives = (id: number) => appended(reset(id));
  const field = () => screen.getByRole("textbox", { name: "Companies your agent can contact" }) as HTMLInputElement;
  const clear = () => screen.queryByRole("button", { name: "Clear chat" });
  const confirmation = () => screen.queryByRole("group", { name: "Clear chat?" });
  const resets = () => socket.frames.filter((frame) => frame.type === "reset");
  const remembered = (companies: Promise<string[]> | string[]) => vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    String(input) === "/api/task-companies" ? Response.json({ companies: await companies }) : Response.json({ workspaceId: "workspace-a" })));
  const confirm = () => {
    fireEvent.click(clear()!);
    fireEvent.click(within(confirmation()!).getByRole("button", { name: "Clear chat" }));
  };

  it("asks first, sends nothing on Keep it, and resets once on Clear chat", () => {
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    fireEvent.click(clear()!);
    fireEvent.click(within(confirmation()!).getByRole("button", { name: "Keep it" }));
    expect(confirmation()).toBeNull();
    expect(resets()).toEqual([]);
    confirm();
    expect(resets()).toHaveLength(1);
    resetArrives(3);
    expect(screen.getByText("Context reset")).toBeTruthy();
    expect(clear()).toBeNull();
  });

  it("empties the selected Companies when the reset arrives, whichever tab sent it, and not before", async () => {
    remembered(["shop.example"]);
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    await waitFor(() => expect(field().value).toBe("shop.example"));
    confirm();
    // Sent, but the agent hasn't reset: it may yet refuse.
    expect(field().value).toBe("shop.example");
    resetArrives(3);
    expect(field().value).toBe("");
    type("A new demo");
    SEND_WITH.Enter();
    await waitFor(() => expect(socket.submits()).toHaveLength(1));
    expect(socket.submits()[0]).toMatchObject({ taskAccess: { companies: [], uploads: [] } });
  });

  it("follows a reset made in another tab while this one was away, from the reconnect's view", async () => {
    remembered(["shop.example"]);
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    await waitFor(() => expect(field().value).toBe("shop.example"));
    socket.close();
    socket.open();
    await waitFor(() => expect(screen.queryByText(CONNECTING)).toBeNull());
    snapshot(reset(3));
    expect(field().value).toBe("");
  });

  it("keeps the remembered selection when the page loads after a reset", async () => {
    remembered(["shop.example"]);
    render(<Page />);
    socket.open();
    snapshot(reset(3), said(4, "A new demo"));
    await waitFor(() => expect(field().value).toBe("shop.example"));
  });

  it("doesn't let a remembered list that arrives after the reset bring the old selection back", async () => {
    let answer: (companies: string[]) => void = () => undefined;
    remembered(new Promise<string[]>((resolve) => { answer = resolve; }));
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    resetArrives(3);
    await act(async () => answer(["shop.example"]));
    expect(field().value).toBe("");
  });

  it("doesn't let a list remembered before the reset replace one chosen after it", async () => {
    let answer: (companies: string[]) => void = () => undefined;
    remembered(new Promise<string[]>((resolve) => { answer = resolve; }));
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    resetArrives(3);
    fireEvent.change(field(), { target: { value: "new.example" } });
    await act(async () => answer(["shop.example"]));
    expect(field().value).toBe("new.example");
  });

  it("drops a half-made confirmation when something new arrives in the chat", () => {
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    fireEvent.click(clear()!);
    appended(said(3, "Sent from another tab"));
    expect(confirmation()).toBeNull();
    expect(clear()).not.toBeNull();
  });

  it("drops a half-made confirmation when a run starts, rather than showing it again once the run ends", () => {
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    fireEvent.click(clear()!);
    expect(confirmation()).not.toBeNull();
    runStarts();
    expect(clear()).toBeNull();
    runEnds();
    expect(confirmation()).toBeNull();
    expect(clear()).not.toBeNull();
  });

  it("isn't offered while a message waits for the agent's answer", () => {
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    type("Size L");
    SEND_WITH.Enter();
    expect(clear()).toBeNull();
    socket.receive({ type: "error", id: String(socket.submits()[0]!.id), message: "Refused" });
    expect(clear()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(clear()).not.toBeNull();
  });

  it("doesn't send on a socket that has just closed, and says so", () => {
    render(<Page />);
    socket.open();
    snapshot(said(2, "Find me a jumper"));
    socket.readyState = WebSocket.CLOSED;
    confirm();
    expect(resets()).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe(NOT_SENT);
  });
});

describe("sending before the socket is open", () => {
  it("keeps an explicit recipient selection with its original message across reconnect and composer changes", async () => {
    render(<Page />);
    fireEvent.change(screen.getByRole("textbox", { name: "Companies your agent can contact" }), { target: { value: "shop.example" } });
    type("Check my order. Do not contact excluded.example.");
    SEND_WITH.Enter();
    // A later draft must not expand the queued message's authority.
    fireEvent.change(screen.getByRole("textbox", { name: "Companies your agent can contact" }), { target: { value: "excluded.example" } });
    socket.open();
    expect(socket.submits()[0]).toMatchObject({ taskAccess: { companies: ["shop.example"], uploads: [] } });
    const original = socket.submits()[0];
    socket.close();
    socket.open();
    await waitFor(() => expect(socket.submits()).toEqual([original, original]));
  });

  it("rejects a recipient URL carrying credentials or a path before sending", () => {
    render(<Page />);
    socket.open();
    fireEvent.change(screen.getByRole("textbox", { name: "Companies your agent can contact" }), { target: { value: "https://user:password@shop.example/private" } });
    type("Check my order");
    SEND_WITH.Enter();
    expect(socket.submits()).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("Company domain");
    expect(box().value).toBe("Check my order");
  });

  it.each(Object.keys(SEND_WITH) as (keyof typeof SEND_WITH)[])("keeps a message sent with %s, shows it as pending, and sends it once the socket opens", (how) => {
    render(<Page />);
    expect(screen.getByText("Connecting to your agent.")).toBeTruthy();
    type("Book a table for two");
    SEND_WITH[how]();

    // Out of the box, into the chat as pending; nothing on the socket yet.
    expect(box().value).toBe("");
    expect(screen.getByText("Book a table for two")).toBeTruthy();
    expect(screen.getByText("Waiting to connect. It goes once your agent is connected.")).toBeTruthy();
    expect(socket.frames).toEqual([]);

    socket.open();
    expect(socket.frames.map((frame) => frame.type)).toEqual(["watch", "poppy.context", "submit"]);
    const [submit] = socket.submits();
    expect(submit).toMatchObject({ type: "submit", input: "Book a table for two", whenBusy: "followUp" });
    expect(submit!.operationId).toBe(submit!.id);
    expect(screen.getByText("Sending")).toBeTruthy();

    socket.receive({ type: "result", id: String(submit!.id), result: { operationId: String(submit!.id), session: "1", accepted: true } });
    expect(screen.queryByText("Book a table for two")).toBeNull();
    expect(socket.submits()).toHaveLength(1);
  });

  // What was seen live: the page still showed the socket open, the box emptied, and nothing reached the agent.
  it.each(Object.keys(SEND_WITH) as (keyof typeof SEND_WITH)[])(
    "keeps a message sent with %s after the socket stopped being open but before the page heard it close",
    async (how) => {
      render(<Page />);
      socket.open();
      socket.readyState = WebSocket.CLOSED;
      type("Book a table for two");
      SEND_WITH[how]();
      expect(box().value).toBe("");
      expect(screen.getByText("Book a table for two")).toBeTruthy();
      expect(socket.submits()).toEqual([]);

      socket.close();
      expect(screen.getByText("Waiting to connect. It goes once your agent is connected.")).toBeTruthy();
      socket.open();
      await waitFor(() => expect(socket.submits().map((frame) => frame.input)).toEqual(["Book a table for two"]));
    }
  );

  it("keeps a message through a connection that fails before it opens, and sends it once", () => {
    render(<Page />);
    type("Hello");
    SEND_WITH.Enter();
    socket.close();
    expect(screen.getByText("Waiting to connect. It goes once your agent is connected.")).toBeTruthy();
    socket.open();
    expect(socket.submits().map((frame) => frame.input)).toEqual(["Hello"]);
  });
});

describe("sending on an open socket", () => {
  it.each(Object.keys(SEND_WITH) as (keyof typeof SEND_WITH)[])("sends a message at once with %s", (how) => {
    render(<Page />);
    socket.open();
    expect(screen.queryByText("Connecting to your agent.")).toBeNull();
    type("What's on today?");
    SEND_WITH[how]();
    expect(box().value).toBe("");
    expect(socket.submits()).toEqual([expect.objectContaining({ type: "submit", input: "What's on today?", whenBusy: "followUp" })]);
  });

  it("sends nothing for an empty box or Shift+Enter", () => {
    render(<Page />);
    socket.open();
    SEND_WITH.Enter();
    type("first line");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(socket.submits()).toEqual([]);
    expect(box().value).toBe("first line");
  });
});

describe("a socket that drops and reopens", () => {
  it("sends a queued message once, sends again only what the agent didn't answer, with the same operation id, and never one it answered", async () => {
    render(<Page />);
    type("one");
    SEND_WITH.Enter();
    socket.open();
    const one = socket.submits()[0]!;
    socket.receive({ type: "result", id: String(one.id), result: null });

    type("two");
    SEND_WITH["the Send button"]();
    const two = socket.submits()[1]!;
    expect(two.input).toBe("two");
    socket.close();
    expect(screen.getByText("two")).toBeTruthy();

    type("three");
    SEND_WITH.Enter();
    socket.close();
    socket.open();

    await waitFor(() => expect(socket.submits().map((frame) => [frame.input, frame.operationId])).toEqual([
      ["one", one.operationId],
      ["two", two.operationId],
      ["two", two.operationId],
      ["three", expect.any(String)]
    ]));
    for (const frame of socket.submits().slice(2)) socket.receive({ type: "result", id: String(frame.id), result: null });
    expect(screen.queryByText("two")).toBeNull();
    expect(screen.queryByText("three")).toBeNull();

    // A later reconnect sends nothing again.
    socket.close();
    socket.open();
    expect(socket.submits()).toHaveLength(4);
  });
});

/*
 * Decisions and other card actions aren't queued: an Approve replayed after
 * the User has looked away is worse than one refused. While the socket isn't
 * open they are disabled, with a reason; one tried on a socket that has just
 * closed (the page hasn't heard yet) isn't sent, the card stays as it was and
 * says so, and it works once the socket is back.
 */

const approval: Card = {
  id: "approval-1",
  kind: "approval",
  company: "Acme",
  open: true,
  approvalId: "ap_42",
  summary: "Acme: submit the form #checkout on the website",
  status: "pending"
};

const signIn: Card = { id: "signin-4", kind: "signin_code", company: "Acme", open: true, signInId: "s4", sentTo: "a***@example.com" };

/** A Company's terms waiting for the User (Ops 5): an approval card of its own. */
const terms: Card = {
  id: "approval-apr2_7Hq",
  kind: "approval",
  company: "Globex",
  open: true,
  approvalId: "apr2_7Hq",
  summary: "Globex asks for your approval before it does this: Exchange the blue jumper (size M) for size L. No charge.",
  status: "pending",
  terms: { summary: "Exchange the blue jumper (size M) for size L. No charge.", expiresAt: "2026-10-28T12:00:00Z", highlights: ["Cost (price_difference): 0.00 GBP"] }
};

const CARD_ACTIONS = {
  "Approve on an approval": () => fireEvent.click(within(card("Approve this at Acme?")).getByRole("button", { name: "Approve" })),
  "Decline on a Company's terms": () => fireEvent.click(within(card("Approve this at Globex?")).getByRole("button", { name: "Decline" })),
  "a one-time code": () => {
    fireEvent.change(screen.getByRole("textbox", { name: "One-time code" }), { target: { value: "482913" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
  }
};

const CARD_OF: Record<keyof typeof CARD_ACTIONS, string> = {
  "Approve on an approval": "Approve this at Acme?",
  "Decline on a Company's terms": "Approve this at Globex?",
  "a one-time code": "Enter the code from Acme"
};

const FRAME_OF: Record<keyof typeof CARD_ACTIONS, Frame> = {
  "Approve on an approval": { type: "poppy.approval", approvalId: "ap_42", decision: "approve" },
  "Decline on a Company's terms": { type: "poppy.approval", approvalId: "apr2_7Hq", decision: "decline" },
  "a one-time code": { type: "poppy.code", signInId: "s4", code: "482913" }
};

function card(title: string): HTMLElement {
  return screen.getByRole("article", { name: title });
}

function cardButtons(title: string): HTMLButtonElement[] {
  return within(card(title)).getAllByRole("button") as HTMLButtonElement[];
}

/** Every frame but the ones the page sends by itself (its watch, locale, presence). */
function decisions() {
  return socket.frames.filter((frame) => frame.type !== "watch" && frame.type !== "poppy.context" && frame.type !== "poppy.activity");
}

/** The page with the three cards, the socket open and the cards delivered. */
function pageWithCards() {
  render(<Page />);
  socket.open();
  socket.receive({ type: "poppy.cards", cards: [approval, signIn, terms] });
}

describe("card actions while the socket isn't open", () => {
  it("disables every card's buttons with a reason, and sends nothing", () => {
    pageWithCards();
    socket.close();
    for (const title of Object.values(CARD_OF)) {
      expect(cardButtons(title).every((button) => button.disabled)).toBe(true);
      expect(within(card(title)).getByRole("status").textContent).toBe(CONNECTING);
    }
    for (const act of Object.values(CARD_ACTIONS)) act();
    expect(decisions()).toEqual([]);
  });

  it("enables them again once it reopens", async () => {
    pageWithCards();
    socket.close();
    socket.open();
    await waitFor(() => expect(cardButtons(CARD_OF["Approve on an approval"]).some(button => !button.disabled)).toBe(true));
    for (const title of Object.values(CARD_OF)) {
      expect(cardButtons(title).some((button) => button.disabled)).toBe(false);
      expect(within(card(title)).queryByRole("status")).toBeNull();
    }
  });
});

describe("card actions on a socket that has just closed, before the page heard", () => {
  it.each(Object.keys(CARD_ACTIONS) as (keyof typeof CARD_ACTIONS)[])("doesn't send %s, says so on the card, and sends it once the socket is back", async (what) => {
    pageWithCards();
    socket.readyState = WebSocket.CLOSED;
    CARD_ACTIONS[what]();
    expect(decisions()).toEqual([]);
    expect(within(card(CARD_OF[what])).getByRole("alert").textContent).toBe(NOT_SENT);
    if (what === "a one-time code") expect((screen.getByRole("textbox", { name: "One-time code" }) as HTMLInputElement).value).toBe("482913");

    socket.close();
    socket.open();
    await waitFor(() => expect(cardButtons(CARD_OF[what]).some(button => !button.disabled)).toBe(true));
    expect(within(card(CARD_OF[what])).getByRole("alert").textContent).toBe(NOT_SENT);
    if (what === "a one-time code") fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    else CARD_ACTIONS[what]();
    expect(decisions()).toEqual([FRAME_OF[what]]);
    expect(within(card(CARD_OF[what])).queryByRole("alert")).toBeNull();
  });

  it("doesn't send Stop, and says so", () => {
    render(<Page />);
    socket.open();
    view();
    runStarts();
    const stop = screen.queryByRole("button", { name: "Stop the agent" });
    if (!stop) return expect.fail("the agent should be running");
    socket.readyState = WebSocket.CLOSED;
    fireEvent.click(stop);
    expect(socket.frames.filter((frame) => frame.type === "abort")).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe(NOT_SENT);
    socket.close();
    expect((screen.getByRole("button", { name: "Stop the agent" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("settings actions and the socket", () => {
  it("disables Sign out while closed, says Not sent in the stale window, and signs out once the socket is back", async () => {
    const issuer = toIssuer("https://auth.acme.example");
    window.history.replaceState(null, "", `/companies?company=${encodeURIComponent(issuer)}`);
    render(<Page />);
    socket.open();
    socket.receive({ type: "poppy.settings", accounts: [{ issuer, company: "Acme", account: "a***@example.com", scope: "orders:read", expiresAt: null }], signOuts: [], instructions: [] });
    const signOut = () => screen.getByRole("button", { name: "Sign out of Acme" }) as HTMLButtonElement;

    socket.close();
    expect(signOut().disabled).toBe(true);
    expect(screen.getAllByText(CONNECTING).length).toBeGreaterThan(0);

    socket.open();
    await waitFor(() => expect(signOut().disabled).toBe(false));
    socket.readyState = WebSocket.CLOSED;
    fireEvent.click(signOut());
    expect(decisions()).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe(NOT_SENT);

    socket.close();
    socket.open();
    await waitFor(() => expect(signOut().disabled).toBe(false));
    fireEvent.click(signOut());
    expect(decisions()).toEqual([{ type: "poppy.signout", issuer, account: "a***@example.com" }]);
  });
});

describe("card actions on an open socket", () => {
  it.each(Object.keys(CARD_ACTIONS) as (keyof typeof CARD_ACTIONS)[])("sends %s at once, with no note", (what) => {
    pageWithCards();
    CARD_ACTIONS[what]();
    expect(decisions()).toEqual([FRAME_OF[what]]);
    expect(screen.queryByRole("alert")).toBeNull();
    if (what === "a one-time code") expect((screen.getByRole("textbox", { name: "One-time code" }) as HTMLInputElement).value).toBe("");
  });
});

describe("a message the agent refuses", () => {
  it("stays in the chat with the reason, and Try again sends it with the same operation id", () => {
    render(<Page />);
    socket.open();
    type("Plan my week");
    SEND_WITH.Enter();
    const first = socket.submits()[0]!;
    socket.receive({ type: "error", id: String(first.id), message: "Unknown pi session 7" });
    expect(screen.getByRole("alert").textContent).toContain("Your agent didn't take this message: Unknown pi session 7");
    expect(screen.getByText("Plan my week")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(socket.submits().map((frame) => frame.operationId)).toEqual([first.operationId, first.operationId]);
    socket.receive({ type: "result", id: String(first.id), result: null });
    expect(screen.queryByText("Plan my week")).toBeNull();
  });

  it("drops it on Remove, and never sends it", () => {
    render(<Page />);
    socket.open();
    type("Plan my week");
    SEND_WITH.Enter();
    const first = socket.submits()[0]!;
    socket.receive({ type: "error", id: String(first.id), message: "Unknown pi session 7" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("Plan my week")).toBeNull();
    socket.close();
    socket.open();
    expect(socket.submits()).toHaveLength(1);
  });
});

describe("the conversation's history", () => {
  const said = (id: number, text: string) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });
  const pages = () => socket.frames.filter((frame) => frame.type === "entries");
  const answer = (page: Frame, items: object[], next?: string) =>
    socket.receive({ type: "result", id: String(page.id), result: { items, ...(next === undefined ? {} : { next }) } });
  const shown = (text: string) => screen.queryByText(text) !== null;

  it("loads the entries before the view's window, a page at a time, until the start", async () => {
    render(<Page />);
    socket.open();
    socket.receive({ type: "view", session: "1", view: { conversation: { id: 1 }, entries: [said(60, "Newest")], before: 59, docs: { "pi.live": {} } } });
    await waitFor(() => expect(pages()).toHaveLength(1));
    expect(pages()[0]).toMatchObject({ query: { maxEntryId: 59, order: "descending" } });
    answer(pages()[0]!, [said(59, "Older"), said(58, "Oldest")], "more");
    await waitFor(() => expect(pages()).toHaveLength(2));
    expect(pages()[1]).toMatchObject({ query: { maxEntryId: 57, order: "descending" } });
    answer(pages()[1]!, []);
    await waitFor(() => expect(shown("Oldest")).toBe(true));
    const text = document.body.textContent!;
    expect(text.indexOf("Oldest")).toBeLessThan(text.indexOf("Older"));
    expect(text.indexOf("Older")).toBeLessThan(text.indexOf("Newest"));
    // At the start: nothing more to ask for.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(pages()).toHaveLength(2);
  });

  it("resumes after the newest entry on a reconnect, and loads the entries it skipped", async () => {
    render(<Page />);
    socket.open();
    socket.receive({ type: "view", session: "1", view: { conversation: { id: 1 }, entries: [said(1, "First"), said(2, "Second")], docs: { "pi.live": {} } } });
    await waitFor(() => expect(shown("Second")).toBe(true));
    socket.close();
    socket.open();
    await waitFor(() => expect(socket.frames.filter((frame) => frame.type === "watch").at(-1)).toEqual({ type: "watch", from: 3 }));
    // More than a window happened while away: the view starts after a gap.
    socket.receive({ type: "view", session: "1", view: { conversation: { id: 1 }, entries: [said(9, "Latest")], before: 8, docs: { "pi.live": {} } } });
    await waitFor(() => expect(pages()).toHaveLength(1));
    expect(pages()[0]).toMatchObject({ query: { minEntryId: 3, maxEntryId: 8, order: "ascending" } });
    answer(pages()[0]!, [said(5, "Missed")]);
    await waitFor(() => expect(shown("Missed")).toBe(true));
    const text = document.body.textContent!;
    expect(text.indexOf("Second")).toBeLessThan(text.indexOf("Missed"));
    expect(text.indexOf("Missed")).toBeLessThan(text.indexOf("Latest"));
  });

  it("asks no more on a socket whose page failed, and tries again on the next", async () => {
    render(<Page />);
    socket.open();
    socket.receive({ type: "view", session: "1", view: { conversation: { id: 1 }, entries: [said(60, "Newest")], before: 59, docs: { "pi.live": {} } } });
    await waitFor(() => expect(pages()).toHaveLength(1));
    socket.receive({ type: "error", id: String(pages()[0]!.id), message: "Invalid maxEntryId" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(pages()).toHaveLength(1);
    socket.close();
    socket.open();
    socket.receive({ type: "view", session: "1", view: { conversation: { id: 1 }, entries: [], before: 60, docs: { "pi.live": {} } } });
    await waitFor(() => expect(pages()).toHaveLength(2));
  });
});

describe("the agent's frames and errors", () => {
  const said = (id: number, text: string) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });
  const field = () => screen.getByRole("textbox", { name: "Companies your agent can contact" }) as HTMLInputElement;

  it("keeps an error the agent reported while the session goes on changing, until a run starts", () => {
    render(<Page />);
    socket.open();
    view(said(2, "Find me a jumper"));
    socket.receive({ type: "error", id: "stop-1", message: "Nothing to stop" });
    expect(screen.getByText(/Your agent reported a problem: Nothing to stop/)).toBeTruthy();
    appended(said(3, "From another tab"));
    expect(screen.getByText(/Your agent reported a problem: Nothing to stop/)).toBeTruthy();
    runStarts();
    expect(screen.queryByText(/Nothing to stop/)).toBeNull();
  });

  it("follows a reset that a reconnect's gap held, though the newest entries came first", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/task-companies" ? Response.json({ companies: ["shop.example"] }) : Response.json({ workspaceId: "workspace-a" })));
    render(<Page />);
    socket.open();
    view(said(2, "Find me a jumper"));
    await waitFor(() => expect(field().value).toBe("shop.example"));
    socket.close();
    socket.open();
    await waitFor(() => expect(screen.queryByText(CONNECTING)).toBeNull());
    // Away long enough for more than a window: the view starts at 40, after a gap.
    socket.receive({ type: "view", session: "1", view: { conversation: { id: 1 }, entries: [said(40, "Latest")], before: 39, docs: { "pi.live": {} } } });
    expect(field().value).toBe("shop.example");
    const page = await waitFor(() => {
      const found = socket.frames.find((frame) => frame.type === "entries");
      if (!found) throw new Error("no page asked for");
      return found;
    });
    // The gap held the other tab's reset.
    socket.receive({ type: "result", id: String(page.id), result: { items: [{ id: 20, conversationId: 1, kind: "pi.reset", head: 20 }] } });
    await waitFor(() => expect(field().value).toBe(""));
  });

  it("ignores a frame that isn't the shape the protocol gives it", () => {
    render(<Page />);
    socket.open();
    view(said(2, "Find me a jumper"));
    socket.receive({ type: "view", session: "1", view: { entries: "not a list", docs: {} } });
    socket.receive({ type: "error", message: 42 });
    expect(screen.getByText("Find me a jumper")).toBeTruthy();
    expect(screen.queryByText(/Your agent reported a problem/)).toBeNull();
  });
});
