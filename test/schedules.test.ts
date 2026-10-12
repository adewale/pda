/**
 * The User's stored time zone, reminders and scheduled tasks
 * (src/schedules.ts, src/tools/schedule-store.ts, src/tools/schedules.ts).
 * Nothing calls the network: the model is the faux model, and push services
 * are the test agent's fake (`pushServe` in worker.ts).
 */
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agent } from "./agent-helpers";

const NOON = Date.UTC(2026, 9, 12, 12, 0, 0);

describe("the User's time zone", () => {
  it("keeps the zone the page last sent through an eviction, so now still answers in it", async () => {
    const { stub } = await agent();
    await stub.setClock(NOON);
    await stub.poppyFrame({ type: "poppy.context", locale: "en-GB", time_zone: "Asia/Tokyo" });
    // A page that sends no zone leaves the stored one alone.
    await stub.poppyFrame({ type: "poppy.context", locale: "en-GB" });
    expect(JSON.parse(await stub.poppySql("SELECT locale, time_zone FROM user_context"))).toEqual([{ locale: "en-GB", time_zone: "Asia/Tokyo" }]);
    await evictDurableObject(stub);
    expect(JSON.parse((await stub.generalTool("now", {})).text)).toMatchObject({ time: "21:00:00", time_zone: "Asia/Tokyo", zone_from: "the User's browser" });
    await stub.poppyFrame({ type: "poppy.context", time_zone: "Europe/London" });
    await evictDurableObject(stub);
    expect(JSON.parse((await stub.generalTool("now", {})).text)).toMatchObject({ time: "13:00:00", time_zone: "Europe/London" });
  });
});
