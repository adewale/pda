import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { memoryState } from "../../interop/impls/shared/cloudflare-workers";
import { memorySql } from "../../interop/impls/pda-agent/sqlite";
import { callOpenApi } from "../../src/poppy/apis";
import { PoppyClient, PoppyError, type PoppyHost } from "../../src/poppy/client";
import { closeConversation, conversation, openConversations, readConversation, sendMessage } from "../../src/poppy/conversations";
import { type Company } from "../../src/poppy/discovery";
import { readSigningKeys } from "../../src/poppy/keys";
import { CompanyLimiter } from "../../src/poppy/limiter";
import { approveAndConfirm, cancelOperation, operation } from "../../src/poppy/operations";
import { clientMetadata } from "../../src/poppy/routes";
import { completeDirectSignIn, signOut, startSignIn } from "../../src/poppy/signin";
import { migrate } from "../../src/poppy/store";
import type { Card } from "../../src/poppy/wire";
import { MockCompany } from "../mock-company/index";
import { companyIdFromHost, hostsFor } from "../mock-company/types";
import { gs, propertyAsync } from "./hegel";

/**
 * A model-based property: any sequence of honest things a User and their
 * agent do (sign in, talk, renew, propose, approve or decline, sign out) runs
 * our client (src/poppy, in Node) against the strict mock Company in
 * process, through a fetcher, with no sockets. After every step the mock has
 * recorded no violation, and the client and the Company agree with a small
 * model: who is signed in, which operations exist and in what state, and how
 * many things were actually done. No crashes, evictions or durability: those
 * are the Workers and durability suites' business.
 */

const ORIGIN = "https://agent.test";

async function world(config: Record<string, unknown>) {
  const keys = [];
  for (const kid of ["m-current", "m-next"]) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    keys.push({ ...(await exportJWK(privateKey)), kid, alg: "ES256", use: "sig" });
  }
  const limiters = new Map<string, CompanyLimiter>();
  const env = {
    PUBLIC_ORIGIN: ORIGIN,
    POPPY_CLIENT_NAME: "Model Agent",
    POPPY_LOGO_URI: `${ORIGIN}/logo.svg`,
    POPPY_SIGNING_JWKS: JSON.stringify(keys),
    TOKEN_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    CompanyLimiter: {
      getByName(name: string) {
        let limiter = limiters.get(name);
        if (!limiter) limiters.set(name, (limiter = new CompanyLimiter(memoryState(name) as never, {} as Env)));
        return limiter;
      }
    }
  } as unknown as Env;

  const id = `m${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const mock = new MockCompany(memoryState(id) as never, env);
  await mock.configure({ deviceInterval: 1, ...config });
  await mock.serveClientDocument(`${ORIGIN}/poppy/client.json`, clientMetadata(env));
  await mock.serveClientDocument(`${ORIGIN}/poppy/jwks.json`, { keys: (await readSigningKeys(env)).map((key) => key.publicJwk) });

  const sql = memorySql();
  migrate(sql);
  const cards = new Map<string, Card>();
  const host: PoppyHost = {
    env,
    sql,
    fetcher: async (request) =>
      companyIdFromHost(new URL(request.url).host) === id ? mock.fetch(request) : new Response("No network here", { status: 502 }),
    showCard: async (card) => void cards.set(card.id, card),
    notifyModel: async () => undefined,
    schedule: async () => undefined,
    hasJob: () => false,
    pushDirect: () => undefined,
    userContext: () => ({ locale: "en-GB", time_zone: "Europe/London", user_available: true }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  };
  const client = new PoppyClient(host);
  const company = await client.company(hostsFor(id).domain);
  return { mock, client, company, cards, hosts: hostsFor(id) };
}

type World = Awaited<ReturnType<typeof world>>;

/** What should be true: the model. */
type Model = {
  signedIn: boolean;
  /** Operation id → its state, as the Company should hold it. */
  operations: Map<string, string>;
  /** Exchanges actually made. */
  performs: number;
  conversations: Set<string>;
};

/** The exchange the mock's API proposes as an operation. */
const exchange = (w: World, callKey: string) =>
  callOpenApi(w.client, w.company, "main", {
    operation: "exchangeItem",
    params: { order_id: "ord_7Hk2" },
    body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" },
    callKey
  });

const COMMANDS = ["signIn", "signOut", "message", "read", "close", "renew", "propose", "approve", "decline"] as const;
type Command = (typeof COMMANDS)[number];

async function run(w: World, model: Model, command: Command, tc: Parameters<Parameters<typeof propertyAsync>[0]>[0]): Promise<void> {
  const open = () => [...model.operations].filter(([, state]) => state === "proposed").map(([id]) => id);
  switch (command) {
    case "signIn": {
      const started = await startSignIn(w.client, w.company, { label: "main", scopes: ["poppy:read", "poppy:write"], reason: "model" });
      if (started.status === "waiting") {
        const card = w.cards.get(`signin-${started.signInId}`) as Extract<Card, { kind: "signin_link" }>;
        const location = await w.mock.approveAuthorization(card.url, { approve: true, account: "acct_ada" });
        expect((await completeDirectSignIn(w.client, new URL(location))).ok).toBe(true);
      }
      model.signedIn = true;
      return;
    }
    case "signOut":
      if (!model.signedIn) return;
      await signOut(w.client, w.company.issuer, "default");
      model.signedIn = false;
      return;
    case "message": {
      const id = model.conversations.size ? tc.draw(gs.optional(gs.sampledFrom([...model.conversations].sort()))) : null;
      const text = tc.draw(gs.sampledFrom(["hello", "Is the sale still on?", "Can a person help?"]));
      const sent = await sendMessage(w.client, w.company, { label: "main", callKey: crypto.randomUUID(), sender: "agent", text, ...(id ? { conversationId: id } : {}) });
      model.conversations.add(sent.conversationId);
      return;
    }
    case "read": {
      if (model.conversations.size === 0) return;
      await readConversation(w.client, tc.draw(gs.sampledFrom([...model.conversations].sort())), 0, 0);
      return;
    }
    case "close": {
      if (model.conversations.size === 0) return;
      const id = tc.draw(gs.sampledFrom([...model.conversations].sort()));
      await closeConversation(w.client, w.company, id);
      model.conversations.delete(id);
      expect(conversation(w.client, id)?.status).toBe("closed");
      return;
    }
    case "renew":
      // As when a Session Token expires: the next request gets a new one.
      w.client.dropToken(w.company);
      return;
    case "propose": {
      if (!model.signedIn) {
        await expect(exchange(w, crypto.randomUUID())).rejects.toBeInstanceOf(PoppyError);
        return;
      }
      const result = (await exchange(w, crypto.randomUUID())) as { proposed?: { operation_id: string } };
      const id = result.proposed!.operation_id;
      // One open operation for the same action: the Company returns it again (Ops 4).
      if (open().length > 0) expect(open()).toContain(id);
      model.operations.set(id, "proposed");
      return;
    }
    case "approve": {
      // The jacket can be exchanged once, so the User approves only the first.
      if (!model.signedIn || open().length === 0 || model.performs > 0) return;
      const id = tc.draw(gs.sampledFrom(open()));
      await approveAndConfirm(w.client, w.company.issuer, id, operation(w.client, w.company.issuer, id)!.revision, "user");
      model.operations.set(id, "succeeded");
      model.performs += 1;
      return;
    }
    case "decline": {
      if (!model.signedIn || open().length === 0) return;
      const id = tc.draw(gs.sampledFrom(open()));
      await cancelOperation(w.client, w.company.issuer, id);
      model.operations.set(id, "cancelled");
      return;
    }
  }
}

async function agrees(w: World, model: Model): Promise<void> {
  const state = await w.mock.state();
  expect(state.recorded).toEqual([]);
  expect(state.performs).toBe(model.performs);
  expect(new Map(state.operations.map((op) => [op.id, op.state]))).toEqual(model.operations);
  for (const [id, expected] of model.operations) expect(operation(w.client, w.company.issuer, id)?.state, id).toBe(expected);
  expect(w.client.accounts(w.company.issuer).length).toBe(model.signedIn ? 1 : 0);
  expect(state.accountTokens).toBe(model.signedIn ? 1 : 0);
  expect(new Set(openConversations(w.client).map((row) => row.id))).toEqual(model.conversations);
}

describe("our client against the mock Company, any honest sequence (model-based)", () => {
  it(
    "records no violation, and the client and the Company agree with the model after every step",
    propertyAsync(async (tc) => {
      // The Company's readings and behaviours are inputs too.
      const config = {
        rotateRefreshTokens: tc.draw(gs.booleans()),
        reuseDetection: tc.draw(gs.booleans()),
        requireNonce: tc.draw(gs.booleans()),
        nonceScope: tc.draw(gs.sampledFrom(["company", "origin"])),
        clientAssertionAud: tc.draw(gs.sampledFrom(["lenient", "exact"])),
        strictAssertions: tc.draw(gs.booleans()),
        endSessionsOnSignOut: tc.draw(gs.booleans()),
        omitTokenScope: tc.draw(gs.booleans()),
        streaming: tc.draw(gs.booleans())
      };
      const w = await world(config);
      const model: Model = { signedIn: false, operations: new Map(), performs: 0, conversations: new Set() };
      // Single steps in any order, and the runs a User actually makes, so a
      // short sequence still reaches a confirm: sign in, propose, decide.
      const runs = gs.oneOf(
        gs.sampledFrom(COMMANDS).map((command) => [command]),
        gs.sampledFrom<Command[]>([
          ["signIn", "propose", "approve"],
          ["signIn", "propose", "decline"],
          ["signIn", "message", "propose", "renew", "approve"],
          ["message", "read", "close"],
          ["signIn", "renew", "signOut", "propose"]
        ])
      );
      const steps = tc.draw(gs.arrays(runs, { maxSize: 6 })).flat();
      for (const [index, command] of steps.entries()) {
        tc.note(`step ${index}: ${command}`);
        await run(w, model, command, tc);
        await agrees(w, model);
      }
    })
  );
});

export type { Company };
