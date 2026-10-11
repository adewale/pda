import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptMessage } from "../../src/protocol";
import type { ActivityEntry, ActivityTask, Card, PoppyClientFrame } from "../../src/poppy/wire";
import { Workspace } from "../../src/ui/shell";
import type { PiSession, PoppyView } from "../../src/use-pi-session";

/**
 * The signed-in page (`src/ui/shell.tsx`) with a fixture in place of the
 * WebSocket: the rail and its four places, the tray of things that need the
 * User, the Activity and Companies pages, and Settings. Every frame a click
 * sends is recorded, and nothing is sent without one.
 */

const IDENTITY = { email: "ada@example.com", provider: "google" as const };

const approval: Card = {
  id: "approval-1",
  kind: "approval",
  company: "Acme",
  open: true,
  approvalId: "ap_42",
  summary: "Acme: submit the form #checkout on the website",
  status: "pending"
};

const signIn: Card = {
  id: "signin-1",
  kind: "signin_link",
  company: "Globex",
  open: true,
  signInId: "s1",
  url: "https://auth.globex.example/authorize",
  scopes: [{ scope: "poppy:read", description: "View account information" }],
  reason: "To see your orders"
};

const done: Card = { id: "notice-1", kind: "notice", company: "Acme", open: false, text: "Signed in to Acme." };

function session(patch: Partial<PiSession> = {}, poppy: Partial<PoppyView> = {}) {
  const sent: PoppyClientFrame[] = [];
  const submitted: string[] = [];
  const value: PiSession = {
    messages: [],
    live: null,
    running: false,
    tools: [],
    queued: 0,
    retry: null,
    model: { provider: "anthropic", modelId: "anthropic/claude-opus-5-5" },
    error: null,
    status: "open",
    catalog: [],
    poppy: { cards: [], accounts: [], permissions: [], direct: {}, activity: null, ...poppy },
    submit: (text: string) => void submitted.push(text),
    abort: () => undefined,
    reset: () => undefined,
    sendPoppy: (frame: PoppyClientFrame) => void sent.push(frame),
    ...patch
  } as PiSession;
  return { value, sent, submitted };
}

function open(path: string, fixture = session()) {
  window.history.replaceState(null, "", path);
  const result = render(<Workspace identity={IDENTITY} session={fixture.value} />);
  return { ...result, ...fixture };
}

beforeEach(() => {
  document.title = "Personal agent";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/poppy/client.json"
        ? Response.json({ client_id: "https://agent.example/poppy/client.json", client_name: "Durable Personal Agent" })
        : new Response("Not found", { status: 404 })
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("rail", () => {
  it("has the four places, marks the current one, and moves between them without reloading", () => {
    open("/");
    const rail = screen.getByRole("navigation", { name: "Places" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Chat", "Activity", "Companies", "Settings"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/", "/activity", "/companies", "/settings"]);
    expect(within(rail).getByRole("link", { name: "Chat" }).getAttribute("aria-current")).toBe("page");

    fireEvent.click(within(rail).getByRole("link", { name: "Activity" }));
    expect(window.location.pathname).toBe("/activity");
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
    expect(within(rail).getByRole("link", { name: "Activity" }).getAttribute("aria-current")).toBe("page");
    expect(within(rail).getByRole("link", { name: "Chat" }).getAttribute("aria-current")).toBeNull();

    fireEvent.click(within(rail).getByRole("link", { name: "Companies" }));
    expect(screen.getByRole("heading", { level: 1, name: "Companies" })).toBeTruthy();

    // Back goes back.
    act(() => {
      window.history.back();
    });
    return waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeTruthy());
  });

  it("opens straight to a place from its address", () => {
    open("/settings");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
  });

  it("leaves a modified click to the browser, so the place can open in a new tab", () => {
    open("/");
    const link = screen.getByRole("link", { name: "Activity" });
    // fireEvent returns false when the page called preventDefault.
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(screen.queryByRole("heading", { level: 1, name: "Activity" })).toBeNull();
    expect(fireEvent.click(link)).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
  });

  it("shows who is signed in and a way to sign out, and no model or connection chips", () => {
    const { container } = open("/");
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(signOut.closest("form")!.getAttribute("action")).toBe("/logout");
    expect(signOut.closest("form")!.getAttribute("method")).toBe("post");
    expect(container.textContent).not.toMatch(/Live|Claude Opus|Powered by|Cloudflare/);
  });
});

describe("needs-you tray", () => {
  it("is pinned above the conversation, counts what needs the User, and puts the count in the rail and the title", () => {
    const fixture = session(
      { messages: Array.from({ length: 30 }, (_, index): TranscriptMessage => ({ id: `m${index}`, role: "user", parts: [{ type: "text", text: `message ${index}` }], timestamp: index })) },
      { cards: [approval, signIn, done] }
    );
    open("/", fixture);
    const tray = screen.getByRole("region", { name: /Needs you/ });
    expect(within(tray).getByRole("heading", { name: /Needs you/ }).textContent).toBe("Needs you2");
    expect(within(tray).getByText("Acme: submit the form #checkout on the website")).toBeTruthy();
    expect(within(tray).getByRole("link", { name: /Sign in on Globex's page/ })).toBeTruthy();

    // Pinned: outside the part that scrolls, and before it.
    const transcript = screen.getByText("message 0").closest(".overflow-y-auto")!;
    expect(transcript.contains(tray)).toBe(false);
    expect(tray.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The resolved notice is a receipt in the conversation, not in the tray.
    expect(within(tray).queryByText("Signed in to Acme.")).toBeNull();
    expect(within(transcript as HTMLElement).getByText("Signed in to Acme.")).toBeTruthy();

    expect(screen.getByRole("link", { name: /^Chat\s*, 2 things need you$/ })).toBeTruthy();
    expect(document.title).toBe("(2) Personal agent");
  });

  it("sends a decision only on a click", () => {
    const { sent } = open("/", session({}, { cards: [approval] }));
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent).toEqual([{ type: "poppy.approval", approvalId: "ap_42", decision: "approve" }]);
  });

  it("holds failures that need the User until they dismiss them", () => {
    const failed: Card = { id: "error-1", kind: "notice", company: "", open: false, text: "That didn't work: Acme is unreachable" };
    const { sent } = open("/", session({}, { cards: [failed] }));
    const tray = screen.getByRole("region", { name: /Needs you/ });
    expect(within(tray).getByText(/Acme is unreachable/)).toBeTruthy();
    fireEvent.click(within(tray).getByRole("button", { name: "Dismiss" }));
    expect(sent).toEqual([{ type: "poppy.card.dismiss", id: "error-1" }]);
  });

  it("isn't there, and the title has no count, when nothing needs the User", () => {
    open("/", session({}, { cards: [done] }));
    expect(screen.queryByRole("region", { name: /Needs you/ })).toBeNull();
    expect(document.title).toBe("Personal agent");
    expect(screen.getByRole("link", { name: "Chat" })).toBeTruthy();
  });

  it("keeps a hidden Direct Conversation one click away", () => {
    const fixture = session({}, { direct: { c1: { conversationId: "c1", company: "Acme", status: "open", responder: "human", messages: [] } } });
    open("/", fixture);
    const sheet = screen.getByRole("complementary", { name: "Conversation with Acme" });
    expect(within(sheet).getByText("A person at Acme is answering · Your words go as written, from you")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Hide conversation" }));
    expect(screen.queryByRole("complementary", { name: "Conversation with Acme" })).toBeNull();
    expect(document.title).toBe("(1) Personal agent");
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(screen.getByRole("complementary", { name: "Conversation with Acme" })).toBeTruthy();
    expect(fixture.sent).toEqual([]);
  });
});

describe("chat", () => {
  it("says what the agent can do before the first message", () => {
    open("/");
    expect(screen.getByRole("heading", { name: "Your agent works with companies for you" })).toBeTruthy();
    for (const text of [/finds the company/i, /sign in on the company's own page/i, /only with your approval/i, /keeps working while you're away/i]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });

  it("shows a Poppy tool call as one readable line, with the raw call behind Details", () => {
    const messages: TranscriptMessage[] = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Where's my order?" }], timestamp: 1 },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "tool-call", id: "call_1", name: "poppy_api_call", arguments: { domain: "acme.example", operation: "GET /orders" } },
          { type: "tool-call", id: "call_2", name: "read_file", arguments: { path: "notes.txt" } }
        ],
        timestamp: 2
      },
      {
        id: "3",
        role: "tool",
        parts: [{ type: "tool-result", id: "call_1", name: "poppy_api_call", content: [{ type: "text", text: '{"status":200,"body":{"orders":[]}}' }], details: { status: 200, body: { orders: [] } }, error: false }],
        timestamp: 3
      },
      { id: "4", role: "tool", parts: [{ type: "tool-result", id: "call_2", name: "read_file", content: [{ type: "text", text: "hello" }], error: false }], timestamp: 4 }
    ];
    const { container } = open("/", session({ messages }));
    expect(screen.getByText("Read orders at acme.example")).toBeTruthy();
    expect(screen.getByText(/· API · view access/)).toBeTruthy();
    // The raw call and result only on request.
    expect(container.textContent).not.toContain('"operation"');
    const details = screen.getAllByRole("button", { name: "Details" });
    expect(details).toHaveLength(2);
    fireEvent.click(details[0]!);
    expect(details[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain('"operation": "GET /orders"');
    // Other tools keep a compact card with their own name.
    expect(container.querySelector('[data-tool="read_file"]')!.textContent).toContain("read_file");
    // The result is shown once, with its call, not again on its own.
    expect(container.querySelectorAll('[data-tool="poppy_api_call"]')).toHaveLength(1);
  });

  it("shows a single status while the agent works, and no streaming cursor", () => {
    const { container } = open("/", session({ running: true, tools: [{ callId: "c", name: "poppy_discover", output: "" }] }));
    expect(screen.getAllByRole("status").filter((node) => node.textContent?.includes("Working"))).toHaveLength(1);
    expect(container.querySelector(".streaming-cursor")).toBeNull();
    expect(container.querySelectorAll(".animate-spin, [class*='animate-pulse']").length).toBeLessThanOrEqual(1);
  });

  it("offers to send a message again when the model fails", () => {
    const messages: TranscriptMessage[] = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }], timestamp: 1 },
      { id: "2", role: "assistant", parts: [], timestamp: 2, error: "x-api-key header is required" }
    ];
    const { submitted } = open("/", session({ messages }));
    expect(screen.getByRole("alert").textContent).toContain("x-api-key header is required");
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    expect(submitted).toEqual(["Hello"]);
  });

  it("says quietly when it isn't connected, and why sending waits", () => {
    open("/", session({ status: "closed" }));
    expect(screen.getByRole("status").textContent).toMatch(/Reconnecting to your agent/);
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("You can send once your agent is connected.")).toBeTruthy();
  });
});

describe("activity page", () => {
  it("shows placeholders until the agent sends its activity", () => {
    open("/activity");
    expect(screen.getByRole("status", { name: "Loading what's in progress" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading the log" })).toBeTruthy();
  });

  it("says what each empty part is for", () => {
    open("/activity", session({}, { activity: { inProgress: [], log: [] } }));
    expect(screen.getByText("Nothing running")).toBeTruthy();
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  it("lists work in progress with a way to stop it, and the log with how and who decided", () => {
    const now = Date.now();
    const inProgress: ActivityTask[] = [
      {
        id: "signin-1",
        kind: "device_sign_in",
        issuer: "https://auth.acme.example",
        company: "Acme",
        what: "Waiting for you to sign in at Acme on another device",
        since: now - 60_000,
        until: now + 4 * 60_000 + 30_000,
        stop: { type: "poppy.signin.cancel", signInId: "s1" }
      },
      {
        id: "conversation-c1",
        kind: "conversation",
        issuer: "https://auth.acme.example",
        company: "Acme",
        what: "Listening for replies from Acme's agent",
        since: now - 120_000,
        stop: { type: "poppy.direct.close", conversationId: "c1" }
      }
    ];
    const log: ActivityEntry[] = [
      {
        id: "op-1",
        at: now - 5_000,
        kind: "operation",
        issuer: "https://auth.acme.example",
        company: "Acme",
        account: "a***@example.com",
        what: "Acme proposed",
        quote: "Exchange the blue jumper for size L.",
        quoteBy: "company",
        how: "api",
        access: "view_and_change",
        decidedBy: "standing_permission",
        result: "done",
        outcome: "Exchange booked.",
        outcomeBy: "company"
      }
    ];
    const { sent } = open("/activity", session({}, { activity: { inProgress, log } }));
    const running = screen.getByRole("list", { name: "In progress" });
    expect(within(running).getByText(/Expires in 4:(29|30)/)).toBeTruthy();
    fireEvent.click(within(running).getByRole("button", { name: "Cancel sign-in" }));
    fireEvent.click(within(running).getByRole("button", { name: "End conversation" }));
    expect(sent).toEqual([
      { type: "poppy.signin.cancel", signInId: "s1" },
      { type: "poppy.direct.close", conversationId: "c1" }
    ]);

    const row = within(screen.getByRole("table")).getAllByRole("row")[1]!;
    expect(within(row).getByText("Acme proposed “Exchange the blue jumper for size L.”")).toBeTruthy();
    expect(within(row).getByText("Acme says: Exchange booked.")).toBeTruthy();
    expect(within(row).getByText("view and change access")).toBeTruthy();
    expect(within(row).getByText(/^API · view and change access · Decided by: Standing permission$/)).toBeTruthy();
    expect(within(row).getByText("Standing permission")).toBeTruthy();
    expect(within(row).getByText("Done")).toBeTruthy();
  });

  it("renders only the fields it knows, so nothing secret-looking can reach the page", () => {
    const entry = {
      id: "signin-2",
      at: Date.now(),
      kind: "sign_in",
      issuer: "https://auth.acme.example",
      company: "Acme",
      account: null,
      what: "Sign-in at Acme on its own page",
      how: "sign_in",
      access: "view",
      decidedBy: "you",
      result: "done",
      token: "tok_SECRET_123",
      secret: "sealed_SECRET_456",
      device_code: "dc_SECRET_789",
      password: "hunter2"
    } as unknown as ActivityEntry;
    const task = {
      id: "t",
      kind: "conversation",
      issuer: "https://auth.acme.example",
      company: "Acme",
      what: "Listening for replies from Acme's agent",
      since: Date.now(),
      code: "123456"
    } as unknown as ActivityTask;
    const { container } = open("/activity", session({}, { activity: { inProgress: [task], log: [entry] } }));
    expect(screen.getByText("Sign-in at Acme on its own page")).toBeTruthy();
    for (const value of ["tok_SECRET_123", "sealed_SECRET_456", "dc_SECRET_789", "hunter2", "123456"]) {
      expect(container.innerHTML).not.toContain(value);
    }
    // A task without a stop frame offers no button.
    expect(within(screen.getByRole("list", { name: "In progress" })).queryByRole("button")).toBeNull();
  });
});

describe("companies page", () => {
  const accounts = [{ issuer: "https://auth.acme.example", company: "Acme", account: "a***@example.com", scope: "poppy:read poppy:write", expiresAt: null }];

  it("opens a Company from the table, with its own address, and ends an open conversation", () => {
    const activity = {
      inProgress: [
        {
          id: "conversation-c1",
          kind: "conversation" as const,
          issuer: "https://auth.acme.example",
          company: "Acme",
          what: "Listening for replies from Acme's agent",
          since: Date.now(),
          stop: { type: "poppy.direct.close" as const, conversationId: "c1" }
        }
      ],
      log: []
    };
    const { sent } = open("/companies", session({}, { accounts, activity }));
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Acme" }));
    expect(window.location.search).toBe(`?company=${encodeURIComponent("https://auth.acme.example")}`);
    expect(screen.getByRole("heading", { level: 1, name: "Acme" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out of Acme" }));
    expect(sent).toEqual([
      { type: "poppy.direct.close", conversationId: "c1" },
      { type: "poppy.signout", issuer: "https://auth.acme.example", account: "a***@example.com" }
    ]);
  });

  it("says what will appear when there are no Companies", () => {
    open("/companies");
    expect(screen.getByText("No Companies yet")).toBeTruthy();
  });
});

describe("settings page", () => {
  it("shows the account, the model and the agent's public identity, read-only", async () => {
    open("/settings");
    expect(screen.getByText(/Signed in as/).textContent).toBe("Signed in as ada@example.com with Google.");
    expect(screen.getByRole("button", { name: "Sign out of this agent" })).toBeTruthy();
    expect(screen.getByText("Claude Opus 5.5")).toBeTruthy();
    expect(screen.getByText("anthropic/claude-opus-5-5")).toBeTruthy();
    expect(await screen.findByText("https://agent.example/poppy/client.json")).toBeTruthy();
    expect(screen.getByText("Durable Personal Agent")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says where the identity lives when this address doesn't serve it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
    open("/settings");
    expect(await screen.findByText(/served only at the agent's public address/)).toBeTruthy();
  });

  it("switches the theme and remembers it", () => {
    // Node's own (disabled) localStorage hides happy-dom's, so give the page one.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    });
    open("/settings");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "Match this device" }));
    expect(localStorage.getItem("theme")).toBeNull();
  });
});
