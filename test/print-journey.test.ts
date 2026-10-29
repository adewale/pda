import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { attachmentMarker, KEEP_MS, MAX_ATTACHMENT_BYTES, MAX_PREVIEW_BYTES, type AttachmentInfo } from "../src/attachments";
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
 * An approval that ended without the Company doing it, or not knowing
 * whether it did (N19), is final everywhere the agent lists it: Activity's
 * log says how it ended, and nothing about it is in progress.
 */
async function expectFinalElsewhere(a: Pick<Agent, "stub">, card: Record<string, any>, result: "failed" | "unknown") {
  const activity = JSON.parse(await a.stub.poppyActivity()) as { inProgress: { id: string }[]; log: { id: string; result: string; outcome?: string }[] };
  const entry = activity.log.find((item) => item.id === card.id)!;
  expect(entry.result).toBe(result);
  expect(activity.inProgress.map((item) => item.id)).not.toContain(card.id);
}

/** Upload a photo and ask for its print, approving our own cards: the Company's terms card, waiting. */
async function termsForPrint(a: Awaited<ReturnType<typeof poppyAgent>>, c: Company) {
  const info = await attached(a);
  await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } });
  const approval = (await cards(a)).find((card) => card.kind === "approval" && card.open)!;
  await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
  const receipt = (await cards(a)).find(card => card.approvalId === approval.approvalId)!;
  const photoId: string = JSON.parse(receipt.result).body.id;
  expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder(photoId) })).isError).toBe(false);
  const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open && card.approvalId.startsWith("apr2_")));
  return { photoId, terms };
}

const printRequests = async (c: Company) => (await requests(c)).filter((request) => request.url === `${c.hosts.api}/prints`);
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

  it("shows the model a photo the User sent without any words", async () => {
    const a = await agent();
    const info = await attached(a, jpeg(2000));
    await chat(a.socket, a.client, attachmentMarker(info));
    const request = (await a.stub.demoRequests()).at(-1)!;
    expect(request.images).toEqual([{ mimeType: "image/jpeg", bytes: 2000, with: expect.stringMatching(/^\[attachment att_/) }]);
  });

  it("deletes a photo 30 days after it was attached: never served or shown to the model after", async () => {
    const a = await agent();
    const start = Date.UTC(2026, 9, 1, 12);
    await a.stub.setClock(start);
    const preview = jpeg(1500, 0x37);
    const info = await attached(a, jpeg(200_000), { preview });
    expect(await a.stub.attachmentStorage()).toMatchObject({ attachments: 1, file: 1, preview: 1 });
    const get = () => fetchWorker(new Request(`${ORIGIN}/api/attachments/${info.id}`, { headers: { Cookie: a.cookie } }));

    // A minute short of its 30 days: kept.
    await a.stub.setClock(start + KEEP_MS - 60_000);
    expect((await get()).status).toBe(200);

    // Past them: the model's next request doesn't show it, and the file and its preview are gone.
    await a.stub.setClock(start + KEEP_MS + 60_000);
    await chat(a.socket, a.client, `Still there?\n\n${attachmentMarker(info)}`);
    expect((await a.stub.demoRequests()).at(-1)!.images).toEqual([]);
    expect(await a.stub.attachmentStorage()).toMatchObject({ attachments: 0, file: 0, preview: 0 });
    expect((await get()).status).toBe(404);
  });

  it("deletes each photo when its 30 days are up, on the agent's alarm, without anything reading it", async () => {
    const a = await poppyAgent();
    const start = Date.UTC(2026, 9, 1, 12);
    await a.stub.setClock(start);
    await attached(a, jpeg(3000), { preview: jpeg(500, 0x37) });
    await a.stub.setClock(start + 10 * 86_400_000);
    const second = await attached(a, jpeg(3000));
    expect(await a.stub.attachmentStorage()).toMatchObject({ attachments: 2, file: 2, preview: 1, job: expect.any(Number) });

    // The first one's 30 days: it goes, its preview with it; the job waits for the second.
    await a.stub.attachmentsAdvance(start + KEEP_MS + 60_000);
    await runDurableObjectAlarm(a.stub);
    expect(await a.stub.attachmentStorage()).toMatchObject({ attachments: 1, file: 1, preview: 0, job: expect.any(Number) });

    // The second one's: nothing is left, and no job.
    await a.stub.attachmentsAdvance(start + 10 * 86_400_000 + KEEP_MS + 60_000);
    await runDurableObjectAlarm(a.stub);
    expect(await a.stub.attachmentStorage()).toEqual({ attachments: 0, file: 0, preview: 0, job: null });
    expect((await fetchWorker(new Request(`${ORIGIN}/api/attachments/${second.id}`, { headers: { Cookie: a.cookie } }))).status).toBe(404);
  });

  it("counts the model's previews in the 100 MB an agent keeps", async () => {
    const a = await poppyAgent();
    const preview = jpeg(MAX_PREVIEW_BYTES, 0x37);
    // Nine 10 MB photos, each with a 1 MB preview: 99 MB kept.
    for (let i = 0; i < 9; i++) await attached(a, jpeg(MAX_ATTACHMENT_BYTES), { preview });
    const full = await attach(a, jpeg(MAX_ATTACHMENT_BYTES));
    expect(full.status).toBe(507);
    expect(((await full.json()) as { error: string }).error).toContain("99.0 MB");
    // A last 1 MB fills it exactly; then nothing more fits, not even a preview's worth.
    await attached(a, jpeg(MAX_PREVIEW_BYTES));
    expect((await attach(a, jpeg(2000))).status).toBe(507);
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

    // The task request runs; the Company refuses it with its exact terms (Ops 4).
    await chat(a.socket, a.client, `Order it. ${obey("poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder(photoId) })}`);
    const terms = await until(async () => (await cards(a)).find((item) => item.kind === "approval" && item.open && item.terms));
    expect((await cards(a)).filter(item => item.kind === "approval")).toHaveLength(2); // upload consent, then Company terms
    const asked = await printRequests(c);
    expect(asked.map((request) => [request.status, request.error, "poppy-approval" in request.headers])).toEqual([[403, "approval_required", false]]);
    expect(asked[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(terms).toMatchObject({ company: `Mock Shop ${c.id}`, domain: c.domain, status: "pending" });
    expect(terms.approvalId).toMatch(/^apr2_/);
    expect(terms.terms.summary).toBe(
      "Print 1 copy of lake.jpg as 4×6 in (6×4) lustre prints and post them to Ada Lovelace, 12 St James's Square, London SW1Y 4JH, GB. Confirmation to ada@example.com. Prints $10.00 + shipping $5.00 = $15.00 USD, paid by card at a checkout link after approval. Can be cancelled until you pay."
    );
    expect(terms.terms.highlights).toContain("Cost (total): 15.00 USD");
    expect(terms.terms.total).toEqual({ amount: "15.00", currency: "USD" });
    expect((await c.stub.state()).sessions.every((session) => !session.signedIn)).toBe(true);
    // Nothing is done by the model: only the card.
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ state: "proposed", confirms: 0 })]);

    // The User approves the terms: the same request again with Poppy-Approval, performed once (Ops 6, 7).
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ state: "succeeded", confirms: 1, approvedBy: "user" })]);
    const sent = await printRequests(c);
    expect(sent.map((request) => [request.status, "poppy-approval" in request.headers])).toEqual([[403, false], [201, true]]);
    const receipt = await until(async () => (await cards(a)).find((item) => item.kind === "approval" && item.approvalId === terms.approvalId && item.status === "done"));
    expect(receipt.open).toBe(false);
    // The receipt keeps the Company's answer, the checkout on its own website; the model is told it too.
    const order = (JSON.parse(receipt.result!) as { status: number; body: { order: { order_id: string; checkout_url: string } } });
    expect(order.status).toBe(201);
    expect(order.body.order.checkout_url).toMatch(new RegExp(`^https://${c.domain.replace(/\./g, "\\.")}/checkout/ord_`));
    expect(await a.stub.poppyWaitForNotice(order.body.order.checkout_url)).toContain("Done, as the User approved");
    // Activity records it.
    expect(await a.stub.poppyActivity()).toContain(terms.approvalId);
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

  it("sends no photo past its 30 days: not asked for, and not sent once approved", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const old = await attached(a);
    await a.stub.poppyAdvance(KEEP_MS + 60_000);
    const refused = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: old.id } });
    expect(JSON.parse(refused.details)).toMatchObject({ error: "no_attachment" });
    expect((await cards(a)).filter((card) => card.kind === "approval")).toEqual([]);

    // Asked for in time, approved after its 30 days: nothing is sent. (Attached on the Poppy client's clock, which the test moved on.)
    await a.stub.setClock((await a.stub.poppyClock()).now);
    const late = await attached(a);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: late.id } })).text).toContain(
      "Waiting for the User to approve sending the file"
    );
    const approval = (await cards(a)).find((card) => card.kind === "approval" && card.open)!;
    await a.stub.poppyAdvance(KEEP_MS + 60_000);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
    expect(await a.stub.poppyWaitForNotice("The approved action failed")).toContain(`No attachment ${late.id}`);
    expect(await photoRequests(c)).toEqual([]);
  });

  it("shows one card for a replayed upload call, and never a second upload", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const info = await attached(a);
    const first = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } }, "call-1");
    const again = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } }, "call-1");
    expect(JSON.parse(again.details)).toEqual(JSON.parse(first.details));
    expect((await cards(a)).filter((card) => card.kind === "approval")).toHaveLength(1);
    expect(await photoRequests(c)).toEqual([]);
    const approval = (await cards(a)).find((card) => card.kind === "approval" && card.open)!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
    await a.stub.poppyWaitForNotice("Done, as the User approved");
    expect(await photoRequests(c)).toHaveLength(1);
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } }, "call-1");
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
    expect(await photoRequests(c)).toHaveLength(1);
    expect((await cards(a)).filter((card) => card.kind === "approval")).toHaveLength(1);
  });

  it("refuses a file the User didn't attach, a field the operation doesn't take, and a file to an operation that takes none", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const info = await attached(a);
    const unknown = await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: "att_AAAAAAAAAAAAAAAAAAAAAA" } });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse(unknown.details)).toMatchObject({ error: "no_attachment" });
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
    expect(JSON.parse(result.details)).toMatchObject({ error: "untrusted_server" });
    expect((await cards(a)).filter((card) => card.kind === "approval")).toEqual([]);
    expect(await requests(elsewhere)).toEqual([]);
  });

  it("describes an upload's file fields to the model", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const described = JSON.parse((await tool(a, "poppy_api_describe", { domain: c.domain, operation: "uploadPhoto" })).text);
    expect(described.upload).toMatchObject({ files: ["photo"], fields: [] });
  });

  it("describes an order's body with its $refs written out, so the model sees the fields to send", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const described = JSON.parse((await tool(a, "poppy_api_describe", { domain: c.domain, operation: "orderPrints" })).text);
    const schema = described.requestBody.content["application/json"].schema;
    expect(schema.required).toEqual(["email", "ship_to", "items"]);
    expect(schema.properties.ship_to.required).toContain("postal_code");
    expect(JSON.stringify(described)).not.toContain("$ref");
  });

  it("refuses a body sent as a string of JSON with a correction, before a card or a request (live, 12 October)", async () => {
    // print-with-poppy's maintainer found our agent's order body serialised twice: the model passed
    // body as a string of JSON, and the client stringified it again, so the store's parser refused it.
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const order = printOrder("pho_1");
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: JSON.stringify(order) });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.details)).toMatchObject({ error: "invalid_body" });
    expect(result.text).toContain("not a string containing serialised JSON: pass body as a structured object");
    expect(result.text).toContain("Nothing was sent.");
    expect(await cards(a)).toEqual([]);
    expect((await requests(c)).filter((request) => request.url === `${c.hosts.api}/prints`)).toEqual([]);
  });

  it("refuses a string body the model sends in the tool's own schema, before the agent's check is reached", async () => {
    // body is an object in poppy_api_call's parameters, so pi refuses a string before the tool runs.
    const c = await company({ printShop: true });
    const a = await agent();
    await chat(a.socket, a.client, `Order it. ${obey("poppy_api_call", { domain: c.domain, operation: "orderPrints", body: JSON.stringify(printOrder("pho_1")) })}`);
    const transcript = await a.stub.poppyTranscript();
    expect(transcript).toContain("Validation failed for tool");
    expect(transcript).not.toContain("invalid_body");
    expect(await cards(a)).toEqual([]);
    expect((await requests(c)).filter((request) => request.url === `${c.hosts.api}/prints`)).toEqual([]);
  });

  it("checks a bodyValue against the operation's schema as it does a body, and refuses the two together", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const both = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder("pho_1"), bodyValue: null });
    expect(JSON.parse(both.details)).toMatchObject({ error: "invalid_body" });
    expect(both.text).toContain("Pass either body or bodyValue, not both. Nothing was sent.");
    // bodyValue is for a body that isn't an object; an order is one, so a string of it is refused as body's would be.
    const value = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", bodyValue: JSON.stringify(printOrder("pho_1")) });
    expect(JSON.parse(value.details)).toMatchObject({ error: "invalid_body" });
    expect(value.text).toContain("not a string containing serialised JSON");
    expect(await cards(a)).toEqual([]);
    expect((await requests(c)).filter((request) => request.url === `${c.hosts.api}/prints`)).toEqual([]);
  });

  it("names a string of serialised JSON deeper in a body, as it does a whole body", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const order = printOrder("pho_1");
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: { ...order, ship_to: JSON.stringify(order.ship_to) } });
    expect(JSON.parse(result.details)).toMatchObject({ error: "invalid_body" });
    expect(result.text).toContain("body/ship_to for orderPrints");
    expect(result.text).toContain("pass body/ship_to as a structured object. Nothing was sent.");
    expect((await requests(c)).filter((request) => request.url === `${c.hosts.api}/prints`)).toEqual([]);
  });

  it("refuses a body that doesn't match the operation's schema, naming what's wrong, and lets a right one through", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const { ship_to: _, ...noAddress } = printOrder("pho_1");
    const missing = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: { ...noAddress, gift: true } });
    expect(JSON.parse(missing.details)).toMatchObject({ error: "invalid_body" });
    expect(missing.text).toContain("ship_to");
    expect(missing.text).toContain("gift");
    const none = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints" });
    expect(none.text).toContain("needs a JSON body");
    expect((await requests(c)).filter((request) => request.url === `${c.hosts.api}/prints`)).toEqual([]);
    // A string isn't parsed for the model, and a body that matches goes as before.
    const right = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder("pho_1") });
    expect(right.text).not.toContain("invalid_body");
  });

  it("uploads and orders where the description lists DPoP and Authorization as required headers, which the client sets itself", async () => {
    // As print-with-poppy's description did from c147418 to cecb32f: kept as
    // parameters, the model would be asked for a DPoP proof, and a call without
    // one refused before its card ("Missing parameter DPoP").
    const c = await company({ printShop: true, printShopListsTransportHeaders: true });
    const a = await poppyAgent();
    for (const operation of ["uploadPhoto", "orderPrints"]) {
      const described = JSON.parse((await tool(a, "poppy_api_describe", { domain: c.domain, operation })).text) as { parameters: { name: string }[] };
      expect(described.parameters.map((parameter) => parameter.name)).toEqual([]);
    }
    const info = await attached(a);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } })).text).toContain(
      "Waiting for the User to approve sending the file"
    );
    const approval = (await cards(a)).find((card) => card.kind === "approval")!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approval.approvalId, decision: "approve" });
    const uploads = await photoRequests(c);
    expect(uploads).toHaveLength(1);
    // Signed out: the Session header alone, and no Authorization or DPoP for the model to supply (5.2).
    expect(uploads[0]!.headers["poppy-session"]).toBeTruthy();
    expect(uploads[0]!.headers.authorization).toBeUndefined();
    expect(uploads[0]!.headers.dpop).toBeUndefined();
    const photoId = /"id":"(pho_[A-Za-z0-9_-]+)"/.exec(await a.stub.poppyWaitForNotice("Done, as the User approved"))![1]!;
    const order = JSON.parse((await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder(photoId) })).text);
    expect(order.proposed).toMatch(/^apr2_/);
  });

  it("stops at the Company's terms when the signed-out Session they belong to ended: nothing is done, the User and model are told, and the order can be asked for again (N19)", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const { photoId, terms } = await termsForPrint(a, c);
    // The Company ends every Session; the approval names an operation of the old one (Ops 3).
    await c.stub.endAllSessions();
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    const failed = await until(async () => (await cards(a)).find((item) => item.id === terms.id && item.status === "failed"));
    expect(failed.open).toBe(false);
    // The approval went once on the ended Session and is never sent on a new one (approval_changed).
    expect(failed.result).toBe("The account or Session changed. Review a fresh request before sending it. [approval_changed]");
    expect(await a.stub.poppyWaitForNotice("The approved action failed")).toContain("[approval_changed]");
    expect((await printRequests(c)).filter((request) => "poppy-approval" in request.headers).map((request) => [request.status, request.error])).toEqual([[400, "invalid_session"]]);
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ state: "proposed", confirms: 0 })]);
    await expectFinalElsewhere(a, failed, "failed");
    // The new Session has no copy of the old Session's photo. A premature local
    // card used to hide this failure until another click (spec 5.5).
    const obsolete = await tool(a, "poppy_api_call", { domain: c.domain, operation: "orderPrints", body: printOrder(photoId) });
    expect(JSON.parse(obsolete.details)).toEqual({ error: "unknown_photo" });
    const fresh = await termsForPrint(a, c);
    expect(fresh.photoId).not.toBe(photoId);
    expect(fresh.terms.approvalId).toMatch(/^apr2_/);
    expect((await c.stub.state()).operations.every(operation => operation.confirms === 0)).toBe(true);
  });

  it("tells the User an order may have happened when the answer to its approved request was lost, and never sends it again (N19)", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const { terms } = await termsForPrint(a, c);
    // The Company performs the order, the answer never arrives, then the Session ends.
    await a.stub.poppyFault({ method: "POST", url: "/prints", mode: "throw" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ state: "succeeded", confirms: 1 })]);
    await c.stub.endAllSessions();
    await a.stub.poppyAdvance(10_000);
    const lost = await until(async () => (await cards(a)).find((item) => item.id === terms.id && item.status === "unknown"));
    expect(lost.open).toBe(false);
    expect(lost.result).toBe(`Sent as you approved, but no answer came from Mock Shop ${c.id}, so it may or may not have reached them. Check with Mock Shop ${c.id} before asking again.`);
    expect(await a.stub.poppyWaitForNotice("so it may or may not have happened")).toContain(`Tell the User to check with Mock Shop ${c.id}; it won't be retried automatically.`);
    await expectFinalElsewhere(a, lost, "unknown");
    // Performed once, and never sent again.
    await a.stub.poppyAdvance(120_000);
    expect((await c.stub.state()).operations).toEqual([expect.objectContaining({ confirms: 1 })]);
    expect((await printRequests(c)).filter((request) => "poppy-approval" in request.headers)).toHaveLength(1);
  });
});

/** The first bytes of a GIF, which the print shop doesn't take (422 invalid_image). */
function gif(size = 2000): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size).fill(0x42);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  return bytes;
}

describe("photos the User decides to send together on one card", () => {
  /** One upload call per photo, as the model makes them, each waiting on its own approval. */
  async function uploads(a: Awaited<ReturnType<typeof poppyAgent>>, c: Company, files: readonly AttachmentInfo[]) {
    for (const [index, info] of files.entries()) {
      await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: info.id } }, `call-${index}`);
    }
    return (await cards(a)).filter((card) => card.kind === "approval" && card.open);
  }

  it("sends each approved photo once, one at a time, declines the rest, and tells the model once", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const files = [await attached(a, jpeg(3000), { name: "lake.jpg" }), await attached(a, jpeg(3000), { name: "harbour.jpg" }), await attached(a, gif(), { name: "meadow.gif", type: "image/gif" }), await attached(a, jpeg(3000), { name: "spare.jpg" })];
    const waiting = await uploads(a, c, files);
    // Every one an upload to the same address: one key, which the page batches by.
    expect(new Set(waiting.map((card) => card.batchKey))).toEqual(new Set([`${c.hosts.issuer} POST ${c.hosts.api}/photos`]));

    await a.stub.poppyFrame({
      type: "poppy.approvals",
      decisions: waiting.map((card, index) => ({ approvalId: card.approvalId, decision: index === 3 ? "decline" : "approve" }))
    });
    expect(await photoRequests(c)).toHaveLength(3);
    const after = (await cards(a)).filter((card) => card.kind === "approval");
    expect(after.map((card) => [card.attachments[0].name, card.status, card.answer ?? null])).toEqual([
      ["lake.jpg", "done", null],
      ["harbour.jpg", "done", null],
      ["meadow.gif", "refused", { status: 422, error: "invalid_image" }],
      ["spare.jpg", "declined", null]
    ]);
    // One notice for the four, numbered, each with what happened; none of its own.
    const notices = await a.stub.poppyNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^\[system\] The User decided 4 requests together on one card:\n1\. Done, as the User approved: Send your photo “lake\.jpg”/);
    expect(notices[0]).toContain("3. Sent as the User approved, but Mock Shop");
    expect(notices[0]).toContain("answered 422 (invalid_image)");
    expect(notices[0]).toContain("4. The User declined: Send your photo “spare.jpg”");
    // Sent again, it does nothing: each was decided once.
    await a.stub.poppyFrame({ type: "poppy.approvals", decisions: waiting.map((card) => ({ approvalId: card.approvalId, decision: "approve" })) });
    expect(await photoRequests(c)).toHaveLength(3);
    expect(await a.stub.poppyNotices()).toHaveLength(1);
  });

  it("refuses a batch whose requests go to different Companies, and sends nothing", async () => {
    const c = await company({ printShop: true });
    const d = await company({ printShop: true });
    const a = await poppyAgent();
    const here = await uploads(a, c, [await attached(a)]);
    await tool(a, "poppy_api_call", { domain: d.domain, operation: "uploadPhoto", files: { photo: (await attached(a)).id } }, "call-other");
    const there = (await cards(a)).filter((card) => card.kind === "approval" && card.open && !here.some((item) => item.id === card.id));
    expect(here[0]!.batchKey).not.toBe(there[0]!.batchKey);
    await a.stub.poppyFrame({
      type: "poppy.approvals",
      decisions: [...here, ...there].map((card) => ({ approvalId: card.approvalId, decision: "approve" }))
    });
    expect(await photoRequests(c)).toEqual([]);
    expect(await photoRequests(d)).toEqual([]);
    expect((await cards(a)).filter((card) => card.kind === "approval" && card.open)).toHaveLength(2);
    expect(await a.stub.poppyNotices()).toEqual([]);
  });

  it("refuses a batch with a request that isn't an upload of the User's photo", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const [photo] = await uploads(a, c, [await attached(a)]);
    // A website form the agent filled waits on its own approval, with no batch key.
    const other = { approvalId: "apr_not_an_upload" };
    await a.stub.poppySql(
      "INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at) VALUES (?, ?, 'x', 'Submit a form', ?, 'pending', 0)",
      other.approvalId,
      c.hosts.issuer,
      JSON.stringify({ v: 2, kind: "browse-submit", submission: { from: `https://${c.domain}/`, method: "POST", action: `https://${c.domain}/f`, enctype: "application/x-www-form-urlencoded", fields: [] } })
    );
    await a.stub.poppyFrame({ type: "poppy.approvals", decisions: [photo!, other].map((card) => ({ approvalId: card.approvalId, decision: "approve" })) });
    expect(await photoRequests(c)).toEqual([]);
    expect(JSON.parse(await a.stub.poppySql("SELECT status FROM poppy_approvals ORDER BY created_at"))).toEqual([{ status: "pending" }, { status: "pending" }]);
  });

  it("tells the model after a restart what a batch it stopped part way through did, and leaves the rest waiting", async () => {
    const c = await company({ printShop: true });
    const a = await poppyAgent();
    const [first, second] = await uploads(a, c, [await attached(a, jpeg(3000), { name: "lake.jpg" }), await attached(a, jpeg(3000), { name: "harbour.jpg" })]);
    // The first was sent and the agent stopped before the second, and before telling the model.
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: first!.approvalId, decision: "approve" });
    await a.stub.poppySql("DELETE FROM test_notices");
    await a.stub.poppySql("INSERT INTO poppy_approval_batches (id, ids, told, created_at) VALUES ('apb_test', ?, 0, 0)", JSON.stringify([first!.approvalId, second!.approvalId]));
    await a.stub.poppyRestart();
    const notice = await a.stub.poppyWaitForNotice("The User decided");
    expect(notice).toContain("1. Done, as the User approved: Send your photo “lake.jpg”");
    expect(notice).not.toContain("harbour.jpg");
    expect(JSON.parse(await a.stub.poppySql("SELECT told FROM poppy_approval_batches"))).toEqual([{ told: 1 }]);
    expect((await cards(a)).find((card) => card.id === second!.id)).toMatchObject({ open: true, status: "pending" });
  });
});
