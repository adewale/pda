import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePiSession } from "../../src/use-pi-session";

type Handlers = {
  query?: { workspace?: string };
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onMessage?: (event: MessageEvent) => void;
};
type Frame = { type: string; [key: string]: unknown };
class Socket {
  readyState: number = WebSocket.CONNECTING;
  handlers: Handlers = {};
  frames: Frame[] = [];
  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("sent while closed");
    this.frames.push(JSON.parse(data));
  }
  open() { act(() => { this.readyState = WebSocket.OPEN; this.handlers.onOpen?.(new Event("open")); }); }
  close(code = 1006) { act(() => { this.readyState = WebSocket.CLOSED; this.handlers.onClose?.(new CloseEvent("close", { code })); }); }
  submits() { return this.frames.filter(frame => frame.type === "submit"); }
}
let socket: Socket;
vi.mock("agents/react", () => ({ useAgent: (options: Handlers) => { socket.handlers = options; return socket; } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function authenticated(workspaceId = "workspace-a") { return Response.json({ provider: "google", email: "ada@example.com", workspaceId }); }
async function tick() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
beforeEach(() => { socket = new Socket(); });
afterEach(() => { vi.unstubAllGlobals(); });

it("binds its initial WebSocket and queued text to the workspace from the authenticated page bootstrap", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => authenticated()));
  const { result } = renderHook(() => usePiSession("workspace-a"));
  act(() => result.current.submit("Private text belonging to A"));
  expect(socket.handlers.query).toMatchObject({ workspace: "workspace-a" });
  expect(socket.frames).toEqual([]);
  // The actual Worker independently rejects a socket whose authenticated
  // actor differs from this immutable bootstrap binding.
  socket.open();
  expect(socket.submits()).toHaveLength(1);
  expect(socket.submits()[0]).toMatchObject({ input: "Private text belonging to A" });
  expect(result.current.status).toBe("open");
});

it("never replays A's pending text when a reconnect authenticates as workspace B before an older 401 resolves", async () => {
  const oldCheck = deferred<Response>();
  let phase: "first" | "disconnected" | "reconnected" = "first";
  const fetcher = vi.fn(() => phase === "first" ? Promise.resolve(authenticated()) : phase === "disconnected" ? oldCheck.promise : Promise.resolve(authenticated("workspace-b")));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => usePiSession("workspace-a"));
  socket.open();
  await waitFor(() => expect(result.current.status).toBe("open"));
  act(() => result.current.submit("Unanswered private A message"));
  expect(socket.submits()).toHaveLength(1);
  phase = "disconnected";
  socket.close();
  socket.open();
  await tick();
  phase = "reconnected";
  socket.close();
  socket.open();
  await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
  await act(async () => { oldCheck.resolve(new Response(null, { status: 401 })); });
  expect(socket.submits()).toHaveLength(1);
  expect(result.current.outbox).toMatchObject([{ text: "Unanswered private A message", state: "waiting" }]);
  socket.open();
  await tick();
  expect(socket.submits()).toHaveLength(1);
});

it("does not let a stale successful check authorize a newer reconnect while that connection is still being checked", async () => {
  const oldCheck = deferred<Response>();
  const currentCheck = deferred<Response>();
  let phase: "first" | "disconnected" | "reconnected" = "first";
  vi.stubGlobal("fetch", vi.fn(() => phase === "first" ? Promise.resolve(authenticated()) : phase === "disconnected" ? oldCheck.promise : currentCheck.promise));
  const { result } = renderHook(() => usePiSession("workspace-a"));
  socket.open();
  await waitFor(() => expect(result.current.status).toBe("open"));
  act(() => result.current.submit("Must wait for this connection's check"));
  phase = "disconnected";
  socket.close();
  socket.open();
  await tick();
  phase = "reconnected";
  socket.close();
  socket.open();
  await act(async () => { oldCheck.resolve(authenticated()); });
  expect(socket.submits()).toHaveLength(1);
  expect(result.current.status).not.toBe("open");
  await act(async () => { currentCheck.resolve(authenticated("workspace-b")); });
  await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
  expect(socket.submits()).toHaveLength(1);
});

it("preserves automatic reconnect for the same workspace and retries exactly the original operation", async () => {
  const fetcher = vi.fn(async () => authenticated());
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => usePiSession("workspace-a"));
  socket.open();
  await waitFor(() => expect(result.current.status).toBe("open"));
  act(() => result.current.submit("Safe same-workspace retry"));
  const original = socket.submits()[0];
  socket.close();
  socket.open();
  await waitFor(() => expect(socket.submits()).toHaveLength(2));
  expect(socket.submits()).toEqual([original, original]);
  expect(result.current.status).toBe("open");
  expect(fetcher).toHaveBeenCalledWith("/api/me", expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
});
