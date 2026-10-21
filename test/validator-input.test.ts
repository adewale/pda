import { describe, expect, it } from "vitest";
import { handleValidator, type ValidatorHttpOptions } from "../src/validator/http";
import { checkJsonWork, HTTP_INPUT_LIMITS, readInputBytes } from "../src/validator/input";

const origin = "https://agent.test";
const encoder = new TextEncoder();

function streamed(text: string, type = "application/json", extra: HeadersInit = {}): Request {
  const bytes = encoder.encode(text);
  return new Request(`${origin}/validator/api`, {
    method: "POST",
    headers: { "Content-Type": type, ...extra },
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } })
  });
}

function options(extra: Partial<ValidatorHttpOptions> = {}): ValidatorHttpOptions {
  return {
    fetcher: async () => { throw new Error("No network request expected"); },
    allowFetch: async () => { throw new Error("No URL fetch quota expected"); },
    ...extra
  };
}

describe("validator input resource limits", () => {
  it("reads small streamed JSON without requiring a declared length and preserves CORS", async () => {
    const request = streamed(JSON.stringify({ document: "{}" }));
    expect(request.headers.get("Content-Length")).toBeNull();
    const result = await handleValidator(request, options());
    expect(result!.status).toBe(200);
    expect(result!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await result!.json()).toMatchObject({ outcome: "invalid" });
  });

  it("rejects an oversized no-length envelope even when its document is small", async () => {
    const result = await handleValidator(streamed(JSON.stringify({ document: "{}", ignored: "x".repeat(500_000) })), options());
    expect(result!.status).toBe(413);
    expect(await result!.json()).toMatchObject({ error: "The request is larger than 200 KB." });
  });

  it("counts streamed bytes rather than a smaller declared length, and cancels without waiting", async () => {
    let cancelled = false;
    const request = new Request(`${origin}/validator/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(HTTP_INPUT_LIMITS.envelopeBytes + 1)); },
        cancel() { cancelled = true; return new Promise<void>(() => {}); }
      })
    });
    const result = await handleValidator(request, options());
    expect(result!.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("caps actual UTF-8 bytes and accepts an envelope exactly at the limit", async () => {
    const prefix = '{"document":"{}","ignored":"';
    const suffix = '"}';
    const room = HTTP_INPUT_LIMITS.envelopeBytes - encoder.encode(prefix + suffix).byteLength;
    expect((await handleValidator(streamed(prefix + "x".repeat(room) + suffix), options()))!.status).toBe(200);
    expect((await handleValidator(streamed(prefix + "é".repeat(room) + suffix), options()))!.status).toBe(413);
  });

  it("bounds multipart uploads before parsing ignored file fields", async () => {
    const form = new FormData();
    form.set("document", "{}");
    form.set("ignored", new Blob([new Uint8Array(HTTP_INPUT_LIMITS.envelopeBytes + 1)]), "ignored.bin");
    const request = new Request(`${origin}/validator/api`, { method: "POST", body: form });
    expect((await handleValidator(request, options()))!.status).toBe(413);
  });

  it("still accepts small URL-encoded and multipart document submissions", async () => {
    for (const body of [new URLSearchParams({ document: "{}" }), (() => { const form = new FormData(); form.set("document", "{}"); return form; })()]) {
      const request = new Request(`${origin}/validator/api`, { method: "POST", body });
      expect((await handleValidator(request, options()))!.status).toBe(200);
    }
  });

  it("limits form fields and auxiliary metadata", async () => {
    const form = new URLSearchParams({ document: "{}" });
    for (let i = 0; i < HTTP_INPUT_LIMITS.formFields; i++) form.append("ignored", "x");
    expect((await handleValidator(new Request(`${origin}/validator/api`, { method: "POST", body: form }), options()))!.status).toBe(413);
    expect((await handleValidator(streamed(JSON.stringify({ document: "{}", domain: "x".repeat(2049) })), options()))!.status).toBe(413);
  });

  it("rejects deeply nested object documents and string documents before recursive validation", async () => {
    const document = "[".repeat(80) + "0" + "]".repeat(80);
    for (const body of [`{"document":${document}}`, JSON.stringify({ document })]) {
      expect((await handleValidator(streamed(body), options()))!.status).toBe(413);
    }
    expect(() => checkJsonWork(JSON.stringify({ text: '[escaped brackets] \\" {}' }))).not.toThrow();
    expect(() => checkJsonWork(JSON.stringify(Array.from({ length: 21_000 }, () => 0)))).toThrow("too many members");
  });

  it("ends a stalled read and cancels its stream even when cancellation never resolves", async () => {
    let cancelled = false;
    const request = new Request(`${origin}/validator/api`, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull() { return new Promise<void>(() => {}); },
        cancel() { cancelled = true; return new Promise<void>(() => {}); }
      })
    });
    await expect(readInputBytes(request, 10)).rejects.toMatchObject({ status: 408 });
    expect(cancelled).toBe(true);
  });

  it("cancels a read when the caller aborts", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const request = new Request(`${origin}/validator/api`, {
      method: "POST", signal: controller.signal,
      body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })
    });
    const reading = readInputBytes(request);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ status: 400 });
    expect(cancelled).toBe(true);
  });

  it("admits document work before reading a body, independently of fetch quota", async () => {
    let cancelled = false;
    let fetchQuota = false;
    const request = new Request(`${origin}/validator/api`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })
    });
    const result = await handleValidator(request, options({ allowRequest: async () => false, allowFetch: async () => { fetchQuota = true; return true; } }));
    expect(result!.status).toBe(429);
    expect(cancelled).toBe(true);
    expect(fetchQuota).toBe(false);
    const form = await handleValidator(new Request(`${origin}/validator`), options({ allowRequest: async () => { throw new Error("The empty form needs no quota"); } }));
    expect(form!.status).toBe(200);
  });

  it("keeps general input admission separate from the URL fetch quota", async () => {
    const calls: string[] = [];
    const limits = options({
      allowRequest: async () => { calls.push("input"); return true; },
      allowFetch: async () => { calls.push("fetch"); return false; }
    });
    expect((await handleValidator(streamed(JSON.stringify({ document: "{}" })), limits))!.status).toBe(200);
    expect(calls).toEqual(["input"]);
    expect((await handleValidator(new Request(`${origin}/validator/api?url=example.com`), limits))!.status).toBe(429);
    expect(calls).toEqual(["input", "input", "fetch"]);
  });
});
