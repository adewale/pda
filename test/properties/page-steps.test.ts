import { describe, expect, it } from "vitest";
import type { Company } from "../../src/poppy/discovery";
import { termsPreviews, termsTotal } from "../../src/poppy/operations";
import type { Card } from "../../src/poppy/wire";
import { redactQueries, resultFacts } from "../../src/ui/result-facts";
import { approvalBatches } from "../../src/ui/steps";
import { gs, jsonValues, property } from "./hegel";

/**
 * The page's pure pieces behind the chat's requests (src/ui/steps.ts,
 * src/ui/result-facts.ts): which uploads share one card, and what of a
 * Company's answer reaches the screen.
 */

const STATUSES = ["pending", "approved", "declined", "done", "refused", "failed", "unknown"] as const;

/** Cards as the agent sends them: approvals in every state, with or without a batch key, among other kinds. Keys come from a small pool, so they collide, and from any text. */
const cardLists = gs.arrays(
  gs.tuples(
    gs.sampledFrom(["approval", "approval", "approval", "notice", "operation"] as const),
    gs.booleans(),
    gs.sampledFrom(STATUSES),
    gs.optional(gs.oneOf(gs.sampledFrom(["k1", "k2", "k3"]), gs.text()))
  ),
  { maxSize: 12 }
).map((drawn) =>
  drawn.map(([kind, open, status, key], index): Card => {
    const id = `card-${index}`;
    if (kind === "notice") return { id, kind, company: "Acme", open, text: "A notice" };
    if (kind === "operation") return { id, kind, company: "Acme", open, issuer: "https://acme.example" as never, operationId: `op_${index}`, revision: 1, state: "proposed", summary: "s", account: null, highlights: [], userApprovalRequired: true };
    return { id, kind, company: "Acme", open, approvalId: `apr_${index}`, summary: "s", status, ...(key === null || key === undefined ? {} : { batchKey: key }) };
  })
);

/** What may share a card: an open, pending approval with a key. */
const keyOf = (card: Card) => (card.kind === "approval" && card.open && card.status === "pending" ? card.batchKey : undefined);

describe("uploads gathered into one card (approvalBatches)", () => {
  it("keeps every card exactly once, each entry where its first card was", property((tc) => {
    const cards = tc.draw(cardLists);
    const entries = approvalBatches(cards);
    const ids = entries.flatMap((entry) => (entry.kind === "card" ? [entry.card.id] : entry.cards.map((card) => card.id)));
    expect([...ids].sort()).toEqual(cards.map((card) => card.id).sort());
    const firsts = entries.map((entry) => cards.findIndex((card) => card.id === (entry.kind === "card" ? entry.card.id : entry.cards[0]!.id)));
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  }));

  it("never puts in a batch anything but two or more open, pending approvals with one key", property((tc) => {
    for (const entry of approvalBatches(tc.draw(cardLists))) {
      if (entry.kind !== "batch") continue;
      expect(entry.cards.length).toBeGreaterThanOrEqual(2);
      for (const card of entry.cards) expect(keyOf(card)).toBe(entry.key);
    }
  }));

  it("leaves no two cards that could share one apart", property((tc) => {
    const entries = approvalBatches(tc.draw(cardLists));
    const alone = entries.flatMap((entry) => (entry.kind === "card" && keyOf(entry.card) !== undefined ? [keyOf(entry.card)] : []));
    const batched = entries.flatMap((entry) => (entry.kind === "batch" ? [entry.key] : []));
    expect(new Set(alone).size).toBe(alone.length);
    for (const key of alone) expect(batched).not.toContain(key);
  }));
});

/** URLs with and without a query or fragment, in any text. */
const url = gs.fromRegex("[hH][tT][tT][pP][sS]?://[a-z0-9.-]{1,20}(/[A-Za-z0-9._~%-]{0,10}){0,3}([?#][^\\s\"'<>\\\\]{0,30})?", { fullmatch: true });
const texts = gs.arrays(gs.oneOf(gs.text(), url), { maxSize: 6 }).map((parts) => parts.join(""));

/** Each http(s) address in `text` and what follows it up to a separator: an oracle that doesn't use the code's own pattern. */
function addresses(text: string): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const scheme of ["http://", "https://"]) {
    for (let at = lower.indexOf(scheme); at !== -1; at = lower.indexOf(scheme, at + 1)) {
      let end = at;
      while (end < text.length && !/[\s"'<>\\]/.test(text[end]!)) end++;
      found.push(text.slice(at, end));
    }
  }
  return found;
}

describe("query strings never reach the screen (redactQueries)", () => {
  it("leaves no query or fragment on any address but the … that replaced it", property((tc) => {
    for (const address of addresses(redactQueries(tc.draw(texts)))) {
      const cut = address.search(/[?#]/);
      if (cut !== -1) expect(address.slice(cut + 1), address).toBe("…");
    }
  }));

  it("changes nothing in text with no ? or #", property((tc) => {
    const text = tc.draw(texts.filter((value) => !/[?#]/.test(value)));
    expect(redactQueries(text)).toBe(text);
  }));

  it("is the same done twice as once", property((tc) => {
    const once = redactQueries(tc.draw(texts));
    expect(redactQueries(once)).toBe(once);
  }));
});

describe("what a Company answered, as facts (resultFacts)", () => {
  it("never gives a fact with an address in it, from any answer", property((tc) => {
    const answer = JSON.stringify({ status: tc.draw(gs.integers({ minValue: 100, maxValue: 599 })), body: tc.draw(jsonValues(3)) });
    // The agent cuts what it keeps at 2,000 characters, so a cut one counts too.
    const kept = answer.slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: answer.length })));
    for (const fact of resultFacts(kept).facts) expect(fact).not.toContain("://");
  }));

  it("reads any text without throwing, and gives at most five facts", property((tc) => {
    expect(resultFacts(tc.draw(gs.text())).facts.length).toBeLessThanOrEqual(5);
  }));
});

/** Just enough of a Company for `tokenHostAllowed`: its domain and no other hosts. */
const shop = { domain: "shop.example", poppyDomains: [], apis: [], extensions: {}, signIn: {} } as unknown as Company;

/** Terms of any shape, with addresses on and off the Company's hosts dropped in under preview-like and other keys. */
const termsWithLinks = gs.tuples(
  jsonValues(3),
  gs.arrays(
    gs.tuples(
      gs.sampledFrom(["preview", "previews", "cover_preview", "image", "checkout_url"]),
      gs.oneOf(gs.urls(), gs.sampledFrom(["https://shop.example/p/1?sig=x", "https://cdn.shop.example/p/2", "http://shop.example/p/3", "https://evil.example/p", "https://user:pw@shop.example/p", "javascript:alert(1)"]))
    ),
    { maxSize: 6 }
  )
).map(([base, links]) => ({ base, ...Object.fromEntries(links.map(([key, value], index) => [`${key}${index}`, value])), items: links.map(([key, value]) => ({ [key]: value })) }));

describe("an order's previews and total (termsPreviews, termsTotal)", () => {
  it("links only HTTPS previews on the Company's own hosts, without credentials, at most twelve", property((tc) => {
    for (const preview of termsPreviews(shop, tc.draw(termsWithLinks))) {
      const url = new URL(preview.url);
      expect(url.protocol).toBe("https:");
      expect(url.username + url.password).toBe("");
      expect(url.hostname === "shop.example" || url.hostname.endsWith(".shop.example"), url.hostname).toBe(true);
    }
  }));

  it("finds the total nearest the top, and none where the terms name none", () => {
    expect(termsTotal({ items: [{ price: { amount: "10.00", currency: "USD" } }], total: { amount: "15.00", currency: "USD" } })).toEqual({ amount: "15.00", currency: "USD" });
    expect(termsTotal({ quote: { subtotal: { amount: 1000, currency: "USD" }, grand_total: { amount: 1450, currency: "USD" } } })).toEqual({ amount: "1450", currency: "USD" });
    expect(termsTotal({ subtotal: { amount: "9.00", currency: "USD" } })).toBeUndefined();
    expect(termsTotal({ price: { amount: "10.00", currency: "USD" } })).toBeUndefined();
    expect(termsPreviews(shop, { items: [{ preview: "https://shop.example/p/1" }] })).toEqual([{ label: "items 1 preview", url: "https://shop.example/p/1" }]);
  });
});
