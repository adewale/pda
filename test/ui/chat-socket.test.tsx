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

describe("sending before the socket is open", () => {
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
    expect(socket.frames.map((frame) => frame.type)).toEqual(["poppy.context", "submit"]);
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

const operation: Card = {
  id: "op-1",
  kind: "operation",
  company: "Globex",
  open: true,
  issuer: toIssuer("https://auth.globex.example"),
  operationId: "op_7Hq",
  revision: 3,
  state: "proposed",
  summary: "Exchange the blue jumper (size M) for size L. No charge.",
  account: "a***@example.com",
  highlights: ["Cost: 0.00 GBP"],
  userApprovalRequired: false
};

const CARD_ACTIONS = {
  "Approve on an approval": () => fireEvent.click(within(card("Approve this at Acme?")).getByRole("button", { name: "Approve" })),
  "Decline on an operation": () => fireEvent.click(within(card("Approve this at Globex?")).getByRole("button", { name: "Decline" })),
  "a one-time code": () => {
    fireEvent.change(screen.getByRole("textbox", { name: "One-time code" }), { target: { value: "482913" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
  }
};

const CARD_OF: Record<keyof typeof CARD_ACTIONS, string> = {
  "Approve on an approval": "Approve this at Acme?",
  "Decline on an operation": "Approve this at Globex?",
  "a one-time code": "Enter the code from Acme"
};

const FRAME_OF: Record<keyof typeof CARD_ACTIONS, Frame> = {
  "Approve on an approval": { type: "poppy.approval", approvalId: "ap_42", decision: "approve" },
  "Decline on an operation": { type: "poppy.operation", issuer: "https://auth.globex.example", operationId: "op_7Hq", revision: 3, decision: "decline" },
  "a one-time code": { type: "poppy.code", signInId: "s4", code: "482913" }
};

function card(title: string): HTMLElement {
  return screen.getByRole("article", { name: title });
}

function cardButtons(title: string): HTMLButtonElement[] {
  return within(card(title)).getAllByRole("button") as HTMLButtonElement[];
}

/** Every frame but the ones the page sends by itself (its locale, presence). */
function decisions() {
  return socket.frames.filter((frame) => frame.type !== "poppy.context" && frame.type !== "poppy.activity");
}

/** The page with the three cards, the socket open and the cards delivered. */
function pageWithCards() {
  render(<Page />);
  socket.open();
  socket.receive({ type: "poppy.cards", cards: [approval, signIn, operation] });
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
    socket.receive({ type: "events", session: "1", events: [{ type: "run_start" }] });
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
    socket.receive({ type: "poppy.settings", accounts: [{ issuer, company: "Acme", account: "a***@example.com", scope: "poppy:read", expiresAt: null }], permissions: [], signOuts: [] });
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
