import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Ledger, utcDay, type SharedBudget } from "../src/budget";
import { demoCatalogModel, gatewayDemoLane, ModelAccess, routerProvider } from "../src/model-router";
import { ModelKeys } from "../src/model-keys";
import { Sealer } from "../src/poppy/store";
import type { StorageProbe } from "./worker";

const testEnv = env as Env;
const probes = (env as unknown as { STORAGE_PROBE: DurableObjectNamespace<StorageProbe> }).STORAGE_PROBE;
const DAY = "2026-10-20";
const NEXT_DAY = "2026-10-21";
const shared = () => testEnv.DomainBudget.getByName(`budget-test-${crypto.randomUUID()}`);

describe("durable model admission and accounting", () => {
  it("preserves caller output settings on the gateway wire without a fleet output policy", async () => {
    const namespace = `budget-test-${crypto.randomUUID()}`;
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      const requests: Array<{ query: { max_tokens: number } }> = [];
      const binding = { gateway: () => ({ run: async (request: { query: { max_tokens: number } }) => {
        requests.push(request);
        return Response.json({ type: "error", error: { type: "rate_limit_error", message: "synthetic rate limit" } }, { status: 429 });
      } }) } as unknown as Ai;
      const access = new ModelAccess({
        env: testEnv,
        keys: new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString()), ledger: new Ledger(state.storage.sql),
        profile: () => ({ provider: "google", sub: "budget-test", email: "owner@example.com", domain: null }),
        lists: () => testEnv, agent: state.id.toString(), domainBudget: name => testEnv.DomainBudget.getByName(`${namespace}:${name}`),
        demoLane: route => gatewayDemoLane({ ...testEnv, AI: binding }, route), ownKeyProviders: () => [],
        onRefused: async () => {}, onKeyRefused: async () => {}, now: () => Date.parse(`${DAY}T12:00:00Z`)
      });
      const router = routerProvider(access, demoCatalogModel(testEnv));
      const answer = await router.streamSimple(router.getModels()[0], normalizeContext({ messages: [{ role: "user", content: "synthetic check", timestamp: 1 }] }),
        { maxTokens: 8192, reasoning: "high", maxRetries: 0 }).result();
      expect(answer.stopReason).toBe("error");
      expect(requests).toHaveLength(1);
      expect(requests[0].query.max_tokens).toBe(8192);
    });
  });

  it("atomically reserves shared room, is idempotent, and retains unknown liabilities after eviction", async () => {
    const domain = shared();
    const admissions = await Promise.all([
      domain.reserve("a", DAY, 1, 1.5), domain.reserve("b", DAY, 1, 1.5), domain.reserve("c", DAY, 1, 1.5)
    ]);
    expect(admissions.filter(a => a.accepted)).toHaveLength(2);
    expect(admissions.reduce((sum, a) => sum + a.reservedUsd, 0)).toBe(1.5);
    expect(await domain.spent(DAY)).toBe(1.5);
    expect(await domain.reserve("a", DAY, 1, 1.5)).toEqual(admissions[0]);
    await evictDurableObject(domain);
    expect(await domain.spent(DAY)).toBe(1.5);
    await domain.settle("a", DAY, 0.2);
    await domain.settle("a", DAY, 0.2);
    expect(await domain.spent(DAY)).toBeCloseTo(0.7);
    await runInDurableObject(domain, async instance => {
      await expect(instance.settle("a", DAY, 0.3)).rejects.toThrow("cost conflict");
      await expect(instance.settle("a", NEXT_DAY, 0.2)).rejects.toThrow("matching budget admission");
      await expect(instance.reserve("a", NEXT_DAY, 1, 1.5)).rejects.toThrow("day conflict");
    });
    expect(await domain.spent(NEXT_DAY)).toBe(0);
  });

  it("does not admit invalid amounts or settle without an admission", async () => {
    const domain = shared();
    await runInDurableObject(domain, async instance => {
      for (const amount of [-1, NaN, Infinity]) await expect(instance.reserve("bad", DAY, amount, 1)).rejects.toThrow("finite and nonnegative");
      await expect(instance.settle("unknown", DAY, 1)).rejects.toThrow("matching budget admission");
    });
    expect(await domain.reserve("zero", DAY, 1, 0)).toEqual({ accepted: false, reservedUsd: 0 });
    expect(await domain.spent(DAY)).toBe(0);
  });

  it("keeps a settlement outbox across local reconstruction and an applied RPC whose response was lost", async () => {
    const domainName = `budget-test-${crypto.randomUUID()}`;
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      const domain = testEnv.DomainBudget.getByName(domainName);
      let ledger = new Ledger(state.storage.sql);
      const call = ledger.begin(DAY, "outbox.example", 1)!;
      expect(await domain.reserve(call.id, call.day, call.reservedUsd, 1.5)).toEqual({ accepted: true, reservedUsd: 0.5 });
      ledger.complete(call, 0.25);
      let failure: "before" | "after" | "none" = "before";
      const transport: SharedBudget = {
        spent: day => domain.spent(day), charged: day => domain.charged(day), reserve: (...args) => domain.reserve(...args),
        settle: async (...args) => {
          if (failure === "before") throw new Error("transport failed before commit");
          await domain.settle(...args);
          if (failure === "after") throw new Error("reply lost after commit");
        }
      };
      const accessFor = (current: Ledger) => new ModelAccess({
        env: testEnv, keys: new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString()), ledger: current,
        profile: () => null, lists: () => testEnv, agent: state.id.toString(), domainBudget: () => transport,
        demoLane: () => { throw new Error("must not call model"); }, ownKeyProviders: () => [], onRefused: async () => {}, onKeyRefused: async () => {}
      });
      await expect(accessFor(ledger).flushSettlements()).rejects.toThrow("before commit");
      expect(ledger.spent(DAY)).toBe(0.25);
      expect(await domain.spent(DAY)).toBe(0.5);
      failure = "after";
      await expect(accessFor(ledger).flushSettlements()).rejects.toThrow("reply lost");
      expect(ledger.pending()).toHaveLength(1);
      expect(ledger.spent(DAY)).toBe(0.25);
      expect(await domain.spent(DAY)).toBe(0.25);
      ledger = new Ledger(state.storage.sql);
      failure = "none";
      const restarted = accessFor(ledger);
      await Promise.all([restarted.flushSettlements(), restarted.flushSettlements()]);
      expect(restarted.hasPendingSettlements()).toBe(false);
      expect(await domain.spent(DAY)).toBe(0.25);
      expect(ledger.spent(DAY)).toBe(0.25);
    });
  });

  it("admits two overlapping calls, refuses a third, queues notices despite holds and fixes charges to admission day", async () => {
    const domainName = `budget-test-${crypto.randomUUID()}`;
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      const domain = testEnv.DomainBudget.getByName(domainName);
      const ledger = new Ledger(state.storage.sql);
      const faux = fauxProvider();
      let now = Date.parse(`${DAY}T23:59:59Z`);
      const access = new ModelAccess({
        env: testEnv, keys: new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString()), ledger,
        profile: () => ({ provider: "google", sub: "budget-test", email: "owner@example.com", domain: null }),
        lists: () => testEnv, agent: state.id.toString(), domainBudget: () => domain,
        demoLane: () => ({ provider: faux.provider, model: faux.getModel() }), ownKeyProviders: () => [],
        onRefused: async () => {}, onKeyRefused: async () => {}, now: () => now
      });
      ledger.add(DAY, 0.1);
      const inner = createAssistantMessageEventStream();
      let started = false;
      const first = access.route(demoCatalogModel(testEnv), () => { started = true; return inner; });
      const result = first.result();
      for (let attempt = 0; !started && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
      if (!started) throw new Error(`Model admission failed: ${JSON.stringify(await result)}`);
      expect(ledger.spent(DAY)).toBe(0.6);
      let secondStarted = false;
      const secondInner = createAssistantMessageEventStream();
      const second = access.route(demoCatalogModel(testEnv), () => { secondStarted = true; return secondInner; }).result();
      for (let attempt = 0; !secondStarted && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(secondStarted).toBe(true);
      expect(ledger.spent(DAY)).toBe(1);
      expect((await access.decide()).entitlement.lane).toBe("none");
      expect((await access.decide({ forQueue: true })).entitlement.lane).toBe("demo");
      let thirdStarted = false;
      const third = await access.route(demoCatalogModel(testEnv), () => { thirdStarted = true; return createAssistantMessageEventStream(); }).result();
      expect(thirdStarted).toBe(false);
      expect(third.stopReason).toBe("error");
      now = Date.parse(`${NEXT_DAY}T00:00:01Z`);
      const answer = fauxAssistantMessage("answer");
      answer.usage.cost.total = 0.2;
      inner.push({ type: "done", reason: "stop", message: answer });
      expect((await result).stopReason).toBe("stop");
      expect(ledger.spent(DAY)).toBeCloseTo(0.7);
      expect(ledger.spent(utcDay(now))).toBe(0);
      expect(await domain.spent(DAY)).toBeCloseTo(0.6);
      expect(await domain.spent(NEXT_DAY)).toBe(0);
      const secondAnswer = fauxAssistantMessage("second answer");
      secondAnswer.usage.cost.total = 0.1;
      secondInner.push({ type: "done", reason: "stop", message: secondAnswer });
      expect((await second).stopReason).toBe("stop");
      expect(ledger.spent(DAY)).toBeCloseTo(0.4);
      expect(await domain.spent(DAY)).toBeCloseTo(0.3);
    });
  });

  it("recovers a committed local outbox after the agent's own Durable Object is evicted", async () => {
    const domainName = `budget-test-${crypto.randomUUID()}`;
    const domain = testEnv.DomainBudget.getByName(domainName);
    const probe = probes.get(probes.newUniqueId());
    const call = await runInDurableObject(probe, (_, state) => new Ledger(state.storage.sql).begin(DAY, "restart.example", 1)!);
    await domain.reserve(call.id, DAY, call.reservedUsd, 1.5);
    await runInDurableObject(probe, (_, state) => new Ledger(state.storage.sql).complete(call, 0.15));
    await evictDurableObject(probe);
    await runInDurableObject(probe, async (_, state) => {
      const ledger = new Ledger(state.storage.sql);
      expect(ledger.pending()).toHaveLength(1);
      const access = new ModelAccess({
        env: testEnv, keys: new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString()), ledger,
        profile: () => null, lists: () => testEnv, agent: state.id.toString(), domainBudget: () => testEnv.DomainBudget.getByName(domainName),
        demoLane: () => { throw new Error("must not call model"); }, ownKeyProviders: () => [], onRefused: async () => {}, onKeyRefused: async () => {}
      });
      await access.flushSettlements();
      expect(ledger.pending()).toHaveLength(0);
      expect(ledger.spent(DAY)).toBe(0.15);
    });
    expect(await domain.spent(DAY)).toBe(0.15);
  });

  it("retains admission liability when a provider reports aborted zero usage", async () => {
    const domainName = `budget-test-${crypto.randomUUID()}`;
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      const domain = testEnv.DomainBudget.getByName(domainName);
      const ledger = new Ledger(state.storage.sql);
      const faux = fauxProvider();
      let now = Date.parse(`${DAY}T12:00:00Z`);
      const access = new ModelAccess({
        env: testEnv, keys: new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString()), ledger,
        profile: () => ({ provider: "google", sub: "budget-test", email: "owner@example.com", domain: null }),
        lists: () => testEnv, agent: state.id.toString(), domainBudget: () => domain,
        demoLane: () => ({ provider: faux.provider, model: faux.getModel() }), ownKeyProviders: () => [],
        onRefused: async () => {}, onKeyRefused: async () => {}, now: () => now
      });
      const result = access.route(demoCatalogModel(testEnv), () => {
        const stream = createAssistantMessageEventStream();
        const aborted = fauxAssistantMessage([], { stopReason: "aborted" });
        aborted.usage.cost.total = 0;
        stream.push({ type: "error", reason: "aborted", error: aborted });
        return stream;
      });
      expect((await result.result()).stopReason).toBe("aborted");
      expect(ledger.spent(DAY)).toBe(0.5);
      expect(await domain.spent(DAY)).toBe(0.5);
      expect(new Ledger(state.storage.sql).spent(DAY)).toBe(0.5);
      now = Date.parse(`${NEXT_DAY}T12:00:00Z`);
      const errored = fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider interrupted after some billed tokens" });
      errored.usage.cost.total = 0.2;
      await access.route(demoCatalogModel(testEnv), () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "error", reason: "error", error: errored });
        return stream;
      }).result();
      expect(ledger.spent(NEXT_DAY)).toBe(0.2);
      expect(await domain.spent(NEXT_DAY)).toBe(0.2);
      const contextError = fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long" });
      contextError.usage.cost.total = 0;
      await access.route(demoCatalogModel(testEnv), () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "error", reason: "error", error: contextError });
        return stream;
      }).result();
      expect(ledger.spent(NEXT_DAY)).toBe(0.2);
      expect(await domain.spent(NEXT_DAY)).toBe(0.2);
      const retry = fauxAssistantMessage("compacted retry");
      retry.usage.cost.total = 0.1;
      expect((await access.route(demoCatalogModel(testEnv), () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: retry });
        return stream;
      }).result()).stopReason).toBe("stop");
      expect(ledger.spent(NEXT_DAY)).toBeCloseTo(0.3);
    });
  });

  it("does not invoke the provider when shared admission commits but its reply is lost", async () => {
    const domainName = `budget-test-${crypto.randomUUID()}`;
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      const domain = testEnv.DomainBudget.getByName(domainName);
      const ledger = new Ledger(state.storage.sql);
      const faux = fauxProvider();
      let called = false;
      const access = new ModelAccess({
        env: testEnv, keys: new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString()), ledger,
        profile: () => ({ provider: "google", sub: "budget-test", email: "owner@example.com", domain: null }),
        lists: () => testEnv, agent: state.id.toString(),
        domainBudget: () => ({
          spent: day => domain.spent(day), charged: day => domain.charged(day), settle: (...args) => domain.settle(...args),
            reserve: async (...args) => { await domain.reserve(...args); throw new Error("admission reply lost"); }
        }),
        demoLane: () => ({ provider: faux.provider, model: faux.getModel() }), ownKeyProviders: () => [],
        onRefused: async () => {}, onKeyRefused: async () => {}, now: () => Date.parse(`${DAY}T12:00:00Z`)
      });
      const result = await access.route(demoCatalogModel(testEnv), () => { called = true; return createAssistantMessageEventStream(); }).result();
      expect(result.stopReason).toBe("error");
      expect(called).toBe(false);
      expect(ledger.spent(DAY)).toBe(0.5);
      expect(await domain.spent(DAY)).toBe(0.5);
      expect(ledger.pending()).toEqual([]);
      expect(new Ledger(state.storage.sql).spent(DAY)).toBe(0.5);
    });
  });

});
