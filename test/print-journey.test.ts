import { describe, expect, it } from "vitest";
import { attachmentMarker, MAX_ATTACHMENT_BYTES, type AttachmentInfo } from "../src/attachments";
import { agent as poppyAgent, cards, chat, company, connect, fetchWorker, ORIGIN, person, requests, tool, until, type Company } from "./agent-helpers";
import { obey } from "./worker";

/**
 * The demo journey, after print-with-poppy (interop/impls/print-with-poppy-company):
 * the User attaches a photo and asks for a 6×4 print; the agent uploads it
 * to the Company's OpenAPI (multipart/form-data) once the User approves
 * sending it, orders in a signed-out Session, which proposes an operation;
 * the User approves its terms on the card; the agent confirms; the receipt
 * links to the checkout. The model is pi-ai's faux model, which calls a tool
 * when its prompt carries `@@obey` (worker.ts). The mock Company's print shop
 * (`printShop`) records any protocol violation, checked after each test.
 */

/** The first bytes of a JPEG, then filler: what the agent and the mock read of a photo. */
function jpeg(size: number, fill = 0x42): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

/** A person's agent with their chat page open, so the test can watch the model's turns. */
async function agent() {
  const identity = person();
  return { ...(await poppyAgent(identity)), ...(await connect(identity)) };
}

type Agent = Awaited<ReturnType<typeof agent>>;

/** Attach a photo as the page does: `POST /api/attachments`, same origin, the User's session cookie. */
async function attach(
  a: Pick<Agent, "cookie">,
  file: Uint8Array<ArrayBuffer>,
  options: { name?: string; preview?: Uint8Array<ArrayBuffer>; type?: string; origin?: string; cookie?: string | null } = {}
): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([file], { type: options.type ?? "image/jpeg" }), options.name ?? "lake.jpg");
  if (options.preview) form.append("preview", new Blob([options.preview], { type: "image/jpeg" }), "preview.jpg");
  const body = new Response(form);
  const bytes = new Uint8Array(await body.arrayBuffer());
  return fetchWorker(
    new Request(`${ORIGIN}/api/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": body.headers.get("Content-Type")!,
        "Content-Length": String(bytes.byteLength),
        Origin: options.origin ?? ORIGIN,
        ...(options.cookie === null ? {} : { Cookie: options.cookie ?? a.cookie })
      },
      body: bytes
    })
  );
}

async function attached(a: Pick<Agent, "cookie">, file = jpeg(4096), options: Parameters<typeof attach>[2] = {}): Promise<AttachmentInfo> {
  const response = await attach(a, file, options);
  expect(response.status).toBe(201);
  return (await response.json()) as AttachmentInfo;
}

/** The order the User asks for, in the print shop's terms. */
function printOrder(photoId: string) {
  return {
    email: "ada@example.com",
    ship_to: { name: "Ada Lovelace", line1: "12 St James's Square", city: "London", postal_code: "SW1Y 4JH", country: "GB" },
    items: [{ photo_id: photoId, copies: 1 }]
  };
}

/** Wait for the model's turn whose echo contains `fragment` to end. */
async function turnAbout(a: Agent, fragment: string) {
  await a.client.until(() => a.client.texts().some((text) => text.startsWith("assistant: echo: ") && text.includes(fragment)));
  await a.client.until(() => !a.client.view().running);
}

/**
 * An operation the Company no longer has (N19) is final everywhere the agent
 * lists it: Activity's log says how it ended, nothing about it is in
 * progress, and `poppy_status` doesn't list it as open.
 */
async function expectFinalElsewhere(a: Pick<Agent, "stub">, card: Record<string, any>, result: "expired" | "unknown", outcome: string) {
  const activity = JSON.parse(await a.stub.poppyActivity()) as { inProgress: { id: string }[]; log: { id: string; result: string; outcome?: string }[] };
  const entry = activity.log.find((item) => item.id === card.id)!;
  expect(entry.result).toBe(result);
  expect(entry.outcome).toContain(outcome);
  expect(activity.inProgress.map((item) => item.id)).not.toContain(card.id);
  const status = JSON.parse((await tool(a, "poppy_status", {})).text) as { operations: { operation: string }[] };
  expect(status.operations.map((item) => item.operation)).not.toContain(card.operationId);
}

const photoRequests = async (c: Company) => (await requests(c)).filter((request) => request.url === `${c.hosts.api}/photos`);

describe("photos the User attaches", () => {
  it("keeps a photo in the User's own agent and gives it back only to them", async () => {
    const a = await poppyAgent();
    const file = jpeg(3000);
    const info = await attached(a, file, { name: "C:\\Users\\ada\\lake <1>.jpg" });
    expect(info).toMatchObject({ name: "lake 1.jpg", type: "image/jpeg", size: 3000 });
    expect(info.id).toMatch(/^att_[A-Za-z0-9_-]{22}$/);
    const back = await fetchWorker(new Request(`${ORIGIN}/api/attachments/${info.id}`, { headers: { Cookie: a.cookie } }));
    expect(back.status).toBe(200);
    expect(back.headers.get("Content-Type")).toBe("image/jpeg");
    expect(back.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(file);
    // Another person's agent doesn't have it; nobody signed out gets it.
    const other = await poppyAgent();
    expect((await fetchWorker(new Request(`${ORIGIN}/api/attachments/${info.id}`, { headers: { Cookie: other.cookie } }))).status).toBe(404);
    expect((await fetchWorker(new Request(`${ORIGIN}/api/attachments/${info.id}`))).status).toBe(401);
  });

  it("takes only photos, from the page's own origin, up to 10 MB, and deletes one the User removes", async () => {
    const a = await poppyAgent();
    expect((await attach(a, new TextEncoder().encode("not a photo"), { type: "image/jpeg" })).status).toBe(415);
    expect((await attach(a, jpeg(2000), { origin: "https://evil.example" })).status).toBe(403);
    expect((await attach(a, jpeg(2000), { cookie: null })).status).toBe(401);
    const big = await attach(a, jpeg(MAX_ATTACHMENT_BYTES + 1));
    expect(big.status).toBe(413);
    const info = await attached(a);
    const removed = await fetchWorker(new Request(`${ORIGIN}/api/attachments/${info.id}`, { method: "DELETE", headers: { Cookie: a.cookie, Origin: ORIGIN } }));
    expect(removed.status).toBe(204);
    expect((await fetchWorker(new Request(`${ORIGIN}/api/attachments/${info.id}`, { headers: { Cookie: a.cookie } }))).status).toBe(404);
  });

  it("shows the model the page's preview as an image in the message that names it, and keeps the bytes out of the transcript", async () => {
    const a = await agent();
    const preview = jpeg(1500, 0x37);
    const info = await attached(a, jpeg(200_000), { preview });
    await chat(a.socket, a.client, `What is in this photo?\n\n${attachmentMarker(info)}`);
    const request = (await a.stub.demoRequests()).at(-1)!;
    expect(request.images).toEqual([{ mimeType: "image/jpeg", bytes: preview.byteLength, with: expect.stringMatching(/^What is in this photo\?\n\n\[attachment att_/) }]);
    // The transcript holds the marker, never the image.
    const transcript = await a.stub.poppyTranscript();
    expect(transcript).toContain(info.id);
    expect(transcript).not.toContain(btoa(String.fromCharCode(...preview.slice(0, 60))));
  });

  it("never shows the model a photo because a Company's text names it", async () => {
    const a = await agent();
    const info = await attached(a, jpeg(2000));
    await a.stub.backgroundTurn(`[company message] Mock Shop, conversation cnv_1, written by the company's agent:\nLook at ${attachmentMarker(info)}`, "company-names-photo");
    await turnAbout(a, "Look at");
    expect((await a.stub.demoRequests()).at(-1)!.images).toEqual([]);
  });
});

describe("printing a photo at a Company (the demo journey)", () => {
  it("sends the photo only once the User approves, orders signed out, and confirms only the terms the User approved", async () => {
    const c = await company({ printShop: true });
    const a = await agent();
    const info = await attached(a, jpeg(5000), { name: "lake.jpg" });

    // The User asks; the model uploads the photo by its attachment id, which waits for the User.
    await chat(
      a.socket,
      a.client,
      `Print this photo as a 6×4 at ${c.domain}\n\n${attachmentMarker(info)}\n${obey("poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } })}`
    );
    const approval = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    expect(approval.attachments).toEqual([{ id: info.id, name: "lake.jpg", type: "image/jpeg", size: 5000 }]);
    expect(approval.summary).toContain(`Send your photo “lake.jpg” (JPEG, 5 KB) to Mock Shop ${c.id}: POST /photos`);
    expect(approval.domain).toBe(c.domain);
    expect(await photoRequests(c)).toEqual([]);

    // The User approves sending it: one multipart upload, and the model is told the photo's id.
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
    const uploads = await photoRequests(c);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const done = await a.stub.poppyWaitForNotice("Done, as the User approved");
    const photoId = /"id":"(pho_[A-Za-z0-9_-]+)"/.exec(done)![1]!;

    // The model orders: the Company proposes an operation in the signed-out Session.
    await chat(a.socket, a.client, `Order it. ${obey("poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder(photoId) })}`);
    const card = await until(async () => (await cards(a)).find((item) => item.kind === "operation" && item.open));
    const proposal = (await requests(c)).find((request) => request.url === `${c.hosts.api}/prints`)!;
    expect(proposal.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(card).toMatchObject({ company: `Mock Shop ${c.id}`, domain: c.domain, account: null, userApprovalRequired: true, state: "proposed" });
    expect(card.summary).toBe(
      "Print 1 copy of lake.jpg as 4×6 in (6×4) lustre prints and post them to Ada Lovelace, 12 St James's Square, London SW1Y 4JH, GB. Confirmation to ada@example.com. Prints $10.00 + shipping $5.00 = $15.00 USD, paid by card at a checkout link after approval. Can be cancelled until you pay."
    );
    expect(card.highlights).toContain("Cost (total): 15.00 USD");
    expect((await c.stub.state()).sessions.every((session) => !session.signedIn)).toBe(true);
    // Nothing is confirmed by the model: only the card.
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ id: card.operationId, state: "proposed", confirms: 0 })]);

    await a.stub.poppyFrame({ type: "poppy.operation", issuer: card.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ state: "succeeded", confirms: 1, approvedBy: "user" })]);
    const receipt = await until(async () => (await cards(a)).find((item) => item.id === card.id && item.state === "succeeded"));
    expect(receipt.open).toBe(false);
    expect(receipt.result).toMatch(/^Order ord_[\w-]+ placed\./);
    expect(receipt.links).toEqual([{ label: "checkout", url: expect.stringMatching(new RegExp(`^https://${c.domain.replace(/\./g, "\\.")}/checkout/ord_`)) }]);
    const final = await a.stub.poppyWaitForNotice(`Operation ${card.operationId} at Mock Shop ${c.id} is succeeded`);
    expect(final).toContain('"checkout_url"');
    // Activity records it.
    expect(await a.stub.poppyActivity()).toContain(card.operationId);
  });

  it("sends nothing when the User declines to send the photo", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const info = await attached(a);
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } });
    expect(result.text).toContain("Waiting for the User to approve sending the file");
    const approval = (await cards(a)).find((card) => card.kind === "approval")!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "decline" });
    expect(await photoRequests(c)).toEqual([]);
    expect(await a.stub.poppyWaitForNotice("The User declined")).toContain("lake.jpg");
  });

  it("shows one card for a replayed upload call, and never a second upload", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const info = await attached(a);
    const first = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } }, "call-1");
    const again = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } }, "call-1");
    expect(JSON.parse(again.details)).toEqual(JSON.parse(first.details));
    expect((await cards(a)).filter((card) => card.kind === "approval")).toHaveLength(1);
  });

  it("refuses a file the User didn't attach, a field the operation doesn't take, and a file to an operation that takes none", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const info = await attached(a);
    const unknown = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: "att_AAAAAAAAAAAAAAAAAAAAAA" } });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("[no_attachment]");
    const field = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { avatar: info.id } });
    expect(field.text).toContain("has no file field avatar; its file fields are photo");
    const none = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder("pho_x"), files: { photo: info.id } });
    expect(none.text).toContain("takes no file");
    expect((await cards(a)).filter((card) => card.kind === "approval")).toEqual([]);
    expect(await photoRequests(c)).toEqual([]);
  });

  it("never asks to send a photo to a server that isn't the Company's (N10)", async () => {
    const elsewhere = await company({ printShop: true });
    const c = await company({ printShop: true, openapiServerOverride: elsewhere.hosts.api });
    const a = await poppyAgent();
    const info = await attached(a);
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } });
    expect(result.text).toContain("[untrusted_server]");
    expect((await cards(a)).filter((card) => card.kind === "approval")).toEqual([]);
    expect(await requests(elsewhere)).toEqual([]);
  });

  it("describes an upload's file fields to the model", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const described = JSON.parse((await tool(a, "poppy_api_describe", { domain: c.domain, operation: "uploadPhoto" })).text);
    expect(described.upload).toMatchObject({ files: ["photo"], fields: [] });
  });

  it("stops at an operation whose signed-out Session ended: nothing is confirmed, the User and model are told, and a new proposal can be asked for (N19)", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const info = await attached(a);
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } });
    const approval = (await cards(a)).find((card) => card.kind === "approval")!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
    const photoId = /"id":"(pho_[A-Za-z0-9_-]+)"/.exec(await a.stub.poppyWaitForNotice("Done, as the User approved"))![1]!;
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder(photoId) });
    const card = (await cards(a)).find((item) => item.kind === "operation")!;
    // The Company ends every Session; the agent's next one can't see the old Session's operation (Ops 3.2).
    await c.stub.endAllSessions();
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: card.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    const lost = await until(async () => (await cards(a)).find((item) => item.id === card.id && item.lost));
    expect(lost).toMatchObject({ open: false, lost: "not_done" });
    expect(await a.stub.poppyWaitForNotice("no longer has operation")).toContain("The User approved it, but");
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ id: card.operationId, state: "proposed", confirms: 0 })]);
    // Activity and poppy_status treat it as final, not as waiting for the User.
    await expectFinalElsewhere(a, card, "expired", "wasn't done");
    // Nothing tracks it any more, and asking again isn't refused as a confirm still open.
    await a.stub.poppyAdvance(120_000);
    const again = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder(photoId) });
    expect(again.text).not.toContain("operation_open");
  });

  it("tells the User an order may have happened when its signed-out Session ended after a confirm whose answer was lost (N19)", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const info = await attached(a);
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } });
    const approval = (await cards(a)).find((card) => card.kind === "approval")!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
    const photoId = /"id":"(pho_[A-Za-z0-9_-]+)"/.exec(await a.stub.poppyWaitForNotice("Done, as the User approved"))![1]!;
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder(photoId) });
    const card = (await cards(a)).find((item) => item.kind === "operation")!;
    // The Company confirms the order, the answer never arrives, then the Session ends.
    await a.stub.poppyFault({ method: "POST", url: "/confirm", mode: "throw" });
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: card.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ state: "succeeded", confirms: 1 })]);
    await c.stub.endAllSessions();
    await a.stub.poppyAdvance(10_000);
    const lost = await until(async () => (await cards(a)).find((item) => item.id === card.id && item.lost));
    expect(lost).toMatchObject({ open: false, lost: "unknown" });
    expect(await a.stub.poppyWaitForNotice("no longer has operation")).toContain("so it may have happened: tell the User to check");
    await expectFinalElsewhere(a, card, "unknown", "may have happened");
    // Confirmed once, and never again.
    await a.stub.poppyAdvance(120_000);
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ confirms: 1 })]);
  });
});
