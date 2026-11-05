import { describe, expect, it } from "vitest";
import { attachmentMarker } from "../src/attachments";
import type { TaskAccess } from "../src/task-access";
import { agent, chat, company, connect, requests, signInDirect, until } from "./agent-helpers";
import { obey } from "./worker";

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
