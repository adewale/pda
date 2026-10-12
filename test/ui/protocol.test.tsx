import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PoppyClientFrame, ProtocolCompany, ProtocolEntry } from "../../src/poppy/wire";
import { ActivityPage } from "../../src/ui/activity";
import { protocolText } from "../../src/ui/protocol";
import { reducePoppy, type PoppyView, type ProtocolLogView, type ProtocolView } from "../../src/use-pi-session";

/**
 * The protocol view in Activity (src/ui/protocol.tsx): a disclosure per
 * Company that asks the agent for that Company's log only when opened, and
 * again when it grows; each exchange with its time, spec section, summary
 * and outcome; and the log copied or downloaded as plain text.
 */

const AT = Date.UTC(2026, 9, 12, 9, 30, 5, 120);
const ISSUER = "https://auth.print.example";

const company: ProtocolCompany = { key: ISSUER, company: "Print with Poppy", domain: "print.example", issuer: ISSUER, count: 3, lastSeq: 3, lastAt: AT + 2000 };

const entries: ProtocolEntry[] = [
  {
    seq: 1,
    at: AT,
    section: "§3",
    title: "Discovery",
    step: "discovery.poppy",
    method: "GET",
    url: "https://print.example/.well-known/poppy.json",
    status: 200,
    error: null,
    outcome: "ok",
    summary: "Fetch poppy.json, without credentials",
    result: "200 · application/json"
  },
  {
    seq: 2,
    at: AT + 1000,
    section: "§4.2",
    title: "Session",
    step: "session.start",
    method: "POST",
    url: "https://auth.print.example/oauth/token",
    status: 400,
    error: "use_dpop_nonce",
    outcome: "retry",
    summary: "Start a Session: jwt-bearer grant with a Session assertion, no session_id, client assertion, DPoP proof",
    result: "400 use_dpop_nonce: sending again with the Company's DPoP-Nonce and a new proof"
  },
  {
    seq: 3,
    at: AT + 2000,
    section: "Ops §5.2",
    title: "Confirming",
    step: "operation.confirm",
    method: "POST",
    url: "https://api.print.example/poppy/operations/op_1/confirm",
    status: 200,
    error: null,
    outcome: "ok",
    summary: "Confirm op_1, revision 2, approved_by user · DPoP",
    result: "200"
  }
];

const log: ProtocolLogView = { type: "poppy.protocol", key: ISSUER, company: "Print with Poppy", domain: "print.example", issuer: ISSUER, entries };

/** Activity with `protocol`; `sent` holds the protocol frames, `diagnostics` how many times it asked for the diagnostics. */
function page(protocol: ProtocolView) {
  const sent: PoppyClientFrame[] = [];
  let diagnostics = 0;
  const send = (frame: PoppyClientFrame) => {
    if (frame.type === "poppy.diagnostics") diagnostics++;
    else sent.push(frame);
  };
  const view = render(<ActivityPage activity={{ inProgress: [], log: [] }} protocol={protocol} send={send} />);
  const rerender = (next: ProtocolView) => view.rerender(<ActivityPage activity={{ inProgress: [], log: [] }} protocol={next} send={send} />);
  return { sent, rerender, asked: () => diagnostics };
}

describe("protocol view", () => {
  it("waits for the agent, then says what will appear when no Company has been contacted", () => {
    const { rerender } = page({ companies: null, logs: {} });
    expect(screen.getByRole("status", { name: "Loading the protocol view" })).toBeTruthy();
    rerender({ companies: [], logs: {} });
    expect(screen.getByText("No exchanges yet")).toBeTruthy();
  });

  it("lists each Company behind a closed disclosure, and asks for its log only when opened", () => {
    const { sent, rerender } = page({ companies: [company], logs: {} });
    const toggle = screen.getByRole("button", { name: /Protocol · Print with Poppy \(print\.example\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("3 exchanges");
    expect(sent).toEqual([]);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(sent).toEqual([{ type: "poppy.protocol", key: ISSUER }]);
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(within(panel).getByRole("status", { name: "Loading the protocol log for Print with Poppy" })).toBeTruthy();

    rerender({ companies: [company], logs: { [ISSUER]: log } });
    const list = screen.getByRole("list", { name: "Protocol exchanges with Print with Poppy, oldest first" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Each exchange: time with seconds, spec section, what was sent, where, what came back, the outcome.
    expect(items[1]!.textContent).toContain("§4.2 Session");
    expect(items[1]!.textContent).toContain("Start a Session: jwt-bearer grant");
    expect(items[1]!.textContent).toContain("POST https://auth.print.example/oauth/token");
    expect(items[1]!.textContent).toContain("→ 400 use_dpop_nonce: sending again");
    expect(items[1]!.textContent).toContain("Sent again");
    expect(items[2]!.textContent).toContain("Ops §5.2 Confirming");
    expect(within(items[0]!).getByText(/\d\d:\d\d:\d\d\.120/).getAttribute("datetime")).toBe(new Date(AT).toISOString());

    // Closing it stops asking; it shows no entries.
    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: /Protocol exchanges/ })).toBeNull();
  });

  it("asks again when the log grows while it is open, and not when it is closed", () => {
    const { sent, rerender } = page({ companies: [company], logs: { [ISSUER]: log } });
    rerender({ companies: [{ ...company, count: 4, lastSeq: 4 }], logs: { [ISSUER]: log } });
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Protocol · Print with Poppy/ }));
    rerender({ companies: [{ ...company, count: 5, lastSeq: 5 }], logs: { [ISSUER]: log } });
    expect(sent).toEqual([
      { type: "poppy.protocol", key: ISSUER },
      { type: "poppy.protocol", key: ISSUER }
    ]);
  });

  it("copies the log as plain text, one exchange a line, with the same fields", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    page({ companies: [company], logs: { [ISSUER]: log } });
    fireEvent.click(screen.getByRole("button", { name: /Protocol · Print with Poppy/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0];
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("Poppy protocol log: Print with Poppy (print.example)");
    expect(lines[1]).toBe(`Issuer: ${ISSUER}`);
    expect(text).toContain("Never recorded: headers, bodies, tokens");
    expect(lines.slice(-3)).toEqual([
      `${new Date(AT).toISOString()} | §3 Discovery | GET https://print.example/.well-known/poppy.json | Fetch poppy.json, without credentials | -> 200 · application/json [ok]`,
      `${new Date(AT + 1000).toISOString()} | §4.2 Session | POST https://auth.print.example/oauth/token | Start a Session: jwt-bearer grant with a Session assertion, no session_id, client assertion, DPoP proof | -> 400 use_dpop_nonce: sending again with the Company's DPoP-Nonce and a new proof [retry]`,
      `${new Date(AT + 2000).toISOString()} | Ops §5.2 Confirming | POST https://api.print.example/poppy/operations/op_1/confirm | Confirm op_1, revision 2, approved_by user · DPoP | -> 200 [ok]`
    ]);
    expect(screen.getByText("Copied as text.").getAttribute("role")).toBe("status");
  });

  it("downloads the same text as a .txt file named for the Company", () => {
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created.push(blob as Blob);
      return "blob:protocol";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    page({ companies: [company], logs: { [ISSUER]: log } });
    fireEvent.click(screen.getByRole("button", { name: /Protocol · Print with Poppy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download .txt" }));
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toMatch(/^poppy-protocol-print\.example-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(clicked[0]!.href).toBe("blob:protocol");
    expect(created[0]!.type).toBe("text/plain;charset=utf-8");
  });

  it("folds the index and each log into the page's view", () => {
    const empty: PoppyView = { cards: [], accounts: [], permissions: [], direct: {}, activity: null, protocol: { companies: null, logs: {} } };
    const indexed = reducePoppy(empty, { type: "poppy.protocol.index", companies: [company] });
    expect(indexed.protocol).toEqual({ companies: [company], logs: {} });
    const loaded = reducePoppy(indexed, log);
    expect(loaded.protocol.logs[ISSUER]).toBe(log);
    expect(protocolText(log, AT)).toContain(`Exported: ${new Date(AT).toISOString()}; 3 entries, oldest first; times in UTC`);
  });
});

/**
 * "Copy diagnostics" (src/ui/protocol.tsx): the agent's newest events and
 * the protocol logs, as the agent's `poppy.diagnostics` frame carries them,
 * copied for the operator. Asked for when Activity opens, so the text is
 * ready when the button is pressed, and again after each copy.
 */
describe("diagnostics", () => {
  const text = 'Personal agent diagnostics\nAgent: 0123abcd\n\n{"kind":"turn","outcome":"success"}\n';

  it("asks the agent once when Activity opens, and copies what it sent", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { asked, rerender, sent } = page({ companies: [], logs: {} });
    expect(asked()).toBe(1);
    rerender({ companies: [], logs: {}, diagnostics: { text, at: AT } });
    expect(asked()).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    });
    expect(writeText).toHaveBeenCalledWith(text);
    expect(screen.getByText("Copied. Paste them into your message to the operator.").getAttribute("role")).toBe("status");
    // Fresh for the next copy; nothing else was sent.
    expect(asked()).toBe(2);
    expect(sent).toEqual([]);
  });

  it("says to wait when the agent hasn't answered yet, and asks again", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { asked } = page({ companies: [], logs: {} });
    expect((screen.getByRole("button", { name: "Download diagnostics" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText(/Still getting them from your agent/)).toBeTruthy();
    expect(asked()).toBe(2);
  });

  it("folds the agent's frame into the page's view", () => {
    const empty: PoppyView = { cards: [], accounts: [], permissions: [], direct: {}, activity: null, protocol: { companies: [company], logs: {} } };
    const folded = reducePoppy(empty, { type: "poppy.diagnostics", text, at: AT });
    expect(folded.protocol).toEqual({ companies: [company], logs: {}, diagnostics: { text, at: AT } });
  });
});
