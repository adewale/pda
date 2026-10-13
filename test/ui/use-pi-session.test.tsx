import { describe, expect, it } from "vitest";
import type { Card, DirectUpdate } from "../../src/poppy/wire";
import { reducePoppy, type PoppyView } from "../../src/use-pi-session";
import { toIssuer } from "../../src/poppy/issuer";

/** How the page folds Poppy frames from the agent into what it shows. */

const EMPTY: PoppyView = { cards: [], accounts: [], permissions: [], direct: {}, activity: null, protocol: { companies: null, logs: {} } };

const notice = (id: string, text = id): Card => ({ id, kind: "notice", company: "Acme", open: false, text });
const approval = (id: string): Card => ({ id, kind: "approval", company: "Acme", open: true, approvalId: id, summary: "Submit", status: "pending" });

describe("reducePoppy", () => {
  it("replaces the cards with a full list", () => {
    const before = { ...EMPTY, cards: [approval("a"), approval("b")] };
    const after = reducePoppy(before, { type: "poppy.cards", cards: [approval("b"), approval("c")] });
    expect(after.cards.map((card) => card.id)).toEqual(["b", "c"]);
  });

  it("replaces with a list of one ordinary card, and with an empty list", () => {
    const before = { ...EMPTY, cards: [approval("a"), approval("b")] };
    expect(reducePoppy(before, { type: "poppy.cards", cards: [approval("c")] }).cards.map((card) => card.id)).toEqual(["c"]);
    expect(reducePoppy(before, { type: "poppy.cards", cards: [] }).cards).toEqual([]);
  });

  it("appends a single error notice, replacing one with the same id", () => {
    let view: PoppyView = { ...EMPTY, cards: [approval("a")] };
    view = reducePoppy(view, { type: "poppy.cards", cards: [notice("error-1", "first")] });
    expect(view.cards.map((card) => card.id)).toEqual(["a", "error-1"]);
    view = reducePoppy(view, { type: "poppy.cards", cards: [notice("error-2")] });
    expect(view.cards.map((card) => card.id)).toEqual(["a", "error-1", "error-2"]);
    view = reducePoppy(view, { type: "poppy.cards", cards: [notice("error-1", "again")] });
    expect(view.cards.map((card) => card.id)).toEqual(["a", "error-2", "error-1"]);
    expect(view.cards.filter((card) => card.id === "error-1")).toEqual([notice("error-1", "again")]);
  });

  it("replaces settings whole and leaves cards alone", () => {
    const before = { ...EMPTY, cards: [approval("a")] };
    const accounts = [{ issuer: toIssuer("https://auth.acme.example"), company: "Acme", account: "a***", scope: "poppy:read", expiresAt: null }];
    const after = reducePoppy(before, { type: "poppy.settings", accounts, permissions: [] });
    expect(after).toEqual({ ...before, accounts, permissions: [] });
    expect(reducePoppy(after, { type: "poppy.settings", accounts: [], permissions: [] }).accounts).toEqual([]);
  });

  it("keeps the latest update per Direct Conversation", () => {
    const update = (conversationId: string, status: string): DirectUpdate => ({ conversationId, company: "Acme", status, responder: "agent" });
    let view = reducePoppy(EMPTY, { type: "poppy.direct", update: update("c1", "open") });
    view = reducePoppy(view, { type: "poppy.direct", update: update("c2", "open") });
    view = reducePoppy(view, { type: "poppy.direct", update: { ...update("c1", "closed"), closed: true } });
    expect(Object.keys(view.direct)).toEqual(["c1", "c2"]);
    expect(view.direct.c1).toMatchObject({ status: "closed", closed: true });
    expect(view.cards).toEqual([]);
  });

  it("replaces the activity whole, from nothing to the agent's latest, and leaves cards alone", () => {
    const before = { ...EMPTY, cards: [approval("a")] };
    expect(before.activity).toBeNull();
    const entry = {
      id: "signin-1",
      at: 1,
      kind: "sign_in" as const,
      issuer: toIssuer("https://auth.acme.example"),
      company: "Acme",
      account: null,
      what: "Sign-in at Acme on its own page",
      how: "sign_in" as const,
      access: "view" as const,
      decidedBy: "you" as const,
      result: "done" as const
    };
    const after = reducePoppy(before, { type: "poppy.activity", inProgress: [], log: [entry] });
    expect(after).toEqual({ ...before, activity: { inProgress: [], log: [entry] } });
    expect(reducePoppy(after, { type: "poppy.activity", inProgress: [], log: [] }).activity).toEqual({ inProgress: [], log: [] });
  });

  it("ignores a Poppy frame it doesn't know", () => {
    const before = { ...EMPTY, cards: [approval("a")] };
    expect(reducePoppy(before, { type: "poppy.later" } as never)).toBe(before);
  });

  it("never changes the view it was given", () => {
    const before = Object.freeze({ ...EMPTY, cards: Object.freeze([approval("a")]), direct: Object.freeze({}) }) as PoppyView;
    reducePoppy(before, { type: "poppy.cards", cards: [notice("error-1")] });
    reducePoppy(before, { type: "poppy.direct", update: { conversationId: "c", company: "Acme", status: "open", responder: "agent" } });
    expect(before.cards.map((card) => card.id)).toEqual(["a"]);
    expect(before.direct).toEqual({});
  });
});
