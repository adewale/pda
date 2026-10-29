import { afterEach, expect, it, vi } from "vitest";
import { readSseChunk, SseLineEndings } from "../../src/poppy/sse";

afterEach(() => vi.useRealTimers());

it("keeps no deadline timers after any immediate stream chunk or EOF", async () => {
  vi.useFakeTimers();
  const reader = new ReadableStream<string>({ start(controller) {
    for (let i = 0; i < 1_000; ++i) controller.enqueue("x");
    controller.close();
  } }).getReader();
  const deadline = Date.now() + 60_000;
  try {
    for (let i = 0; i < 1_000; ++i) {
      expect(await readSseChunk(reader, deadline)).toEqual({ value: "x", done: false });
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(await readSseChunk(reader, deadline)).toMatchObject({ done: true });
    expect(vi.getTimerCount()).toBe(0);
  } finally { await reader.cancel(); }
});

it("clears the deadline timer when a stream read rejects", async () => {
  vi.useFakeTimers();
  const failure = new Error("The peer disconnected");
  const reader = { read: () => Promise.reject(failure) };
  await expect(readSseChunk(reader, Date.now() + 60_000)).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

it("returns timeout at the fixed deadline without leaving a pending timer", async () => {
  vi.useFakeTimers();
  const reader = { read: () => new Promise<ReadableStreamReadResult<string>>(() => {}) };
  const pending = readSseChunk(reader, Date.now() + 25);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(24);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe("timeout");
  expect(vi.getTimerCount()).toBe(0);
});

it("emits a terminal CR immediately, preserves it through empty chunks and suppresses its following LF", () => {
  const normalizer = new SseLineEndings();
  expect(normalizer.normalize("data: value\r")).toBe("data: value\n");
  expect(normalizer.normalize("")).toBe("");
  expect(normalizer.normalize("\n\r")).toBe("\n");
  expect(normalizer.normalize("\r\n")).toBe("\n");
});
