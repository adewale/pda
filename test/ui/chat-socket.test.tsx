import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../src/ui/shell";
import { usePiSession } from "../../src/use-pi-session";

/**
 * The chat box and the socket together: the real `usePiSession` and page,
 * with a fake socket in place of `useAgent`'s. A message the User sends is
 * never lost, whether the socket is still connecting, open, or drops before
 * the agent answers, and Enter and the Send button behave the same.
 */

type Handlers = {
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
  close() {
    act(() => {
      this.readyState = WebSocket.CLOSED;
      this.handlers.onClose?.(new Event("close") as CloseEvent);
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
  return <Workspace identity={{ email: "ada@example.com", provider: "google" }} session={usePiSession()} />;
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
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    (how) => {
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
      expect(socket.submits().map((frame) => frame.input)).toEqual(["Book a table for two"]);
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
  it("sends a queued message once, sends again only what the agent didn't answer, with the same operation id, and never one it answered", () => {
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

    expect(socket.submits().map((frame) => [frame.input, frame.operationId])).toEqual([
      ["one", one.operationId],
      ["two", two.operationId],
      ["two", two.operationId],
      ["three", expect.any(String)]
    ]);
    for (const frame of socket.submits().slice(2)) socket.receive({ type: "result", id: String(frame.id), result: null });
    expect(screen.queryByText("two")).toBeNull();
    expect(screen.queryByText("three")).toBeNull();

    // A later reconnect sends nothing again.
    socket.close();
    socket.open();
    expect(socket.submits()).toHaveLength(4);
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
