import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptMessage } from "../../src/protocol";
import type { ActivityEntry, Card, PoppyClientFrame, ProtocolCompany } from "../../src/poppy/wire";
import { Workspace } from "../../src/ui/shell";
import type { PiSession, PoppyView } from "../../src/use-pi-session";
import { reducePoppy } from "../../src/use-pi-session";
import { toIssuer } from "../../src/poppy/issuer";

/**
 * The chat after the print-shop review: each request's outcome on the step
 * that asked for it, nothing pinned under the agent's newest message, notes
 * the agent's code gave the model shown as notes, uploads to one Company
 * decided on one card, and the order card, Companies and Activity that go
 * with them. The photos and the Company are fixtures; nothing is fetched.
 */

const IDENTITY = { email: "ada@example.com", provider: "google" as const };
const SHOP = "Print Shop";
const DOMAIN = "prints.example";
const ISSUER = toIssuer("https://prints.example");
const KEY = `${ISSUER} POST https://api.prints.example/photos`;
const SIGNED = "https://media.prints.example/photo_1/contain?exp=1792709066&sig=abcdefSIGNATURE";

function session(patch: Partial<PiSession> = {}, poppy: Partial<PoppyView> = {}) {
  const sent: PoppyClientFrame[] = [];
  const submitted: string[] = [];
  const value = {
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
    poppy: { cards: [], decisions: {}, accounts: [], signOuts: [], direct: {}, activity: null, protocol: { companies: null, logs: {} }, ...poppy },
    outbox: [],
    submit: (text: string) => void submitted.push(text),
    resend: () => undefined,
    discard: () => undefined,
    abort: () => undefined,
    reset: () => undefined,
    sendPoppy: (frame: PoppyClientFrame) => sent.push(frame) > 0,
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/entitlement"
        ? Response.json({ lane: "own_key", reason: null, key: { provider: "anthropic", status: "valid" }, demo: null, model: null })
        : new Response("Not found", { status: 404 })
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const PHOTOS = [
  { id: "att_lake", name: "lake.jpg", type: "image/jpeg", size: 2_400_000 },
  { id: "att_harbour", name: "harbour.jpg", type: "image/jpeg", size: 1_800_000 },
  { id: "att_meadow", name: "meadow.gif", type: "image/gif", size: 90_000 }
] as const;

const upload = (index: number) => ({ type: "tool-call" as const, id: `call_${index}`, name: "poppy_api_call", arguments: { domain: DOMAIN, operation: "uploadPhoto", files: { photo: PHOTOS[index]!.id } } });
const proposed = (index: number) => ({
  type: "tool-result" as const,
  id: `call_${index}`,
  name: "poppy_api_call",
  content: [{ type: "text" as const, text: `{"proposed":"apr_${index}"}` }],
  details: { proposed: `apr_${index}`, note: "Waiting for the User to approve sending the file on a card; nothing has been sent yet." },
  error: false
});
const discover = {
  type: "tool-result" as const,
  id: "call_d",
  name: "poppy_discover",
  content: [{ type: "text" as const, text: "{}" }],
  details: { company: SHOP, domain: DOMAIN },
  error: false
};

function uploadMessages(count: number, after = "All three are waiting for you."): TranscriptMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Print these as 6×4s" }], timestamp: 1_000 },
    { id: "a0", role: "assistant", parts: [{ type: "tool-call", id: "call_d", name: "poppy_discover", arguments: { domain: DOMAIN } }], timestamp: 1_100 },
    { id: "t0", role: "tool", parts: [discover], timestamp: 1_200 },
    { id: "a1", role: "assistant", parts: Array.from({ length: count }, (_, index) => upload(index)), timestamp: 2_000 },
    { id: "t1", role: "tool", parts: Array.from({ length: count }, (_, index) => proposed(index)), timestamp: 3_000 },
    { id: "a2", role: "assistant", parts: [{ type: "text", text: after }], timestamp: 4_000 }
  ];
}

it("does not claim an upload was sent when its stopped tool has no result", () => {
  const messages = uploadMessages(1).filter(message => message.id !== "t1");
  open("/", session({ messages, running: false, tools: [] }));
  expect(screen.queryByText(`Sent your photo to ${SHOP}`)).toBeNull();
  expect(screen.getByText("Outcome unknown")).toBeTruthy();
});

it("counts three confirmed automatic uploads as three sent photos", () => {
  const messages = uploadMessages(3).map(message => message.id === "t1" ? { ...message, parts: PHOTOS.map((_, index) => ({ ...proposed(index), details: { status: 201, body: { id: `pho_${index}` } }, content: [{ type: "text" as const, text: "Uploaded" }] })) } : message);
  open("/", session({ messages }));
  expect(screen.getByRole("button", { name: `Sent 3 of 3 photos to ${SHOP}` })).toBeTruthy();
  expect(screen.queryByText(`Sent 0 of 3 photos to ${SHOP}`)).toBeNull();
});

it("projects an unknown automatic request onto its originating upload step", () => {
  const messages = uploadMessages(1).map(message => message.id === "t1" ? { ...message, parts: [{ ...proposed(0), error: true, details: { error: "server_error", poppyTask: { id: "req_unknown", result: "unknown" } }, content: [{ type: "text" as const, text: "The upload outcome is unknown" }] }] } : message);
  open("/", session({ messages }));
  expect(screen.getByText("Outcome unknown")).toBeTruthy();
  expect(screen.queryByText("Failed")).toBeNull();
});

it("keeps a durable checked outcome after Activity expires without looping on lookup responses", () => {
  const fixture = session({ messages: uploadMessages(1) }, {
    decisions: { apr_0: { approvalId: "apr_0", company: SHOP, result: "done", outcomeResolution: { outcome: "performed", at: 1000 } } },
    activity: { inProgress: [], log: [] }
  });
  const { container, sent, rerender } = open("/", fixture);
  expect(container.querySelector('[data-tool="poppy_api_call"]')?.getAttribute("data-status")).toBe("done");
  expect(container.textContent).toContain(`You checked with ${SHOP}: this action happened`);
  const reads = () => sent.filter(frame => frame.type === "poppy.approvals.read");
  expect(reads()).toEqual([{ type: "poppy.approvals.read", ids: ["apr_0"] }]);
  const poppy = reducePoppy(fixture.value.poppy, { type: "poppy.approvals.state", ids: ["apr_0"], decisions: Object.values(fixture.value.poppy.decisions) });
  rerender(<Workspace identity={IDENTITY} session={{ ...fixture.value, poppy }} />);
  expect(reads()).toHaveLength(1);
});

function approval(index: number, patch: Partial<Extract<Card, { kind: "approval" }>> = {}): Extract<Card, { kind: "approval" }> {
  const photo = PHOTOS[index]!;
  return {
    id: `approval-apr_${index}`,
    kind: "approval",
    company: SHOP,
    domain: DOMAIN,
    open: true,
    approvalId: `apr_${index}`,
    summary: `Send your photo “${photo.name}” (JPEG, 1 MB) to ${SHOP}: POST /photos (Upload a print photo)`,
    status: "pending",
    attachments: [photo],
    batchKey: KEY,
    at: 3_500,
    ...patch
  };
}

const sentResult = JSON.stringify({ status: 201, body: { id: "photo_A1", name: "Photo 1", width: 4284, height: 5712, lowResolution: false, created: 1792705466332, previews: { contain: SIGNED } } });

describe("a request's outcome, on the step that asked for it", () => {
  it("shows each upload's outcome there, with nothing pinned under the agent's newest message", () => {
    // Decided after the agent's last message, as they are: before, their receipts stacked up under it.
    const cards: Card[] = [
      approval(0, { open: false, status: "done", result: sentResult, at: 10_000 }),
      approval(1, { open: false, status: "done", result: sentResult, at: 10_000 }),
      approval(2, { open: false, status: "refused", answer: { status: 422, error: "invalid_image" }, result: "Sent as you approved, but Print Shop answered 422 (invalid_image).", at: 10_000 })
    ];
    const { container, submitted } = open("/", session({ messages: uploadMessages(3) }, { cards }));
    // Three uploads fold into one line, open because one failed.
    expect(screen.getByText(`Sent 2 of 3 photos to ${SHOP}`)).toBeTruthy();
    expect(screen.getByText(`Sent “lake.jpg” to ${SHOP}`)).toBeTruthy();
    expect(screen.getByText(`Couldn't send “meadow.gif” to ${SHOP}`)).toBeTruthy();
    expect(screen.getByText(/422 invalid_image/)).toBeTruthy();
    // A few facts from what the Company answered, never its raw body or a signed link.
    expect(container.textContent).toContain("4284×5712");
    expect(container.textContent).not.toContain("sig=");
    expect(container.textContent).not.toContain('"status"');
    // No list of resolved requests: the agent's message is the conversation's last word.
    expect(screen.queryByRole("region", { name: "Resolved requests" })).toBeNull();
    expect(container.querySelectorAll("[data-receipt]")).toHaveLength(0);
    const transcript = screen.getByText("All three are waiting for you.").closest(".space-y-6")!;
    expect(transcript.lastElementChild!.textContent).toContain("All three are waiting for you.");
    // The failed photo can be asked for again, in the User's own words.
    fireEvent.click(screen.getByRole("button", { name: "Ask your agent to try again" }));
    expect(submitted).toEqual([`Please try sending “meadow.gif” to ${SHOP} again.`]);
  });

  it("reads Waiting for you until the User decides, then follows the card, then Activity once the card has gone", () => {
    const one = uploadMessages(1, "It's waiting for you.");
    const waiting = open("/", session({ messages: one }, { cards: [approval(0)] }));
    expect(screen.getAllByText(`Asked you to approve sending “lake.jpg” to ${SHOP}`).length).toBeGreaterThan(0);
    expect(waiting.container.querySelector('[data-tool="poppy_api_call"]')!.getAttribute("data-status")).toBe("waiting");
    waiting.unmount();

    const sending = open("/", session({ messages: one }, { cards: [approval(0, { open: false, status: "approved" })] }));
    expect(screen.getByText(`Sending “lake.jpg” to ${SHOP}`)).toBeTruthy();
    sending.unmount();

    // An hour on the card is gone; Activity's log still says how it ended.
    const log: ActivityEntry[] = [
      { id: "approval-apr_0", at: 3_000, kind: "approval", issuer: ISSUER, company: SHOP, account: null, what: "Asked you to approve", quote: "Send your photo", quoteBy: "agent", how: "api", access: "view_and_change", decidedBy: "you", result: "done" }
    ];
    open("/", session({ messages: one }, { cards: [], activity: { inProgress: [], log } }));
    expect(screen.getByText(`Sent your photo to ${SHOP}`)).toBeTruthy();
  });

  it("keeps two steps as two lines and folds three or more, open while any needs a look", () => {
    const two = open("/", session({ messages: uploadMessages(2) }, { cards: [approval(0, { open: false, status: "done", result: sentResult }), approval(1, { open: false, status: "done", result: sentResult })] }));
    expect(two.container.querySelector("[data-steps]")).toBeNull();
    expect(two.container.querySelectorAll('[data-tool="poppy_api_call"]')).toHaveLength(2);
    two.unmount();

    const done = [0, 1, 2].map((index) => approval(index, { open: false, status: "done", result: sentResult }));
    const three = open("/", session({ messages: uploadMessages(3) }, { cards: done }));
    const fold = three.container.querySelector("[data-steps]")!;
    const toggle = within(fold as HTMLElement).getAllByRole("button")[0]!;
    // All sent: folded, and one click opens it.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(three.container.querySelectorAll('[data-tool="poppy_api_call"]')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(three.container.querySelectorAll('[data-tool="poppy_api_call"]')).toHaveLength(3);
  });

  it("links a step to its Company's protocol log in Activity, opened there", () => {
    const protocol = { companies: [{ key: ISSUER, company: SHOP, domain: DOMAIN, issuer: ISSUER, count: 4, lastSeq: 4, lastAt: 3_000 } satisfies ProtocolCompany], logs: {} };
    const { sent } = open("/", session({ messages: uploadMessages(1, "Waiting.") }, { cards: [approval(0)], protocol }));
    const step = document.querySelector('[data-tool="poppy_api_call"]') as HTMLElement;
    fireEvent.click(within(step).getByRole("button", { name: "Details" }));
    fireEvent.click(within(step).getByRole("link", { name: `See every exchange with ${SHOP} in Activity` }));
    expect(window.location.pathname + window.location.search).toBe(`/activity?company=${DOMAIN}`);
    expect(screen.getByRole("button", { name: new RegExp(`Protocol · ${SHOP}`) }).getAttribute("aria-expanded")).toBe("true");
    expect(sent).toContainEqual({ type: "poppy.protocol", key: ISSUER });
  });
});

describe("what the agent's code told the model", () => {
  it("shows a [system] note as a note with its first sentence, never as the User's message, and no signed link even in Details", () => {
    const messages: TranscriptMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Print it" }], timestamp: 1 },
      { id: "n1", role: "user", parts: [{ type: "text", text: `[system] Done, as the User approved: Send your photo “lake.jpg” to ${SHOP}. Result: {"status":201,"body":{"previews":{"contain":"${SIGNED}"}}}` }], timestamp: 2 }
    ];
    const { container } = open("/", session({ messages }));
    expect(screen.getByText(/Your agent was told:/)).toBeTruthy();
    expect(container.textContent).toContain(`Done, as the User approved: Send your photo “lake.jpg” to ${SHOP}.`);
    expect(container.textContent).not.toContain("[system]");
    expect(container.textContent).not.toContain('"status":201');
    fireEvent.click(within(container.querySelector("[data-notice]") as HTMLElement).getByRole("button", { name: "Details" }));
    expect(container.textContent).toContain("https://media.prints.example/photo_1/contain?…");
    expect(container.textContent).not.toContain("sig=");
  });

  it("shows a turn's thinking once, where it starts", () => {
    const messages: TranscriptMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Print it" }], timestamp: 1 },
      { id: "a1", role: "assistant", parts: [{ type: "thinking", text: "First I look up the shop." }, { type: "tool-call", id: "c1", name: "poppy_discover", arguments: { domain: DOMAIN } }], timestamp: 2 },
      { id: "t1", role: "tool", parts: [discover], timestamp: 3 },
      { id: "a2", role: "assistant", parts: [{ type: "thinking", text: "Now the upload." }, { type: "text", text: "Done looking." }], timestamp: 4 }
    ];
    const { container } = open("/", session({ messages }));
    expect(screen.getAllByText("Thinking")).toHaveLength(1);
    expect(container.querySelector("details")!.textContent).toContain("Now the upload.");
  });
});

/** The print shop's terms for an order (Ops 4, 5): the card for that revision, with what the terms name. */
const order = (patch: Partial<Extract<Card, { kind: "approval" }>> = {}): Extract<Card, { kind: "approval" }> => ({
  id: "approval-apr2_order1",
  kind: "approval",
  company: SHOP,
  domain: DOMAIN,
  open: true,
  approvalId: "apr2_order1",
  summary: `${SHOP} asks for your approval before it does this: Print 3 photos as 4×6 lustre prints. Prints $10.00 + shipping $5.00 = $15.00 USD. (Approval needed by 2026-10-28T12:00:00Z.)`,
  status: "pending",
  terms: {
    summary: "Print 3 photos as 4×6 lustre prints. Prints $10.00 + shipping $5.00 = $15.00 USD.",
    expiresAt: "2026-10-28T12:00:00Z",
    highlights: ["Cost (total): 15.00 USD", "The company says this can be undone."],
    total: { amount: "15.00", currency: "USD" },
    previews: [{ label: "items 1 preview", url: "https://prints.example/previews/1" }]
  },
  at: 5_000,
  ...patch
});

describe("the order", () => {
  it("shows the total large and on the button, the Company's words as theirs, and each term lined up", () => {
    const { sent } = open("/", session({}, { cards: [order()] }));
    expect(document.querySelector("[data-total]")!.textContent).toContain("$15.00");
    expect(screen.getByText("Cost (total)").nextElementSibling!.textContent).toBe("15.00 USD");
    expect(screen.getByText(/Print 3 photos as 4×6 lustre prints/).closest("figure")!.textContent).toContain(`${SHOP} says:`);
    const preview = screen.getByRole("link", { name: "items 1 preview" });
    expect(preview.getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByRole("button", { name: "Approve $15.00" }));
    expect(sent).toEqual([{ type: "poppy.approval", approvalId: "apr2_order1", decision: "approve" }]);
  });

  it("puts a finished order in the conversation by its time, quoting the Company's terms, and opens a link the model writes in a new tab", () => {
    const messages: TranscriptMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Order them" }], timestamp: 1_000 },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "The order waits for your approval." }], timestamp: 2_000 },
      { id: "u2", role: "user", parts: [{ type: "text", text: "Thanks, and the tracking?" }], timestamp: 9_000 },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "[Pay at checkout](https://prints.example/checkout/ord_1)" }], timestamp: 9_500 }
    ];
    const card = order({ open: false, status: "done", result: JSON.stringify({ status: 201, body: { id: "ord_1" } }), at: 5_000 });
    const { container } = open("/", session({ messages }, { cards: [card] }));
    const text = container.textContent!;
    const receipt = container.querySelector('[data-receipt="done"]')!;
    expect(receipt.textContent).toContain(`$15.00 · Print 3 photos as 4×6 lustre prints.`);
    expect(receipt.querySelector("figcaption")!.textContent).toBe(`${SHOP} says:`);
    // After the message before it, before the one after it.
    expect(text.indexOf("The order waits for your approval.")).toBeLessThan(text.indexOf("Print 3 photos as 4×6"));
    expect(text.indexOf("Print 3 photos as 4×6")).toBeLessThan(text.indexOf("Thanks, and the tracking?"));
    // The receipt links nothing: a preview was for deciding, and the Company's answer is facts, never a link.
    expect(receipt.querySelector("a")).toBeNull();
    // A link the model writes opens in a new tab, after Streamdown asks, so a checkout never replaces the conversation.
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    fireEvent.click(screen.getByRole("button", { name: "Pay at checkout" }));
    fireEvent.click(screen.getByRole("button", { name: "Open link" }));
    expect(opened).toHaveBeenCalledWith("https://prints.example/checkout/ord_1", "_blank", "noreferrer");
  });
});

describe("uploads decided together", () => {
  it("shows uploads to one Company's same address as one card, sends what's ticked, and declines the rest", () => {
    const other: Card = { ...approval(0), id: "approval-apr_9", approvalId: "apr_9", batchKey: `${ISSUER} POST https://api.prints.example/other`, summary: "Send your photo “lake.jpg” (JPEG, 1 MB) elsewhere" };
    const { sent } = open("/", session({}, { cards: [approval(0), approval(1), approval(2), other] }));
    const panel = screen.getByRole("region", { name: "Needs you" });
    // Two requests: the batch, and the upload that goes somewhere else.
    expect(within(panel).getByRole("heading", { name: "2 requests" })).toBeTruthy();
    expect(within(panel).getByText(`Send 3 photos to ${SHOP}?`)).toBeTruthy();
    const tiles = within(panel).getByRole("list", { name: `Photos to send to ${SHOP}` });
    expect(within(tiles).getAllByRole("checkbox").map((box) => (box as HTMLInputElement).checked)).toEqual([true, true, true]);
    fireEvent.click(within(tiles).getAllByRole("checkbox")[1]!);
    fireEvent.click(within(panel).getByRole("button", { name: "Send 2 of 3 photos" }));
    expect(sent).toEqual([
      {
        type: "poppy.approvals",
        decisions: [
          { approvalId: "apr_0", decision: "approve" },
          { approvalId: "apr_1", decision: "decline" },
          { approvalId: "apr_2", decision: "approve" }
        ]
      }
    ]);
  });

  it("shows each photo's progress once decided, until every one has finished", () => {
    const fixture = session({}, { cards: [approval(0), approval(1)] });
    const view = open("/", fixture);
    fireEvent.click(screen.getByRole("button", { name: "Send 2 photos" }));
    const update = (cards: Card[]) => {
      fixture.value = { ...fixture.value, poppy: { ...fixture.value.poppy, cards } };
      view.rerender(<Workspace identity={IDENTITY} session={fixture.value} />);
    };
    update([approval(0, { open: false, status: "approved" }), approval(1)]);
    expect(screen.getByText(`Sending your photos to ${SHOP}`)).toBeTruthy();
    expect([...document.querySelectorAll("[data-tile]")].map((tile) => tile.getAttribute("data-tile"))).toEqual(["in_progress", "in_progress"]);
    update([approval(0, { open: false, status: "done", result: sentResult }), approval(1, { open: false, status: "approved" })]);
    expect([...document.querySelectorAll("[data-tile]")].map((tile) => tile.getAttribute("data-tile"))).toEqual(["done", "in_progress"]);
    expect(screen.getByText("1 of 2 finished")).toBeTruthy();
    update([approval(0, { open: false, status: "done", result: sentResult }), approval(1, { open: false, status: "refused", answer: { status: 422, error: "invalid_image" } })]);
    expect(document.querySelectorAll("[data-tile]")).toHaveLength(0);
  });

  it("announces a batch as one request", () => {
    open("/", session({}, { cards: [approval(0), approval(1), approval(2)] }));
    expect(screen.getByText(`1 request needs you. Send 3 photos from ${SHOP}.`)).toBeTruthy();
  });
});

describe("Companies and Activity", () => {
  it("lists a Company used without signing in", () => {
    const protocol = { companies: [{ key: ISSUER, company: SHOP, domain: DOMAIN, issuer: ISSUER, count: 9, lastSeq: 9, lastAt: Date.now() - 60_000 } satisfies ProtocolCompany], logs: {} };
    open("/companies", session({}, { protocol }));
    expect(screen.getByRole("button", { name: SHOP })).toBeTruthy();
    expect(screen.getByText(/Used without signing in/)).toBeTruthy();
  });

  it("shows uploads to one address in a row as one line in the log, which opens to each", () => {
    const entry = (index: number, result: ActivityEntry["result"]): ActivityEntry => ({
      id: `approval-apr_${index}`,
      at: 10_000 - index * 1_000,
      kind: "approval",
      issuer: ISSUER,
      company: SHOP,
      account: null,
      what: "Asked you to approve",
      quote: `Send your photo “${PHOTOS[index]!.name}” (JPEG, 1 MB) to ${SHOP}: POST /photos`,
      quoteBy: "agent",
      how: "api",
      access: "view_and_change",
      decidedBy: "you",
      result
    });
    open("/activity", session({}, { activity: { inProgress: [], log: [entry(0, "done"), entry(1, "done"), entry(2, "failed")] } }));
    const row = screen.getByRole("button", { name: new RegExp(`Asked you to approve sending 3 photos to ${SHOP}: POST /photos`) });
    expect(row.textContent).toContain("2 done · 1 failed");
    expect(screen.queryByText(/“harbour.jpg”/)).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText(/“harbour.jpg”/)).toBeTruthy();
  });
});
