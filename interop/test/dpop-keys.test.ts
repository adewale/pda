import { describe, expect, it } from "vitest";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client.ts";
import { toIssuer } from "../../src/poppy/issuer.ts";
import { migrate } from "../../src/poppy/store.ts";
import { memorySql } from "../impls/pda-agent/sqlite.ts";

describe("DPoP keys (4.5)", () => {
  it("uses each DPoP key for one User ID: one per issuer and User ID, and a new one when the User ID changes", async () => {
    const sql = memorySql();
    migrate(sql);
    const host = {
      env: { PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Key test", POPPY_LOGO_URI: "https://agent.example/logo.svg", TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64") },
      sql, fetcher: async () => new Response(null, { status: 502 }), now: () => Date.now()
    } as unknown as PoppyHost;
    const client = new PoppyClient(host);
    const shop = toIssuer("https://auth.shop.example"), other = toIssuer("https://auth.other.example");
    const first = await client.dpopKey(shop);
    expect(await client.dpopKey(shop)).toBe(first);
    expect((await client.dpopKey(other)).thumbprint).not.toBe(first.thumbprint);
    // Nothing rotates a User ID today; if something did, the old key must not follow it.
    sql.exec("UPDATE poppy_user_ids SET user_id = ? WHERE issuer = ?", "usr_replaced", shop);
    const replaced = await client.dpopKey(shop);
    expect(replaced.thumbprint).not.toBe(first.thumbprint);
    expect(await client.dpopKey(shop)).toBe(replaced);
  });
});
