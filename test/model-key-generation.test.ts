import { env, runInDurableObject } from "cloudflare:test";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { Ledger } from "../src/budget";
import { ModelAccess, demoCatalogModel, nativeProviders } from "../src/model-router";
import { ModelKeys, SealedCredentialStore, type KeyVersion } from "../src/model-keys";
import { Sealer } from "../src/poppy/store";
import type { StorageProbe } from "./worker";

const testEnv = env as Env;
const probes = (env as unknown as { STORAGE_PROBE: DurableObjectNamespace<StorageProbe> }).STORAGE_PROBE;
const original = "sk-ant-test-original-01234567890123456789";
const replacement = "sk-ant-test-replacement-01234567890123456789";

function accessFor(keys: ModelKeys, state: DurableObjectState, refused: string[]) {
  return new ModelAccess({
    env: testEnv, keys, ledger: new Ledger(state.storage.sql),
    profile: () => ({ provider: "google", sub: "key-generation", email: "owner@example.com", domain: null }),
    lists: () => testEnv, agent: state.id.toString(), domainBudget: name => testEnv.DomainBudget.getByName(name),
    demoLane: () => { throw new Error("Must not use demo"); }, ownKeyProviders: nativeProviders,
    onRefused: async () => {}, onKeyRefused: async provider => { refused.push(provider); }
  });
}

async function waitingCall(access: ModelAccess) {
  const inner = createAssistantMessageEventStream();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const result = access.route(demoCatalogModel(testEnv), () => { started(); return inner; }).result();
  await Promise.race([ready, result.then(() => { throw new Error("Call ended before dispatch"); })]);
  return { result, fail: () => {
    const error = fauxAssistantMessage([], { stopReason: "error", errorMessage: `401 invalid_api_key ${original}` });
    inner.push({ type: "error", reason: "error", error });
  } };
}

it.each(["same provider", "different provider", "removed and restored", "removed"] as const)("a late 401 leaves a key %s unchanged", async change => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
    const keys = new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString());
    await keys.put("anthropic", original);
    const refused: string[] = [];
    const access = accessFor(keys, state, refused);
    const call = await waitingCall(access);
    if (change === "removed" || change === "removed and restored") keys.remove();
    if (change !== "removed") await keys.put(change === "different provider" ? "openai" : "anthropic", replacement);
    const saved = keys.info();
    call.fail();
    const answer = await call.result;
    expect(keys.info()).toEqual(saved);
    expect(refused).toEqual([]);
    expect(answer.errorMessage).toContain("This call used an earlier key");
    expect(answer.errorMessage).not.toContain(original);
    expect(answer.errorMessage).not.toContain(replacement);
    if (saved) {
      expect(saved.status).toBe("valid");
      expect((await access.entitlement()).reason).toBeNull();
    }
  });
});

it("overlapping calls invalidate only the current key and publish one refusal notice", async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
    const keys = new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString());
    await keys.put("anthropic", original);
    const refused: string[] = [];
    const access = accessFor(keys, state, refused);
    const first = await waitingCall(access), second = await waitingCall(access);
    first.fail(); second.fail();
    const answers = await Promise.all([first.result, second.result]);
    expect(keys.info()).toMatchObject({ provider: "anthropic", status: "invalid" });
    expect(refused).toEqual(["anthropic"]);
    for (const answer of answers) expect(answer.errorMessage).toContain("Model calls are stopped");
    expect((await access.entitlement()).reason).toBe("key_invalid");
  });
});

it("a selected call cannot read a replacement key or combine it with the previous workspace", async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
    const keys = new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString());
    await keys.put("anthropic", original, "old_workspace");
    const access = accessFor(keys, state, []);
    const selected = (await access.decide()).lane!;
    await keys.put("anthropic", replacement, "new_workspace");
    expect(await selected.models.getAuth(selected.model)).toBeUndefined();
    const fresh = (await access.decide()).lane!;
    const auth = await fresh.models.getAuth(fresh.model);
    expect(auth?.auth).toMatchObject({ apiKey: replacement, headers: { "anthropic-workspace-id": "new_workspace" } });
    expect(selected.model.headers?.["anthropic-workspace-id"]).toBe("old_workspace");
    expect(Object.keys((await access.entitlement()).key!)).toEqual(["provider", "status", "source", "addedAt", "workspace"]);
  });
});

it("replacement during decryption prevents the old credential from being returned", async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
    const sealer = new Sealer(testEnv);
    const keys = new ModelKeys(state.storage.sql, () => sealer, state.id.toString());
    await keys.put("anthropic", original);
    const version = keys.current()!.version;
    let decrypted!: () => void, resume!: () => void;
    const ready = new Promise<void>(resolve => { decrypted = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    const openChecked = sealer.openChecked.bind(sealer);
    const opening = vi.spyOn(sealer, "openChecked").mockImplementationOnce(async (...args) => {
      const result = await openChecked(...args);
      decrypted(); await release;
      return result;
    });
    try {
      const credential = new SealedCredentialStore(keys, version).read("anthropic");
      await ready;
      await keys.put("anthropic", replacement);
      resume();
      expect(await credential).toBeUndefined();
      expect(await keys.open("anthropic")).toBe(replacement);
    } finally { opening.mockRestore(); resume(); }
  });
});

it("encryption-key rotation preserves the saved key's version", async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
    const keys = new ModelKeys(state.storage.sql, () => new Sealer(testEnv), state.id.toString());
    await keys.put("anthropic", original);
    const version = keys.current()!.version;
    const rotatedKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const rotated = new ModelKeys(state.storage.sql, () => new Sealer({ TOKEN_ENC_KEY: rotatedKey, TOKEN_ENC_KEY_PREVIOUS: testEnv.TOKEN_ENC_KEY }), state.id.toString());
    expect(await rotated.open("anthropic", version)).toBe(original);
    expect(rotated.current()!.version).toEqual(version);
    expect(rotated.markInvalid(version)).toBe(true);
    expect(rotated.info()!.status).toBe("invalid");
  });
});

it("an existing key acquires a stable private version when the schema is migrated", async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
    const sql = state.storage.sql;
    sql.exec("CREATE TABLE model_keys (slot INTEGER PRIMARY KEY, provider TEXT, sealed TEXT, status TEXT, source TEXT, added_at INTEGER, invalid_at INTEGER, workspace TEXT)");
    sql.exec("INSERT INTO model_keys VALUES (1, 'anthropic', 'not-opened', 'valid', 'pasted', 1, NULL, NULL)");
    const first = new ModelKeys(sql, () => new Sealer(testEnv), state.id.toString());
    const version: KeyVersion = first.current()!.version;
    expect(new ModelKeys(sql, () => new Sealer(testEnv), state.id.toString()).current()!.version).toEqual(version);
    expect(first.markInvalid(version)).toBe(true);
  });
});
