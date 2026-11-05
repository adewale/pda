import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { attachmentMarker } from "../src/attachments";
import type { TaskAccess } from "../src/task-access";
import { agent, chat, company, connect, requests, signInDirect, until } from "./agent-helpers";
import { obey } from "./worker";
import { migrateSchedules } from "../src/tools/schedule-store";
import { scheduleExtension } from "../src/tools/schedules";
import type { Scheduler } from "../src/schedules";

function selected(section: string | undefined): TaskAccess {
  expect(section, "the model must receive the composer's selected recipients and photos").toBeDefined();
  return JSON.parse(section!.split("\n").find(line => line.startsWith("{"))!);
}

describe("the model's task selections", () => {
  it("shows the selected Company when the User's prose does not name it", async () => {
    const c = await company();
    const a = await agent();
    const connection = await connect(a.identity);
    const access = { companies: [c.domain], uploads: [] };
    await chat(connection.socket, connection.client, "Check my order.", undefined, access);
    const request = (await a.stub.demoRequests()).at(-1)!;
    expect(request.last).toBe("Check my order.");
    expect(request.last).not.toContain(c.domain);
    expect(selected(request.sections.poppy_task_access)).toEqual(access);
    expect(request.roles.filter(role => role === "user")).toHaveLength(1);
    expect(connection.client.texts()).toContain("user: Check my order.");
    expect(await a.stub.poppyModelInputs()).toEqual(["Check my order."]);
    connection.socket.close();
  });

  it("identifies only the photo and destination selected in the composer", async () => {
    const c = await company();
    const a = await agent();
    const connection = await connect(a.identity);
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const first = await a.stub.attach(a.identity, "lake.jpg", photo.buffer, null);
    const second = await a.stub.attach(a.identity, "private.jpg", photo.buffer, null);
    if (!first.ok || !second.ok) throw new Error("Photo fixture failed");
    const access = { companies: [c.domain], uploads: [{ company: c.domain, files: [first.attachment.id] }] };
    await chat(connection.socket, connection.client, `Print the selected photo.\n${attachmentMarker(first.attachment)}\n${attachmentMarker(second.attachment)}`, undefined, access);
    const request = (await a.stub.demoRequests()).at(-1)!;
    expect(request.last).not.toContain(c.domain);
    expect(selected(request.sections.poppy_task_access)).toEqual(access);
    expect(request.sections.poppy_task_access).not.toContain(second.attachment.id);
    expect(request.images).toHaveLength(2);
    connection.socket.close();
  });

  it("clears old selections for a later message instead of inferring new grants from its prose", async () => {
    const c = await company();
    const a = await agent();
    const connection = await connect(a.identity);
    await chat(connection.socket, connection.client, "Check my order.", undefined, { companies: [c.domain], uploads: [] });
    const empty = { companies: [], uploads: [] };
    await chat(connection.socket, connection.client, `Do not contact ${c.domain}.`, undefined, empty);
    const [first, second] = await a.stub.demoRequests();
    expect(selected(first!.sections.poppy_task_access).companies).toEqual([c.domain]);
    expect(selected(second!.sections.poppy_task_access)).toEqual(empty);
    expect(second!.sections.poppy_task_access).not.toContain(c.domain);
    expect(await requests(c)).toEqual([]);
    connection.socket.close();
  });

  it("keeps a reconnected submission's original selections and does not start another model call", async () => {
    const c = await company();
    const a = await agent();
    const first = await connect(a.identity);
    const frame = { type: "submit", id: crypto.randomUUID(), input: "Check my order.", taskAccess: { companies: [c.domain], uploads: [] } };
    first.socket.send(JSON.stringify(frame));
    await first.client.until(() => first.client.texts().some(text => text.startsWith("assistant: echo: Check my order.")) && !first.client.view().running);
    first.socket.close();
    const second = await connect(a.identity);
    second.socket.send(JSON.stringify(frame));
    await second.client.until(() => second.client.frames.some(result => result.type === "result" && "id" in result && result.id === frame.id));
    const modelRequests = await a.stub.demoRequests();
    expect(modelRequests).toHaveLength(1);
    expect(selected(modelRequests[0]!.sections.poppy_task_access)).toEqual(frame.taskAccess);
    second.socket.close();
  });
});

it("does not send a Company message after Stop while token preparation is suspended", async () => {
  const c = await company();
  const a = await agent();
  const connection = await connect(a.identity);
  await signInDirect(a, c);
  await a.stub.poppyForgetMemory();
  await a.stub.poppyFault({ method: "POST", url: c.hosts.tokenEndpoint, grant: "refresh_token", mode: "pause" });
  const words = "LATE_MESSAGE_SHOULD_NOT_SEND";
  connection.socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), taskAccess: { companies: [c.domain], uploads: [] }, input: `Tell the selected Company hello. ${obey("poppy_message", { domain: c.domain, text: words })}` }));
  await until(async () => await a.stub.poppyHeldCount() === 1);
  const stop = crypto.randomUUID();
  connection.socket.send(JSON.stringify({ type: "abort", id: stop }));
  await until(async () => JSON.parse(await a.stub.poppySql("SELECT task_policy FROM turn_sources WHERE source = 'user'")).every((row: { task_policy: number }) => row.task_policy === 0));
  await a.stub.poppyReleaseHeld();
  await connection.client.until(() => connection.client.frames.some(frame => frame.type === "result" && "id" in frame && frame.id === stop));
  expect((await requests(c)).filter(request => request.method === "POST" && request.url.startsWith(c.hosts.conversationsEndpoint))).toEqual([]);
  connection.socket.close();
});

describe("scheduled task selections", () => {
  const noon = Date.UTC(2026, 9, 12, 12);

  it("keeps the creating message's recipients after an unrelated message selects another Company", async () => {
    const original = await company();
    const unrelated = await company();
    const a = await agent();
    const connection = await connect(a.identity);
    await a.stub.setClock(noon);
    const instruction = `Check the original selected Company.\n${obey("poppy_discover", { domain: original.domain })}\n${obey("poppy_discover", { domain: unrelated.domain })}\n${obey("schedule_task", { instruction: "Escalated task", in: "PT1H" })}`;
    const access = { companies: [original.domain], uploads: [] };
    await chat(connection.socket, connection.client, `Check my order in an hour. ${obey("schedule_task", { instruction: "Check the original selected Company", in: "PT1H" })}`, undefined, access);
    const [saved] = JSON.parse(await a.stub.poppySql("SELECT id, task_access FROM schedules")) as { id: string; task_access: string }[];
    expect(JSON.parse(saved!.task_access)).toEqual(access);
    // Encoded faux-model directives look like secrets to the store; inject
    // them only after the real User-origin scheduling tool captured its scope.
    await a.stub.poppySql("UPDATE schedules SET text = ? WHERE id = ?", instruction, saved!.id);
    await chat(connection.socket, connection.client, "A different task for later.", undefined, { companies: [unrelated.domain], uploads: [] });
    await a.stub.scheduleAdvance(noon + 60 * 60 * 1000);
    await runDurableObjectAlarm(a.stub);
    await until(async () => JSON.parse(await a.stub.poppySql("SELECT last_outcome FROM schedules WHERE id = ?", saved!.id))[0]?.last_outcome === "done");
    const scheduled = (await a.stub.demoRequests()).filter(request => request.last.startsWith("[scheduled task"));
    expect(scheduled.length).toBeGreaterThan(0);
    for (const request of scheduled) expect(selected(request.sections.poppy_task_access)).toEqual(access);
    expect((await requests(original)).length).toBeGreaterThan(0);
    expect(await requests(unrelated)).toEqual([]);
    // The saved recipient grant authorizes Company work, not new User-origin powers.
    expect(JSON.parse(await a.stub.poppySql("SELECT COUNT(*) AS n FROM schedules"))[0].n).toBe(1);
    expect(await a.stub.poppyTranscript()).toContain("wasn't started by the User's own message");
    expect(JSON.parse(await a.stub.poppySql("SELECT source FROM turn_sources WHERE request_id GLOB 'schedule:*'"))).toEqual([{ source: "background" }]);
    connection.socket.close();
  });

  it("does not lend a later User's Company selection to a legacy schedule with no saved access", async () => {
    const c = await company();
    const a = await agent();
    const connection = await connect(a.identity);
    await a.stub.setClock(noon);
    const task = await a.stub.scheduleCreate({ kind: "task", text: "Check my order", when: { in: "PT1H" }, timeZone: "UTC" });
    await a.stub.poppySql("UPDATE schedules SET text = ? WHERE id = ?", `Check my order. ${obey("poppy_discover", { domain: c.domain })}`, task.id);
    await chat(connection.socket, connection.client, "Something unrelated.", undefined, { companies: [c.domain], uploads: [] });
    await a.stub.scheduleAdvance(noon + 60 * 60 * 1000);
    await runDurableObjectAlarm(a.stub);
    await until(async () => JSON.parse(await a.stub.poppySql("SELECT last_outcome FROM schedules WHERE id = ?", task.id))[0]?.last_outcome === "done");
    const request = (await a.stub.demoRequests()).at(-1)!;
    expect(selected(request.sections.poppy_task_access)).toEqual({ companies: [], uploads: [] });
    expect(await requests(c)).toEqual([]);
    connection.socket.close();
  });

  it("migrates older schedule rows with an empty selection instead of parsing their instructions", async () => {
    const a = await agent();
    await runInDurableObject(a.stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("ALTER TABLE schedules DROP COLUMN task_access");
      sql.exec("INSERT INTO schedules (id, kind, text, next_run, recurrence, time_zone, created_at, created_from, status) VALUES ('sch_legacy', 'task', 'Contact shop.example', 1, 'none', 'UTC', 1, 'legacy', 'active')");
      migrateSchedules(sql);
      expect(JSON.parse(String(sql.exec("SELECT task_access FROM schedules WHERE id = 'sch_legacy'").one().task_access))).toEqual({ companies: [], uploads: [] });
    });
  });

  it("does not create future work after Stop while the originating task lookup is suspended", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let active = true;
    let created = 0;
    const extension = scheduleExtension({
      scheduler: () => ({ create: async () => { created++; throw new Error("Scheduled work was created"); } }) as unknown as Scheduler,
      userTimeZone: () => "UTC",
      fromUser: async () => true,
      userTask: async () => {
        entered();
        await waiting;
        return { key: "original", text: "Check my order later", history: [], userStarted: true, foreign: false, access: { companies: [], uploads: [] }, active: () => active };
      }
    });
    const controller = new AbortController();
    const tool = extension.tools!.find(tool => tool.name === "schedule_task")!;
    const result = tool.execute({ instruction: "Check my order later", in: "PT1H" }, { callId: "stopped" } as ToolExecutionApi, { abortSignal: controller.signal } as Context);
    await started;
    active = false;
    controller.abort();
    release();
    expect(await result).toMatchObject({ isError: true, details: { refused: "task_stopped" } });
    expect(created).toBe(0);
  });
});
