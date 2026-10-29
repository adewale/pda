// The same print order on both revisions: what the Company returned, as each revision's card holds it.
const summary = "Print 2 copies of lake.jpg as 4×6 in (6×4) lustre prints and post them to Ada Lovelace, 12 St James's Square, London SW1Y 4JH, GB. Confirmation to ada@example.com. Prints $10.50 + shipping $5.00 = $15.50 USD, paid by card at a checkout link after approval. Can be cancelled until you pay.";
const highlights = ["Total: $15.50 USD", "Can be cancelled until you pay"];
const total = { amount: "15.50", currency: "USD" };
const expiresAt = "2026-10-29T12:10:00Z";
const common = { id: "card_1", company: "Mock Shop", domain: "shop.example", open: true };
export const base = [{ ...common, kind: "operation", issuer: "https://auth.shop.example", operationId: "prt_1", revision: 1, state: "proposed", summary, account: null, highlights, expiresAt, userApprovalRequired: true, total }];
export const head = [
  { ...common, kind: "approval", approvalId: "apr_1", summary: "POST https://api.shop.example/prints", status: "pending", terms: { summary, expiresAt, highlights, total } },
  { ...common, id: "card_2", kind: "approval", approvalId: "apr_2", summary: "POST https://api.shop.example/prints", status: "pending",
    terms: { summary, expiresAt, highlights, total, differences: ["The terms say 3 copies of lake.jpg; the request asked for 2"] } }
];
