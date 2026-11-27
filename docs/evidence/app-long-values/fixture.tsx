/**
 * The scenes for this folder's captures: the production `Workspace` and its
 * styles, given a fixed session instead of the agent's socket, so the same
 * input renders at the base commit and at the head. Every name, domain and
 * URL is an example. Pick a scene with `?scene=`.
 *
 * A notice card about a departure carries its parts as `problem` from this
 * branch on, beside a lead sentence; the base agent put the whole diagnostic
 * in `text`. The fixture sends what each agent sent, telling them apart by
 * whether the checkout has `src/ui/rich.tsx`.
 */
import { createRoot } from "react-dom/client";
import "./fixture.css";
import type { TranscriptMessage } from "../../../src/protocol";
import type { Card, ProtocolCompany, ProtocolEntry } from "../../../src/poppy/wire";
import { Workspace } from "../../../src/ui/shell";
import type { PiSession, PoppyView } from "../../../src/use-pi-session";

const AFTER = Object.keys(import.meta.glob("../../../src/ui/rich.tsx")).length > 0;

const SHOP = "Print Shop";
const DOMAIN = "print.example";
const ISSUER = "https://print.example";
const T0 = Date.UTC(2026, 10, 26, 9, 0);
const SIGN_IN = "https://login.example-idp.com/app/example_idp_production_tenant_1/exk7g3v8a0D8kEuzr4h7/sso/saml?…";
const RESOURCE = "https://print.example/.well-known/oauth-protected-resource";

type Problem = { subject: string; expected: string; got: string; detail?: string };

/** A notice about a departure, as each agent sent it. */
function notice(id: string, lead: string, problem: Problem, before: string, patch: Partial<Card> = {}): Card {
  return (AFTER ? { id, kind: "notice", company: SHOP, domain: DOMAIN, open: true, text: lead, problem, at: T0, ...patch } : { id, kind: "notice", company: SHOP, domain: DOMAIN, open: true, text: before, at: T0, ...patch }) as Card;
}

const metadata: Problem = {
  subject: RESOURCE,
  expected: "protected resource metadata as application/json",
  got: `a web page (HTTP 200, text/html) at ${SIGN_IN}, on another host, after redirects`
};
const operationId: Problem = { subject: "its operation_id", expected: "1 to 256 URL-safe characters", got: "300 characters" };

const cards: Card[] = [
  notice("n-signin", "That didn't work.", metadata, `That didn't work: ${metadata.subject}: expected ${metadata.expected}, got ${metadata.got}`, { at: T0 + 60_000 }),
  notice(
    "n-terms",
    `${SHOP} asked for your approval, but its terms couldn't be used, so nothing was done.`,
    operationId,
    `${SHOP} asked for your approval, but its terms couldn't be used (${operationId.subject}: expected ${operationId.expected}, got ${operationId.got}), so nothing was done.`,
    { at: T0 + 120_000 }
  ),
  {
    id: "approval-apr_1",
    kind: "approval",
    company: SHOP,
    domain: "uploads.eu-west-1.print-shop-customer-media-production.example",
    open: true,
    approvalId: "apr_1",
    summary: `Send your photo “lake.jpg” (JPEG, 2.4 MB) to ${SHOP}: POST https://uploads.eu-west-1.print-shop-customer-media-production.example/v2/accounts/acct_7Hq2xL9mPz4KdW8n/photo_uploads_pending_review (Upload a private print photo, 20 MB maximum)`,
    status: "pending",
    at: T0 + 180_000
  } as Card
];

const conversation: TranscriptMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: `Print lake.jpg as a 4×6 at ${DOMAIN}.` }], timestamp: T0 - 5_000 },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "I tried; the cards below say what happened." }], timestamp: T0 + 200_000 }
];

const entry = (seq: number, patch: Partial<ProtocolEntry>): ProtocolEntry => ({
  seq,
  at: T0 + seq * 1_337,
  section: "§3",
  title: "Discovery",
  step: "discovery",
  method: "GET",
  url: null,
  status: 200,
  error: null,
  outcome: "ok",
  summary: "",
  result: "",
  ...patch
});

const entries: ProtocolEntry[] = [
  entry(1, { url: "https://print.example/.well-known/poppy.json", summary: "Asked for the Company's discovery document", result: "Poppy 0.4, an agent endpoint at https://agents.print-shop-customer-media-production.example/poppy/v2/sessions" }),
  entry(2, {
    section: "§4.1",
    title: "Protected resource",
    step: "resource.metadata",
    url: RESOURCE,
    status: 200,
    error: "unexpected_content_type",
    outcome: "error",
    summary: "Asked for the protected resource metadata",
    result: `${RESOURCE}: expected protected resource metadata as application/json, got ${metadata.got}`
  }),
  entry(3, {
    section: "Ops §5.2",
    title: "Confirming",
    step: "operation.confirm",
    method: "POST",
    url: "https://agents.print-shop-customer-media-production.example/poppy/v2/operations/op_9f8e7d6c5b4a39281706f5e4d3c2b1a0_print_order/confirm",
    status: 409,
    error: "revision_mismatch",
    outcome: "error",
    summary: "Confirmed the order the User approved, revision r2",
    result: "409 revision_mismatch: the Company's revision is r3"
  })
];

const company = { key: ISSUER, company: SHOP, domain: DOMAIN, issuer: ISSUER, count: entries.length, lastSeq: entries.length, lastAt: entries.at(-1)!.at } as ProtocolCompany;
const protocol = { companies: [company], logs: { [ISSUER]: { type: "poppy.protocol" as const, key: ISSUER, company: SHOP, domain: DOMAIN, issuer: company.issuer, entries } } };

const SCENES: Record<string, { messages?: TranscriptMessage[]; poppy: Partial<PoppyView> }> = {
  /** Two notices about departures and an approval to a long URL, on the chat's card panel. */
  notices: { messages: conversation, poppy: { cards, protocol } },
  /** Activity's protocol view for the Company, opened. */
  protocol: { poppy: { activity: { inProgress: [], log: [] }, protocol } }
};

function sessionOf(messages: readonly TranscriptMessage[], poppy: Partial<PoppyView>): PiSession {
  return {
    messages,
    live: null,
    running: false,
    tools: [],
    queued: 0,
    retry: null,
    model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-5-5" },
    error: null,
    status: "open",
    catalog: [],
    summaries: new Set<string>(),
    poppy: { cards: [], accounts: [], permissions: [], signOuts: [], direct: {}, activity: null, protocol: { companies: null, logs: {} }, ...poppy },
    outbox: [],
    submit: () => undefined,
    resend: () => undefined,
    discard: () => undefined,
    abort: () => undefined,
    reset: () => undefined,
    sendPoppy: () => true
  } as unknown as PiSession;
}

const scene = SCENES[new URLSearchParams(location.search).get("scene") ?? "notices"] ?? SCENES.notices!;
createRoot(document.getElementById("root")!).render(<Workspace identity={{ email: "ada@example.com", provider: "google" }} session={sessionOf(scene.messages ?? [], scene.poppy)} />);
