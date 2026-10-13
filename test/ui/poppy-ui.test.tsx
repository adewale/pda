import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DirectConversations, needsYou, PoppyCards } from "../../src/poppy-ui";
import { gs, property } from "../properties/hegel";
import { CompaniesPage } from "../../src/ui/companies";
import type { Card, ConnectedAccount, DirectUpdate, Permission, PoppyClientFrame } from "../../src/poppy/wire";
import type { PoppyView } from "../../src/use-pi-session";
import { toIssuer } from "../../src/poppy/issuer";

/**
 * Poppy's cards and panels, rendered straight from a view with a recording
 * `send` and no WebSocket. The page is where approvals and credentials come
 * from, so these check what reaches the agent and when, and that nothing a
 * Company supplies becomes a dangerous link.
 */

const EMPTY: PoppyView = { cards: [], accounts: [], permissions: [], signOuts: [], direct: {}, activity: null, protocol: { companies: null, logs: {} } };

function view(patch: Partial<PoppyView>): PoppyView {
  return { ...EMPTY, ...patch };
}

function renderCards(...cards: Card[]) {
  const sent: PoppyClientFrame[] = [];
  const send = vi.fn((frame: PoppyClientFrame) => void sent.push(frame));
  const result = render(<PoppyCards view={view({ cards })} send={send} />);
  return { ...result, sent, send };
}

const SCOPES = [{ scope: "poppy:read", description: "View account information, such as orders and bookings" }];

const linkCard = (url: string): Card => ({
  id: "signin-1",
  kind: "signin_link",
  company: "Acme",
  open: true,
  signInId: "s1",
  url,
  scopes: SCOPES,
  reason: "To see your orders"
});

const deviceCard = (verificationUri: string, verificationUriComplete?: string): Card => ({
  id: "signin-2",
  kind: "signin_device",
  company: "Acme",
  open: true,
  signInId: "s2",
  verificationUri,
  ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
  userCode: "WDJB-MJHT",
  expiresAt: Date.now() + 600_000,
  scopes: SCOPES,
  reason: "To see your orders"
});

const credentialsCard: Card = {
  id: "signin-3",
  kind: "signin_credentials",
  company: "Acme",
  open: true,
  signInId: "s3",
  fields: [
    { name: "email", label: "Email address", secret: false },
    { name: "password", label: "Password", secret: true }
  ],
  scopes: SCOPES,
  reason: "To see your orders"
};

const codeCard: Card = { id: "signin-4", kind: "signin_code", company: "Acme", open: true, signInId: "s4", sentTo: "a***@example.com" };

const operationCard = (patch: Partial<Extract<Card, { kind: "operation" }>> = {}): Card => ({
  id: "op-1",
  kind: "operation",
  company: "Acme",
  open: true,
  issuer: toIssuer("https://auth.acme.example"),
  operationId: "op_7Hq",
  revision: 3,
  state: "proposed",
  summary: "Exchange the blue jumper (size M) for size L. No charge.",
  account: "a***@example.com",
  highlights: ["Cost: 0.00 GBP"],
  userApprovalRequired: false,
  ...patch
});

const approvalCard: Card = {
  id: "approval-1",
  kind: "approval",
  company: "Acme",
  open: true,
  approvalId: "ap_42",
  summary: "Acme: submit the form #checkout on the website",
  status: "pending"
};

const inviteCard: Card = { id: "invite-1", kind: "direct_invite", company: "Acme", open: true, conversationId: "conv_9", reason: "A person can help with the refund" };

const noticeCard: Card = { id: "notice-1", kind: "notice", company: "Acme", open: false, text: "Signed in to Acme." };

/** Every href and src on the page. */
function links(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[href], [src]")].map((element) => element.getAttribute("href") ?? element.getAttribute("src")!);
}

describe("sign-in cards", () => {
  it("links to the Company's sign-in page in a new tab, and Cancel cancels", () => {
    const url = "https://auth.acme.example/authorize?state=x";
    const { sent } = renderCards(linkCard(url));
    const link = screen.getByRole("link", { name: /Sign in on Acme's page/ });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("poppy:read")).toBeTruthy();
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(sent).toEqual([{ type: "poppy.signin.cancel", signInId: "s1" }]);
  });

  it("shows the device code beside a link and a QR code", () => {
    const { container, sent } = renderCards(deviceCard("https://auth.acme.example/device", "https://auth.acme.example/device?user_code=WDJB-MJHT"));
    expect(screen.getByText("WDJB-MJHT")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open Acme's page/ }).getAttribute("href")).toBe("https://auth.acme.example/device?user_code=WDJB-MJHT");
    expect(screen.getByRole("img", { name: "QR code for the sign-in link" })).toBeTruthy();
    expect(container.textContent).not.toContain("device_code");
    expect(sent).toEqual([]);
  });

  it("falls back to verification_uri when verification_uri_complete isn't safe", () => {
    renderCards(deviceCard("https://auth.acme.example/device", "javascript:alert(1)"));
    expect(screen.getByRole("link", { name: /Open Acme's page/ }).getAttribute("href")).toBe("https://auth.acme.example/device");
  });

  it.each([
    ["javascript:", "javascript:alert(document.cookie)"],
    ["javascript: in capitals, padded", "  JaVaScRiPt:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["http:", "http://auth.acme.example/device"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["not a URL", "acme.example/device"]
  ])("never renders a %s device link as a link or QR code", (_, uri) => {
    const { container } = renderCards(deviceCard(uri, uri));
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(links(container)).toEqual([]);
    // The code is still shown, with the reason the link isn't.
    expect(screen.getByText("WDJB-MJHT")).toBeTruthy();
    expect(screen.getByText(/isn't a secure web address/)).toBeTruthy();
  });

  it("never renders a javascript: or data: sign-in link as a link", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "http://auth.acme.example/authorize"]) {
      const { container, unmount } = renderCards(linkCard(url));
      expect(links(container)).toEqual([]);
      expect(screen.getByText(/isn't a secure web address/)).toBeTruthy();
      unmount();
    }
  });

  it(
    "only ever renders HTTPS hrefs, whatever text a Company sends",
    property((tc) => {
      const uri = tc.draw(gs.oneOf(gs.urls(), gs.text(), gs.sampledFrom(["javascript:x", "data:,x", "JAVASCRIPT:x", "\tjavascript:x", "java\nscript:x"])));
      const complete = tc.draw(gs.oneOf(gs.urls(), gs.text()));
      const { container, unmount } = renderCards(deviceCard(uri, complete), linkCard(complete));
      try {
        for (const href of links(container)) expect(new URL(href).protocol).toBe("https:");
      } finally {
        unmount();
      }
    })
  );
});

describe("credentials card (Mediated Sign-In)", () => {
  it("labels each field, makes secret fields password inputs, and sends values only on submit", () => {
    const { container, sent } = renderCards(credentialsCard);
    const email = screen.getByLabelText("Email address") as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(email.type).toBe("text");
    expect(password.type).toBe("password");
    expect(password.autocomplete).toBe("current-password");

    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.change(password, { target: { value: "correct horse" } });
    // Typing sends nothing.
    expect(sent).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Acme" }));
    expect(sent).toEqual([
      { type: "poppy.credentials", signInId: "s3", values: { email: "ada@example.com", password: "correct horse" } }
    ]);

    // Never shown back: the fields are empty and the secret is nowhere on the page.
    expect(email.value).toBe("");
    expect(password.value).toBe("");
    expect(container.innerHTML).not.toContain("correct horse");
    expect(container.innerHTML).not.toContain("ada@example.com");
  });

  it("Cancel sends no values", () => {
    const { sent } = renderCards(credentialsCard);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(sent).toEqual([{ type: "poppy.signin.cancel", signInId: "s3" }]);
    expect(JSON.stringify(sent)).not.toContain("hunter2");
  });

  it(
    "starts every field empty, whatever the Company names it",
    property((tc) => {
      const names = [
        ...tc.draw(gs.sets(gs.oneOf(gs.text({ minSize: 1 }), gs.sampledFrom(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])), { minSize: 1, maxSize: 4 }))
      ];
      const card: Card = {
        ...credentialsCard,
        fields: names.map((name, index) => ({ name, label: `Field ${index}`, secret: index % 2 === 1 }))
      };
      const { unmount, sent } = renderCards(card);
      try {
        for (let index = 0; index < names.length; index++) {
          expect((screen.getByLabelText(`Field ${index}`) as HTMLInputElement).value).toBe("");
        }
        expect(sent).toEqual([]);
      } finally {
        unmount();
      }
    })
  );
});

describe("one-time code card", () => {
  it("names where the code went and sends only the code, on submit", () => {
    const { sent } = renderCards(codeCard);
    expect(screen.getByText(/a\*\*\*@example\.com/)).toBeTruthy();
    const input = screen.getByLabelText("One-time code") as HTMLInputElement;
    expect(input.autocomplete).toBe("one-time-code");
    fireEvent.change(input, { target: { value: "123456" } });
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    expect(sent).toEqual([{ type: "poppy.code", signInId: "s4", code: "123456" }]);
    expect(input.value).toBe("");
  });
});

describe("operation card (Operations extension 5.1)", () => {
  it("shows the Company's summary verbatim, and sends nothing until a click", () => {
    const { sent } = renderCards(operationCard({ previousSummary: "Exchange for size S." }));
    expect(screen.getByText("Exchange the blue jumper (size M) for size L. No charge.")).toBeTruthy();
    expect(screen.getByText("Exchange for size S.")).toBeTruthy();
    expect(screen.getByText("Cost: 0.00 GBP")).toBeTruthy();
    expect(screen.getByText(/a\*\*\*@example\.com/)).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("approves exactly this operation and revision", () => {
    const { sent } = renderCards(operationCard());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent).toEqual([
      { type: "poppy.operation", issuer: toIssuer("https://auth.acme.example"), operationId: "op_7Hq", revision: 3, decision: "approve" }
    ]);
  });

  it("declines with decline", () => {
    const { sent } = renderCards(operationCard());
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(sent).toEqual([
      { type: "poppy.operation", issuer: toIssuer("https://auth.acme.example"), operationId: "op_7Hq", revision: 3, decision: "decline" }
    ]);
  });

  it("offers only to stop an operation in progress", () => {
    const { sent } = renderCards(operationCard({ open: false, state: "in_progress" }));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask Acme to stop" }));
    expect(sent).toEqual([
      { type: "poppy.operation", issuer: toIssuer("https://auth.acme.example"), operationId: "op_7Hq", revision: 3, decision: "cancel" }
    ]);
  });

  it("shows a finished operation's outcome without buttons", () => {
    renderCards(operationCard({ open: false, state: "succeeded", result: "Exchange booked.", approvedBy: "standing_permission" }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Exchange booked\./)).toBeTruthy();
    expect(screen.getByText(/by standing permission/)).toBeTruthy();
  });

  it("never links the Company's operation url", () => {
    const { container } = renderCards(operationCard({ url: "javascript:alert(1)" }));
    expect(links(container)).toEqual([]);
  });
});

describe("local approval card", () => {
  it("sends approve or decline for exactly this approval, only on a click", () => {
    const { sent } = renderCards(approvalCard);
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(sent).toEqual([
      { type: "poppy.approval", approvalId: "ap_42", decision: "approve" },
      { type: "poppy.approval", approvalId: "ap_42", decision: "decline" }
    ]);
  });

  it("keeps Approve and Decline in a sticky footer, so a tall photo card on a phone can't scroll them out of the tray", () => {
    renderCards({ ...approvalCard, attachments: [{ id: "att_1", name: "image.png", type: "image/png", size: 3_700_000 }] });
    const footer = screen.getByRole("button", { name: "Approve" }).closest("[data-card-actions]");
    expect(footer?.className).toContain("sticky");
    expect(footer?.contains(screen.getByRole("button", { name: "Decline" }))).toBe(true);
    // The photo is short on a phone, full height from the sm breakpoint.
    expect(screen.getByRole("img", { name: "image.png" }).className).toContain("max-h-28");
  });

  it("can be dismissed once closed", () => {
    const { sent } = renderCards({ ...approvalCard, open: false, status: "done", result: "Now at the receipt page" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(sent).toEqual([{ type: "poppy.card.dismiss", id: "approval-1" }]);
  });

  const receipt = (patch: Partial<Extract<Card, { kind: "approval" }>>) => {
    const { container } = renderCards({ ...approvalCard, open: false, summary: "Acme: POST /orders", ...patch } as Card);
    return container.textContent ?? "";
  };

  it("says an approved write the Company did is done", () => {
    const text = receipt({ status: "done", result: '{"status":201}' });
    expect(text).toContain("Done, as you approved: Acme: POST /orders");
  });

  it("says an approved write the Company answered with an error was sent, not done, with its status and code", () => {
    const text = receipt({
      status: "refused",
      answer: { status: 500, error: "server_error" },
      result: "Sent as you approved, but Acme answered 500 (server_error). Nothing changed unless Acme says otherwise."
    });
    expect(text).toContain("Sent as you approved, but Acme answered 500 (server_error): Acme: POST /orders");
    expect(text).toContain("Nothing changed unless Acme says otherwise.");
    expect(text).not.toContain("Done");
    // No code: the status alone.
    expect(receipt({ status: "refused", answer: { status: 504 } })).toContain("Acme answered 504: Acme: POST /orders");
    // Shown as a failure, as an approved write that failed is.
    const { container } = renderCards({ ...approvalCard, open: false, status: "refused", answer: { status: 500 } });
    expect(container.querySelector(".text-kumo-danger")).not.toBeNull();
  });

  it("says an approved write that got no answer may or may not have reached the Company, and keeps it in front of the User", () => {
    const result = "Sent as you approved, but no answer came from Acme, so it may or may not have reached them. Check with Acme before asking again.";
    const text = receipt({ status: "unknown", result });
    expect(text).toContain("Outcome unknown: Acme: POST /orders");
    expect(text).toContain(result);
    expect(text).not.toContain("Done");
    expect(needsYou([{ ...approvalCard, open: false, status: "unknown", result }])).toHaveLength(1);
  });

  it("says an approved write that was never sent failed", () => {
    const text = receipt({ status: "failed", result: "The User's attachment att_1 is gone (deleted, or past its 30 days), so nothing was sent [no_attachment]" });
    expect(text).toContain("Failed after you approved: Acme: POST /orders");
    expect(text).toContain("so nothing was sent");
  });
});

describe("Direct Conversation invitation", () => {
  it("starts only with the User's own words, and Not now declines", () => {
    const { sent } = renderCards(inviteCard);
    const start = screen.getByRole("button", { name: "Talk to Acme" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "  Hello, I'd like a refund  " } });
    fireEvent.click(screen.getByRole("button", { name: "Talk to Acme" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(sent).toEqual([
      { type: "poppy.direct.start", conversationId: "conv_9", text: "Hello, I'd like a refund" },
      { type: "poppy.direct.decline", conversationId: "conv_9" }
    ]);
  });
});

describe("the Company's domain (spec issue N14)", () => {
  it("shows the verified domain under the name the Company chose, on every request card, as text", () => {
    const requests = [linkCard("https://auth.acme.example/a"), deviceCard("https://auth.acme.example/device"), credentialsCard, codeCard, operationCard(), approvalCard, inviteCard];
    const { container } = renderCards(...requests.map((card) => ({ ...card, id: `${card.id}-d`, domain: "acme.example" })));
    const articles = [...container.querySelectorAll("article")];
    expect(articles).toHaveLength(requests.length);
    for (const article of articles) {
      expect(within(article).getByText("acme.example").tagName).toBe("CODE");
    }
  });

  it("shows no domain line when a card has none", () => {
    const { container } = renderCards(approvalCard);
    expect(container.querySelector("article code")).toBeNull();
  });
});

describe("notice card", () => {
  it("shows the text as text and can be dismissed", () => {
    const { container, sent } = renderCards({ ...noticeCard, text: '<a href="javascript:alert(1)">click</a>' });
    expect(screen.getByText('<a href="javascript:alert(1)">click</a>')).toBeTruthy();
    expect(links(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(sent).toEqual([{ type: "poppy.card.dismiss", id: "notice-1" }]);
  });
});

it("renders nothing without cards, and sends nothing on render", () => {
  const send = vi.fn();
  const { container } = render(<PoppyCards view={EMPTY} send={send} />);
  expect(container.innerHTML).toBe("");
  expect(send).not.toHaveBeenCalled();
  // Every kind of card, rendered: still nothing sent until the User acts.
  const all = renderCards(linkCard("https://a.example/"), deviceCard("https://a.example/d"), credentialsCard, codeCard, operationCard(), approvalCard, inviteCard, noticeCard);
  // The seven open cards; the closed notice is not one of them.
  expect(all.container.querySelectorAll("article")).toHaveLength(7);
  expect(all.send).not.toHaveBeenCalled();
  expect(all.sent).toEqual([]);
});

describe("DirectConversations", () => {
  const update = (patch: Partial<DirectUpdate> = {}): DirectUpdate => ({
    conversationId: "conv_9",
    company: "Acme",
    status: "open",
    responder: "human",
    messages: [
      { id: "m1", role: "user", sender: "human", text: "Hello" },
      { id: "m2", role: "company", sender: "human", text: "Hi, this is Sam" },
      { id: "m3", role: "company", sender: "agent", text: "javascript:alert(1)" }
    ],
    partial: { messageId: "m4", text: "Let me che" },
    ...patch
  });

  function renderDirect(direct: Record<string, DirectUpdate>) {
    const sent: PoppyClientFrame[] = [];
    const result = render(<DirectConversations view={view({ direct })} send={(frame) => void sent.push(frame)} />);
    return { ...result, sent };
  }

  it("shows who is answering, the messages and a partial message, as text", () => {
    const { container } = renderDirect({ conv_9: update() });
    expect(screen.getByText("You're talking with Acme")).toBeTruthy();
    expect(screen.getAllByText("A person at Acme").length).toBeGreaterThan(0);
    expect(screen.getByText("Acme's agent")).toBeTruthy();
    expect(screen.getByText("Hi, this is Sam")).toBeTruthy();
    expect(screen.getByText("Let me che")).toBeTruthy();
    expect(links(container)).toEqual([]);
  });

  it("says what the User typed, trimmed, and ends the conversation on End", () => {
    const { sent } = renderDirect({ conv_9: update() });
    const box = screen.getByLabelText("Message Acme") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  Thanks  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(box.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "End conversation" }));
    expect(sent).toEqual([
      { type: "poppy.direct.say", conversationId: "conv_9", text: "Thanks" },
      { type: "poppy.direct.close", conversationId: "conv_9" }
    ]);
  });

  it("hides closed conversations", () => {
    const { container } = renderDirect({ conv_9: update({ closed: true }) });
    expect(container.innerHTML).toBe("");
  });
});

describe("Companies page", () => {
  const accounts: ConnectedAccount[] = [
    { issuer: toIssuer("https://auth.acme.example"), company: "Acme", account: "a***@example.com", scope: "poppy:read poppy:write", expiresAt: null },
    { issuer: toIssuer("https://auth.globex.example"), company: "Globex", account: "g***@example.com", scope: "poppy:read", expiresAt: null }
  ];
  const permissions: Permission[] = [
    {
      id: "perm_1",
      issuer: toIssuer("https://auth.acme.example"),
      company: "Acme",
      account: "a***@example.com",
      action: "exchange",
      maxAmount: "20.00",
      currency: "GBP",
      maxUses: 3,
      uses: 1,
      expiresAt: null
    }
  ];

  function Page({ patch, sent }: { patch: Partial<PoppyView>; sent: PoppyClientFrame[] }) {
    const [selected, setSelected] = useState<string | null>(null);
    return <CompaniesPage view={view(patch)} send={(frame) => void sent.push(frame)} selected={selected} onSelect={setSelected} />;
  }

  function renderCompanies(patch: Partial<PoppyView>) {
    const sent: PoppyClientFrame[] = [];
    const result = render(<Page patch={patch} sent={sent} />);
    return { ...result, sent };
  }

  it("lists each Company's account and access, signs out and removes on a click", () => {
    const { sent } = renderCompanies({ accounts, permissions });
    const table = screen.getByRole("table");
    expect(within(table).getByRole("button", { name: "Globex" })).toBeTruthy();
    // Access in plain words, with the scope it comes from.
    expect(within(table).getByText("View and change")).toBeTruthy();
    expect(within(table).getByText("poppy:read poppy:write")).toBeTruthy();
    expect(sent).toEqual([]);

    fireEvent.click(within(table).getByRole("button", { name: "Globex" }));
    expect(screen.getByRole("heading", { level: 1, name: "Globex" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out of Globex" }));
    fireEvent.click(screen.getByRole("button", { name: "All Companies" }));
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Acme" }));
    expect(screen.getByText(/1 of 3 uses, 2 left/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove standing permission" }));
    expect(sent).toEqual([
      { type: "poppy.signout", issuer: toIssuer("https://auth.globex.example"), account: "g***@example.com" },
      { type: "poppy.permission.remove", id: "perm_1" }
    ]);
  });

  it("adds a permission from labelled fields, for the chosen account", () => {
    const { sent } = renderCompanies({ accounts });
    fireEvent.click(screen.getByRole("button", { name: "Globex" }));
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "https://auth.globex.example|g***@example.com" } });
    fireEvent.change(screen.getByLabelText(/Word or words Globex's summary must begin with/), { target: { value: "rebook" } });
    fireEvent.change(screen.getByLabelText("Up to"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "eur" } });
    fireEvent.change(screen.getByLabelText("Number of times"), { target: { value: "2" } });
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Add standing permission" }));
    expect(sent).toEqual([
      {
        type: "poppy.permission.add",
        issuer: toIssuer("https://auth.globex.example"),
        account: "g***@example.com",
        action: "rebook",
        maxAmount: "50",
        currency: "EUR",
        maxUses: 2
      }
    ]);
  });

  it("checks the form inline and keeps what was typed", () => {
    const { sent } = renderCompanies({ accounts });
    fireEvent.click(screen.getByRole("button", { name: "Acme" }));
    const amount = screen.getByLabelText("Up to") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Add standing permission" }));
    expect(sent).toEqual([]);
    expect(screen.getByText(/Name the word or words the Company's summary must begin with/)).toBeTruthy();
    expect(screen.getByText(/Use a number/)).toBeTruthy();
    expect(amount.value).toBe("lots");
    expect(amount.getAttribute("aria-invalid")).toBe("true");
  });

  it("offers no permission form before an account is connected", () => {
    renderCompanies({});
    expect(screen.getByText("No Companies yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add standing permission" })).toBeNull();
  });
});
