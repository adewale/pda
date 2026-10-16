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

  const createClient = async () => {
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
    return { client, company, cards, sql };
  };
  return { ...await createClient(), mock, createClient, hosts: hostsFor(id) };
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
      const steps = tc.draw(gs.arrays(runs, { minSize: 1, maxSize: 6 })).flat();
      await agrees(w, model);
      for (const [index, command] of steps.entries()) {
        tc.note(`step ${index}: ${command}`);
        await run(w, model, command, tc);
        await agrees(w, model);
      }
    })
  );
});

type IsolatedClient = Awaited<ReturnType<World["createClient"]>>;
type IsolatedModel = {
  signedIn: Set<number>;
  conversations: Map<string, { label: number; texts: string[]; closed: boolean }>;
  operations: Map<string, { label: number; state: string }>;
};

describe("two PDA clients and two accounts in one generated world", () => {
  it("keeps identities, sessions, Account Tokens, conversations and operations isolated after every action", propertyAsync(async (tc) => {
    const config = {
      rotateRefreshTokens: tc.draw(gs.booleans()), reuseDetection: tc.draw(gs.booleans()),
      requireNonce: tc.draw(gs.booleans()), strictAssertions: tc.draw(gs.booleans()),
      nonceScope: tc.draw(gs.sampledFrom(["company", "origin"])),
      endSessionsOnSignOut: tc.draw(gs.booleans()), streaming: false
    };
    const w = await world(config);
    const clients: IsolatedClient[] = [w, await w.createClient()];
    const labels = [...tc.draw(gs.sets(gs.fromRegex("[a-z]{1,8}", { fullmatch: true }), { minSize: 2, maxSize: 2 }))];
    const accounts = tc.draw(gs.booleans()) ? ["acct_ada", "acct_grace"] : ["acct_grace", "acct_ada"];
    const models: IsolatedModel[] = clients.map(() => ({ signedIn: new Set(), conversations: new Map(), operations: new Map() }));
    const performed = new Set<string>();
    const userIds = clients.map(({ client, company }) => client.userId(company.issuer));
    expect(new Set(userIds).size).toBe(2);

    const signIn = async (who: number, label: number) => {
      const { client, company, cards } = clients[who]!;
      const started = await startSignIn(client, company, { label: labels[label]!, account: labels[label]!, scopes: ["poppy:read", "poppy:write"], reason: "isolation model", type: "direct" });
      if (started.status === "waiting") {
        const card = cards.get(`signin-${started.signInId}`) as Extract<Card, { kind: "signin_link" }>;
        const location = await w.mock.approveAuthorization(card.url, { approve: true, account: accounts[label]! });
        expect((await completeDirectSignIn(client, new URL(location))).ok).toBe(true);
      }
      models[who]!.signedIn.add(label);
    };

    const agrees = async () => {
      const tokenOwners = new Map<string, string>();
      for (const [who, { client, company }] of clients.entries()) {
        for (const label of [0, 1]) {
          const token = await client.token(company, { label: labels[label]! });
          // Every active Session has its own token. Neither a cache nor a
          // refresh may hand one client's/label's token to another.
          expect(tokenOwners.has(token.value)).toBe(false);
          tokenOwners.set(token.value, `${who}/${label}`);
        }
      }
      const state = await w.mock.state();
      expect(state.recorded).toEqual([]);
      expect(state.accountTokens).toBe(models.reduce((count, model) => count + model.signedIn.size, 0));
      expect(state.performs).toBe(performed.size);
      expect(new Set(state.userIds)).toEqual(new Set(userIds));
      const allOperations = new Map(models.flatMap((model) => [...model.operations].map(([id, op]) => [id, op.state] as const)));
      expect(new Map(state.operations.map((op) => [op.id, op.state]))).toEqual(allOperations);
      for (const [who, { client, company, sql }] of clients.entries()) {
        const model = models[who]!;
        expect(new Set(client.accounts(company.issuer).map((row) => row.account))).toEqual(new Set([...model.signedIn].map((label) => labels[label])));
        for (const label of [0, 1]) {
          const session = client.session(company.issuer, labels[label]!)!;
          expect(session.signed_in).toBe(model.signedIn.has(label) ? 1 : 0);
          expect(session.account).toBe(model.signedIn.has(label) ? labels[label] : null);
          const remote = state.sessions.find((row) => row.id === session.session_id)!;
          expect(remote).toMatchObject({ userId: userIds[who], account: model.signedIn.has(label) ? accounts[label] : null, ended: false });
        }
        expect(new Set(openConversations(client).map((row) => row.id))).toEqual(new Set([...model.conversations].filter(([, entry]) => !entry.closed).map(([id]) => id)));
        expect(new Set(sql.exec("SELECT operation_id FROM poppy_operations").toArray().map((row) => row.operation_id))).toEqual(new Set(model.operations.keys()));
        for (const [id, op] of model.operations) {
          expect(operation(client, company.issuer, id)?.state).toBe(op.state);
          expect(operation(clients[1 - who]!.client, company.issuer, id)).toBeUndefined();
        }
        for (const [id, expected] of model.conversations) {
          const remote = state.conversations.find((row) => row.id === id)!;
          expect(remote.sent).toEqual(expected.texts.map((text) => `agent:${text}`));
          expect(conversation(clients[1 - who]!.client, id)).toBeUndefined();
        }
      }
    };

    // Every case reaches both users and both accounts before random actions;
    // the interleaving and subsequent actions remain generated.
    const first = tc.draw(gs.booleans()) ? [0, 1] : [1, 0];
    for (const who of first) for (const label of [0, 1]) { await signIn(who, label); await agrees(); }
    const source = clients[0]!;
    const sourceToken = source.client.accounts(source.company.issuer).find((row) => row.account === labels[0])!.token;
    for (const [who, label] of [[1, 0], [0, 1]] as const) {
      const target = clients[who]!;
      const original = target.client.accounts(target.company.issuer).find((row) => row.account === labels[label])!.token;
      target.sql.exec("UPDATE poppy_accounts SET token = ? WHERE issuer = ? AND account = ?", sourceToken, target.company.issuer, labels[label]);
      target.client.dropToken(target.company, { label: labels[label]! });
      try {
        // Both clients share the deployment encryption key: only the
        // independently allocated User ID/account context prevents this swap.
        await expect(target.client.token(target.company, { label: labels[label]! })).rejects.toMatchObject({ name: "OperationError" });
      } finally {
        target.sql.exec("UPDATE poppy_accounts SET token = ? WHERE issuer = ? AND account = ?", original, target.company.issuer, labels[label]);
      }
      await agrees();
    }
    const actions = tc.draw(gs.arrays(gs.tuples(
      gs.integers({ minValue: 0, maxValue: 1 }), gs.integers({ minValue: 0, maxValue: 1 }),
      gs.sampledFrom(["signIn", "signOut", "renew", "orders", "message", "read", "close", "propose", "approve", "decline"] as const)
    ), { minSize: 1, maxSize: 25 }));
    for (const [step, [who, label, action]] of actions.entries()) {
      tc.note(`${step}: client=${who} label=${labels[label]} ${action}`);
      const { client, company } = clients[who]!;
      const model = models[who]!;
      const open = [...model.operations].filter(([, op]) => op.label === label && op.state === "proposed");
      if (action === "signIn") await signIn(who, label);
      else if (action === "signOut" && model.signedIn.has(label)) {
        await signOut(client, company.issuer, labels[label]!);
        model.signedIn.delete(label);
      } else if (action === "renew") client.dropToken(company, { label: labels[label]! });
      else if (action === "orders") {
        if (model.signedIn.has(label)) {
          const result = await callOpenApi(client, company, labels[label]!, { operation: "listOrders", callKey: crypto.randomUUID() });
          expect(result).toMatchObject({ status: 200, body: { orders: [{ order_id: "ord_7Hk2", account: accounts[label] }] } });
        }
      } else if (action === "message") {
        const existing = [...model.conversations].filter(([, item]) => item.label === label && !item.closed);
        const id = existing.length && tc.draw(gs.booleans()) ? tc.draw(gs.sampledFrom(existing))[0] : undefined;
        const text = `hello client ${who} ${labels[label]} step ${step} ${tc.draw(gs.text({ alphabet: "abcXYZ012", maxSize: 12 }))}`;
        const sent = await sendMessage(client, company, { label: labels[label]!, callKey: crypto.randomUUID(), sender: "agent", text, ...(id ? { conversationId: id } : {}) });
        const entry = model.conversations.get(sent.conversationId) ?? { label, texts: [], closed: false };
        entry.texts.push(text);
        model.conversations.set(sent.conversationId, entry);
      } else if (action === "read" || action === "close") {
        const existing = [...model.conversations].filter(([, item]) => item.label === label && !item.closed);
        if (existing.length) {
          const [id, entry] = tc.draw(gs.sampledFrom(existing));
          if (action === "read") await readConversation(client, id, 0, 0);
          else { await closeConversation(client, company, id); entry.closed = true; }
        }
      } else if (action === "propose" && model.signedIn.has(label) && !performed.has(accounts[label]!)) {
        const result = await callOpenApi(client, company, labels[label]!, { operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }, callKey: crypto.randomUUID() }) as { proposed: { operation_id: string } };
        const id = result.proposed.operation_id;
        if (open.length) expect(open.map(([key]) => key)).toContain(id);
        model.operations.set(id, { label, state: "proposed" });
      } else if ((action === "approve" || action === "decline") && model.signedIn.has(label) && open.length) {
        const [id, op] = tc.draw(gs.sampledFrom(open));
        if (action === "approve" && !performed.has(accounts[label]!)) {
          await approveAndConfirm(client, company.issuer, id, operation(client, company.issuer, id)!.revision, "user");
          op.state = "succeeded";
          performed.add(accounts[label]!);
        } else if (action === "decline") { await cancelOperation(client, company.issuer, id); op.state = "cancelled"; }
      }
      await agrees();
    }
  // Each default run performs hundreds of real four-account sign-in flows.
  }), Number(process.env.HEGEL_CASES ?? "0") > 0 ? 0 : 120_000);
});

describe("PDA audience fallback with real token renewal and revocation", () => {
  it("renews and revokes under each audience reading, including token-endpoint-only S1", propertyAsync(async (tc) => {
    const reading = tc.draw(gs.sampledFrom(["lenient", "exact", "token-endpoint"] as const));
    const w = await world({ clientAssertionAud: reading, requireNonce: tc.draw(gs.booleans()),
      nonceScope: tc.draw(gs.sampledFrom(["company", "origin"] as const)),
      strictAssertions: tc.draw(gs.booleans()), rotateRefreshTokens: tc.draw(gs.booleans()),
      endSessionsOnSignOut: tc.draw(gs.booleans()) });
    const model: Model = { signedIn: false, operations: new Map(), performs: 0, conversations: new Set() };
    await run(w, model, "signIn", tc);
    await agrees(w, model);
    w.client.dropToken(w.company);
    await w.client.token(w.company);
    await agrees(w, model);
    await run(w, model, "signOut", tc);
    await agrees(w, model);
    const revocations = (await w.mock.state()).requests.filter((request) => request.url === w.hosts.revocationEndpoint);
    expect(revocations.map((request) => request.status)).toEqual(reading === "token-endpoint" ? [401, 200] : [200]);
    if (reading === "token-endpoint") expect(revocations[0]!.error).toBe("invalid_client");
  }));
});

export type { Company };
