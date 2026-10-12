import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentMarker, MAX_ATTACHMENT_BYTES, type AttachmentInfo } from "../../src/attachments";
import { PoppyCards } from "../../src/poppy-ui";
import type { Card, PoppyClientFrame } from "../../src/poppy/wire";
import type { TranscriptMessage } from "../../src/protocol";
import { ChatPage } from "../../src/ui/chat";
import { Transcript } from "../../src/ui/transcript";
import type { PiSession, PoppyView } from "../../src/use-pi-session";

/**
 * Photos on the page (src/ui/attachments.tsx): attaching one in the
 * composer, by the picker or by pasting, each sent to the User's own agent
 * and named in the message by a marker; the photo where it was sent; and the
 * approval card that asks before a photo goes to a Company.
 */

const LAKE: AttachmentInfo = { id: "att_AbCdEfGhIjKlMnOpQrStUv", name: "lake.jpg", type: "image/jpeg", size: 2_516_582 };

function session(patch: Partial<PiSession> = {}) {
  const submitted: string[] = [];
  const value = {
    messages: [],
    live: null,
    running: false,
    tools: [],
    queued: 0,
    retry: null,
    model: null,
    error: null,
    status: "open",
    catalog: [],
    summaries: new Set<string>(),
    poppy: { cards: [], accounts: [], permissions: [], direct: {}, activity: null, protocol: { companies: null, logs: {} } },
    submit: (text: string) => void submitted.push(text),
    abort: () => undefined,
    reset: () => undefined,
    sendPoppy: () => undefined,
    ...patch
  } as unknown as PiSession;
  return { value, submitted };
}

type Call = { url: string; method: string; body: unknown };

/** `fetch` for the page: `POST /api/attachments` answers `answer` (LAKE by default), and every call is recorded. */
function stubFetch(answer: () => Response | Promise<Response> = () => Response.json(LAKE, { status: 201 })) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: init?.body };
      calls.push(call);
      if (call.url === "/api/attachments" && call.method === "POST") return answer();
      if (call.url.startsWith("/api/attachments/") && call.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("Not found", { status: 404 });
    })
  );
  return calls;
}

function photo(name = "lake.jpg", type = "image/jpeg", size = 2048): File {
  const file = new File([new Uint8Array(Math.min(size, 4096))], name, { type });
  if (size > 4096) Object.defineProperty(file, "size", { value: size });
  return file;
}

function chat(fixture = session()) {
  render(<ChatPage session={fixture.value} hidden={new Set()} setHidden={() => undefined} />);
  return fixture;
}

const pick = (...files: File[]) => fireEvent.change(screen.getByTestId("attach-input"), { target: { files } });

beforeEach(() => {
  vi.stubGlobal("crypto", { ...crypto, randomUUID: () => `${Math.random()}` });
});

afterEach(() => vi.unstubAllGlobals());

describe("attaching a photo in the composer", () => {
  it("offers a labelled button for photos only", () => {
    stubFetch();
    chat();
    expect(screen.getByRole("button", { name: "Attach a photo" })).toBeTruthy();
    expect(screen.getByTestId("attach-input").getAttribute("accept")).toBe("image/jpeg,image/png,image/webp,image/gif");
  });

  it("sends a picked photo to the User's own agent, shows it, and names it in the message by its marker", async () => {
    const calls = stubFetch();
    const fixture = chat();
    pick(photo());
    expect(await screen.findByText("Attaching…")).toBeTruthy();
    const list = await screen.findByRole("list", { name: "Photos to send" });
    await waitFor(() => expect(within(list).getByText("2.4 MB")).toBeTruthy());
    expect(list.querySelector("img")!.getAttribute("src")).toBe(`/api/attachments/${LAKE.id}`);
    const upload = calls.find((call) => call.url === "/api/attachments")!;
    expect(upload.method).toBe("POST");
    expect((upload.body as FormData).get("file")).toBeInstanceOf(File);

    fireEvent.change(screen.getByRole("textbox", { name: "Message your agent" }), { target: { value: "Print this as a 6×4" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(fixture.submitted).toEqual([`Print this as a 6×4\n\n${attachmentMarker(LAKE)}`]);
    expect(screen.queryByRole("list", { name: "Photos to send" })).toBeNull();
  });

  it("can send a photo with no words", async () => {
    stubFetch();
    const fixture = chat();
    pick(photo());
    await screen.findByText("2.4 MB");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(fixture.submitted).toEqual([attachmentMarker(LAKE)]);
  });

  it("can't send while a photo is still on its way", async () => {
    let answer!: (response: Response) => void;
    stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    chat();
    fireEvent.change(screen.getByRole("textbox", { name: "Message your agent" }), { target: { value: "Print this" } });
    pick(photo());
    await screen.findByText("Attaching…");
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    answer(Response.json(LAKE, { status: 201 }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("takes a pasted photo", async () => {
    const calls = stubFetch();
    chat();
    fireEvent.paste(screen.getByRole("textbox", { name: "Message your agent" }), { clipboardData: { files: [photo("paste.png", "image/png")] } });
    await screen.findByText("2.4 MB");
    expect(calls.filter((call) => call.url === "/api/attachments")).toHaveLength(1);
  });

  it("refuses a file that isn't a photo, or is over 10 MB, without sending it anywhere", async () => {
    const calls = stubFetch();
    chat();
    pick(photo("notes.txt", "text/plain"), photo("huge.jpg", "image/jpeg", MAX_ATTACHMENT_BYTES + 1));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      "notes.txt isn't a JPEG, PNG, WebP or GIF photo.",
      "huge.jpg is 10.0 MB; the most your agent takes is 10.0 MB."
    ]);
    expect(calls).toEqual([]);
  });

  it("shows the agent's reason when it refuses a photo", async () => {
    stubFetch(() => Response.json({ error: "Attach a photo: JPEG, PNG, WebP or GIF." }, { status: 415 }));
    chat();
    pick(photo());
    expect((await screen.findByRole("alert")).textContent).toBe("Attach a photo: JPEG, PNG, WebP or GIF.");
  });

  it("forgets a photo the User removes before sending", async () => {
    const calls = stubFetch();
    const fixture = chat();
    pick(photo());
    await screen.findByText("2.4 MB");
    fireEvent.click(screen.getByRole("button", { name: "Remove lake.jpg" }));
    expect(calls.at(-1)).toMatchObject({ url: `/api/attachments/${LAKE.id}`, method: "DELETE" });
    expect(screen.queryByRole("list", { name: "Photos to send" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Message your agent" }), { target: { value: "never mind" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(fixture.submitted).toEqual(["never mind"]);
  });
});

describe("a sent photo", () => {
  it("shows the photo from the User's agent, not the marker", () => {
    const message: TranscriptMessage = {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: `Print this as a 6×4\n\n${attachmentMarker(LAKE)}` }],
      timestamp: 0
    };
    const { container } = render(<Transcript messages={[message]} live={null} runningTools={[]} />);
    const image = screen.getByRole("img", { name: "lake.jpg" });
    expect(image.getAttribute("src")).toBe(`/api/attachments/${LAKE.id}`);
    expect(container.textContent).toContain("Print this as a 6×4");
    expect(container.textContent).not.toContain("[attachment");
  });
});

describe("cards about photos and orders", () => {
  const view = (cards: Card[]): PoppyView => ({ cards, accounts: [], permissions: [], direct: {}, activity: null, protocol: { companies: null, logs: {} } });

  it("asks before a photo is sent to a Company, showing the photo, and sends a frame only on a click", () => {
    const sent: PoppyClientFrame[] = [];
    const card: Card = {
      id: "approval-apr_1",
      kind: "approval",
      company: "Print with Poppy",
      domain: "print-with-poppy.example",
      open: true,
      approvalId: "apr_1",
      summary: "Send your photo “lake.jpg” (JPEG, 2.4 MB) to Print with Poppy: POST /api/photos (Upload and normalize a private print photo)",
      status: "pending",
      attachments: [LAKE]
    };
    render(<PoppyCards view={view([card])} send={(frame) => void sent.push(frame)} />);
    expect(screen.getByRole("heading", { name: "Send this photo to Print with Poppy?" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "lake.jpg" }).getAttribute("src")).toBe(`/api/attachments/${LAKE.id}`);
    expect(screen.getByText(/goes only to this Company/)).toBeTruthy();
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent).toEqual([{ type: "poppy.approval", approvalId: "apr_1", decision: "approve" }]);
  });

  const order = (patch: Partial<Extract<Card, { kind: "operation" }>>): Card => ({
    id: "op-1",
    kind: "operation",
    company: "Print with Poppy",
    domain: "print-with-poppy.example",
    open: false,
    issuer: "https://print-with-poppy.example",
    operationId: "op_1",
    revision: 1,
    state: "succeeded",
    summary: "Prepare checkout for 1 4×6 Prints (lustre)",
    account: null,
    highlights: [],
    userApprovalRequired: true,
    approvedBy: "user",
    ...patch
  });

  it("links a finished order's checkout on the receipt, only over HTTPS", () => {
    render(
      <PoppyCards
        view={view([order({ result: "Approved order prepared.", links: [{ label: "checkout", url: "https://print-with-poppy.example/checkout/ord_1" }, { label: "status", url: "javascript:alert(1)" }] })])}
        send={() => undefined}
      />
    );
    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Open checkout at Print with Poppy", "https://print-with-poppy.example/checkout/ord_1"]
    ]);
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says when the Company no longer has an order, and whether it may have happened (N19)", () => {
    const { rerender } = render(<PoppyCards view={view([order({ state: "proposed", lost: "not_done" })])} send={() => undefined} />);
    expect(screen.getByText(/It wasn't done/)).toBeTruthy();
    rerender(<PoppyCards view={view([order({ state: "in_progress", lost: "unknown" })])} send={() => undefined} />);
    expect(screen.getByText(/It may have happened: check with Print with Poppy before asking again\./)).toBeTruthy();
  });
});
