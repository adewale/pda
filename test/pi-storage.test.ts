import { env, runInDurableObject } from "cloudflare:test";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { openPiSessionStore } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import type { StorageProbe } from "./worker";

/**
 * pi-durable's own storage conformance suite, run on the storage the agent
 * really uses: `agents`' adapter (`openPiSessionStore`), which puts pi's
 * tables under a prefix in the Durable Object's SQLite, beside ours. pi's
 * contract and the adapter come from two packages that move separately; a
 * case failing here, after either is upgraded, is the adapter's or pi's,
 * not ours.
 */
const probes = (env as unknown as { STORAGE_PROBE: DurableObjectNamespace<StorageProbe> }).STORAGE_PROBE;

/** Tables of ours whose names pi's would take without the prefix, as the agent's own sit beside pi's. */
const HOST_TABLES = ["conversations", "entries", "tasks", "submissions", "documents"];

function withProbeStorage(hostTables: boolean) {
  return (use: Parameters<Parameters<typeof registerStorageConformance>[2]>[0]) =>
    runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      if (hostTables) {
        for (const name of HOST_TABLES) state.storage.sql.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, ours TEXT NOT NULL)`);
      }
      await use(await openPiSessionStore(state.storage));
    });
}

registerStorageConformance({ describe, expect, it }, "pi storage on an agent's SQLite", withProbeStorage(false));
registerStorageConformance({ describe, expect, it }, "pi storage beside host tables", withProbeStorage(true));

describe("pi storage beside host tables", () => {
  it("leaves the host's tables as they were", async () => {
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      for (const name of HOST_TABLES) {
        state.storage.sql.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, ours TEXT NOT NULL)`);
        state.storage.sql.exec(`INSERT INTO ${name} VALUES ('a', 'kept')`);
      }
      await openPiSessionStore(state.storage);
      for (const name of HOST_TABLES) {
        expect(state.storage.sql.exec(`SELECT id, ours FROM ${name}`).toArray()).toEqual([{ id: "a", ours: "kept" }]);
      }
      const names = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
        .toArray()
        .map((row) => String(row.name));
      // Every table and index pi made is under its prefix.
      expect(names.filter((name) => !HOST_TABLES.includes(name) && !name.startsWith("pi_"))).toEqual([]);
      expect(names.some((name) => name.startsWith("pi_"))).toBe(true);
    });
  });
});
