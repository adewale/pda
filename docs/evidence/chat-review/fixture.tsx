/**
 * The scenes for this folder's captures: the production `Workspace` and its
 * styles, given a fixed session instead of the agent's socket, so the same
 * input renders at the base commit and at the head. Every name, domain and
 * photo is an example; the photos are test patterns `capture.mjs` makes.
 * Pick a scene with `?scene=`.
 */
import { createRoot } from "react-dom/client";
import "./fixture.css";
import { attachmentMarker, type AttachmentInfo } from "../../../src/attachments";
import type { TranscriptMessage } from "../../../src/protocol";
import type { ActivityEntry, Card, PoppyClientFrame, ProtocolCompany } from "../../../src/poppy/wire";
import { Workspace } from "../../../src/ui/shell";
import type { PiSession, PoppyView } from "../../../src/use-pi-session";

const SHOP = "Print Shop";
const DOMAIN = "prints.example";
const ISSUER = "https://prints.example" as ProtocolCompany["issuer"] & string;
const KEY = `${ISSUER} POST https://api.prints.example/photos`;
const T0 = Date.UTC(2026, 9, 22, 14, 0);

/** Ten test patterns, one of them a GIF the shop refuses. */
export const PHOTOS: AttachmentInfo[] = ["bars", "gradient", "mandelbrot", "grid", "spectrum", "circles", "checker", "noise", "rings", "plasma"].map((name, index) => ({
  id: `att_${String(index).padStart(2, "0")}${"p".repeat(20)}`,
  name: index === 7 ? `${name}.gif` : `${name}.jpg`,
  type: index === 7 ? "image/gif" : "image/jpeg",
  size: 900_000 + index * 137_000
}));

const signed = (index: number) => `https://media.prints.example/photo_${index}/contain?exp=1792709066&sig=Zx9${index}example-signature-value`;
const answer = (index: number) =>
  JSON.stringify({ status: 201, body: { id: `photo_${index}A`, name: `Photo ${index + 1}`, width: 4284 - index * 100, height: 5712 - index * 100, lowResolution: false, created: T0 + 60_000, previews: { contain: signed(index), cover: signed(index).replace("contain", "cover") } } });

function approval(index: number, patch: Partial<Extract<Card, { kind: "approval" }>> = {}): Card {
  const photo = PHOTOS[index]!;
  return {
    id: `approval-apr_${index}`,
    kind: "approval",
    company: SHOP,
    domain: DOMAIN,
    open: true,
    approvalId: `apr_${index}`,
    summary: `Send your photo “${photo.name}” (${photo.type === "image/gif" ? "GIF" : "JPEG"}, ${(photo.size / 1_000_000).toFixed(1)} MB) to ${SHOP}: POST /api/photos (Upload a private print photo, 20 MB maximum)`,
    status: "pending",
    attachments: [photo],
    batchKey: KEY,
    at: T0 + 90_000,
    ...patch
  } as Card;
}

const decided = PHOTOS.map((_, index) =>
  index === 7
    ? approval(index, { open: false, status: "refused", answer: { status: 422, error: "invalid_image" }, result: `Sent as you approved, but ${SHOP} answered 422 (invalid_image). Nothing changed unless ${SHOP} says otherwise.` })
    : approval(index, { open: false, status: "done", result: answer(index) })
);

const call = (index: number) => ({ type: "tool-call" as const, id: `call_${index}`, name: "poppy_api_call", arguments: { domain: DOMAIN, operation: "uploadPhoto", files: { photo: PHOTOS[index]!.id } } });
const proposed = (index: number) => ({
  type: "tool-result" as const,
  id: `call_${index}`,
  name: "poppy_api_call",
  content: [{ type: "text" as const, text: JSON.stringify({ proposed: `apr_${index}`, note: "Waiting for the User to approve sending the file on a card; nothing has been sent yet." }) }],
  details: { proposed: `apr_${index}`, note: "Waiting for the User to approve sending the file on a card; nothing has been sent yet." },
  error: false
});

const conversation: TranscriptMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: `Can you print these as 4×6s at ${DOMAIN}? One of each.\n\n${PHOTOS.map(attachmentMarker).join("\n")}` }], timestamp: T0 },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "thinking", text: "Look up the shop, then upload each photo." },
      { type: "tool-call", id: "call_d", name: "poppy_discover", arguments: { domain: DOMAIN } },
      { type: "tool-call", id: "call_api", name: "poppy_api_describe", arguments: { domain: DOMAIN } }
    ],
    timestamp: T0 + 5_000
  },
  {
    id: "t1",
    role: "tool",
    parts: [
      { type: "tool-result", id: "call_d", name: "poppy_discover", content: [{ type: "text", text: "{}" }], details: { company: SHOP, domain: DOMAIN }, error: false },
      { type: "tool-result", id: "call_api", name: "poppy_api_describe", content: [{ type: "text", text: "{}" }], details: {}, error: false }
    ],
    timestamp: T0 + 6_000
  },
  { id: "a2", role: "assistant", parts: [{ type: "thinking", text: "Ten uploads, each needs approval." }, ...PHOTOS.map((_, index) => call(index))], timestamp: T0 + 10_000 },
  { id: "t2", role: "tool", parts: PHOTOS.map((_, index) => proposed(index)), timestamp: T0 + 11_000 },
  { id: "a3", role: "assistant", parts: [{ type: "text", text: "Each photo is waiting for your approval in the panel below." }], timestamp: T0 + 12_000 },
  {
    id: "n1",
    role: "user",
    // The one notice the agent now sends for the ten (operations.ts decideLocalBatch); the base agent sent one per photo.
    parts: [
      {
        type: "text",
        text: `[system] The User decided 10 requests together on one card:\n${(decided as Extract<Card, { kind: "approval" }>[])
          .map((card, index) => `${index + 1}. ${card.status === "done" ? `Done, as the User approved: ${card.summary}. Result: ${answer(index)}` : `Sent as the User approved, but ${SHOP} answered 422 (invalid_image), so it wasn't done as far as ${SHOP} says: ${card.summary}.`}`)
          .join("\n")}`
      }
    ],
    timestamp: T0 + 95_000
  },
  {
    id: "a4",
    role: "assistant",
    parts: [{ type: "thinking", text: "Nine went through; the GIF was refused." }, { type: "text", text: `Nine photos are uploaded. **noise.gif** was refused: ${SHOP} takes JPEG, PNG or WebP. Where should the prints go? I need a name, an email and a US shipping address.` }],
    timestamp: T0 + 100_000
  }
];

const order = (patch: Partial<Extract<Card, { kind: "operation" }>> = {}): Card =>
  ({
    id: `op-${ISSUER}-op_1`,
    kind: "operation",
    company: SHOP,
    domain: DOMAIN,
    open: true,
    issuer: ISSUER,
    operationId: "op_1",
    revision: 1,
    state: "proposed",
    summary: `${SHOP} 9 × 4×6 photo prints, lustre, borderless. Deliver to: Ada Lovelace, 12 Example Street, Springfield, CA 94105, US. Email: ada@example.com. Delivery: estimated 7–12 business days after payment. Prints $13.50 · US shipping included · tax $1.00 · Total $14.50 USD. Approve to continue to payment.`,
    account: null,
    terms: {},
    highlights: ["Cost (prints): 13.50 USD", "Cost (tax): 1.00 USD", "Cost (total): 14.50 USD", "Condition (cancellation): Cancellation isn't guaranteed after printing starts.", "The company hasn't said whether this can be undone."],
    expiresAt: new Date(T0 + 15 * 60_000).toISOString(),
    userApprovalRequired: true,
    total: { amount: "14.50", currency: "USD" },
    previews: [1, 2, 3].map((n) => ({ label: `items ${n} preview`, url: `https://prints.example/previews/op_1/${n}` })),
    at: T0 + 200_000,
    ...patch
  }) as Card;

const uploadLog: ActivityEntry[] = (decided as Extract<Card, { kind: "approval" }>[]).map((card, index) => ({
  id: card.id,
  at: T0 + 90_000 - index * 2_000,
  kind: "approval",
  issuer: ISSUER as ActivityEntry["issuer"],
  company: SHOP,
  account: null,
  what: "Asked you to approve",
  quote: card.summary,
  quoteBy: "agent",
  how: "api",
  access: "view_and_change",
  decidedBy: "you",
  result: card.status === "done" ? "done" : "failed"
}));

const protocol = { companies: [{ key: ISSUER, company: SHOP, domain: DOMAIN, issuer: ISSUER, count: 24, lastSeq: 24, lastAt: T0 + 210_000 } as ProtocolCompany], logs: {} };

const SCENES: Record<string, { messages?: TranscriptMessage[]; running?: boolean; poppy: Partial<PoppyView> }> = {
  /** After the ten uploads: what the conversation shows under the agent's newest message. */
  chat: { messages: conversation, poppy: { cards: decided, protocol } },
  /** The ten uploads waiting, as the panel shows them. */
  batch: { messages: conversation.slice(0, 6), running: true, poppy: { cards: PHOTOS.map((_, index) => approval(index)), protocol } },
  /** The order's terms. */
  order: { messages: conversation, poppy: { cards: [...decided, order()], protocol } },
  /** The order once confirmed, with its checkout. */
  ordered: {
    messages: [
      ...conversation,
      { id: "u9", role: "user", parts: [{ type: "text", text: "Ada Lovelace, ada@example.com, 12 Example Street, Springfield, CA 94105" }], timestamp: T0 + 150_000 },
      { id: "a9", role: "assistant", parts: [{ type: "text", text: "Your order is ready. Nothing has been charged or printed yet: completing checkout starts printing." }], timestamp: T0 + 400_000 }
    ],
    poppy: {
      cards: [
        ...decided,
        order({ open: false, state: "succeeded", approvedBy: "user", result: "Order ord_1 is ready for payment. Nothing has been charged or printed yet.", links: [{ label: "checkout", url: "https://prints.example/checkout/ord_1" }], at: T0 + 300_000 })
      ],
      protocol
    }
  },
  /** Activity's log after the uploads. */
  activity: { poppy: { activity: { inProgress: [], log: uploadLog }, protocol } },
  /** Companies after an order placed without signing in. */
  companies: { poppy: { protocol } }
};

const scene = SCENES[new URLSearchParams(location.search).get("scene") ?? "chat"] ?? SCENES.chat!;
const session = {
  messages: scene.messages ?? [],
  live: null,
  running: scene.running ?? false,
  tools: [],
  queued: 0,
  retry: null,
  model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-5-5" },
  error: null,
  status: "open",
  catalog: [],
  summaries: new Set<string>(),
  poppy: { cards: [], accounts: [], permissions: [], signOuts: [], direct: {}, activity: null, protocol: { companies: null, logs: {} }, ...scene.poppy },
  outbox: [],
  submit: () => undefined,
  resend: () => undefined,
  discard: () => undefined,
  abort: () => undefined,
  reset: () => undefined,
  sendPoppy: (_frame: PoppyClientFrame) => true
} as unknown as PiSession;

createRoot(document.getElementById("root")!).render(<Workspace identity={{ email: "ada@example.com", provider: "google" }} session={session} />);
