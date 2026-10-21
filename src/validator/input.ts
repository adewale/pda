/** Resource limits for the public HTTP service, separate from document conformance rules. */
export const HTTP_INPUT_LIMITS = {
  envelopeBytes: 200_000,
  bodyMs: 10_000,
  depth: 64,
  structure: 20_000,
  formFields: 64
} as const;

export class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Count actual bytes before any JSON or multipart parser runs. A declared
 * length only permits an early refusal; streamed requests need no length.
 * Cancellation never waits for an uncooperative body's cancel promise.
 */
export async function readInputBytes(request: Request, timeoutMs: number = HTTP_INPUT_LIMITS.bodyMs): Promise<Uint8Array<ArrayBuffer>> {
  const cancelBody = () => void request.body?.cancel().catch(() => undefined);
  if (Number(request.headers.get("Content-Length") ?? "0") > HTTP_INPUT_LIMITS.envelopeBytes) {
    cancelBody();
    throw new InputError("The request is larger than 200 KB.", 413);
  }
  if (request.signal.aborted) {
    cancelBody();
    throw new InputError("The request was cancelled.", 400);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InputError("The request body took too long.", 408)), timeoutMs);
    onAbort = () => reject(new InputError("The request was cancelled.", 400));
    request.signal.addEventListener("abort", onAbort, { once: true });
  });
  // The deadline may win between two reads; it must still be observed.
  stopped.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      size += value.byteLength;
      if (size > HTTP_INPUT_LIMITS.envelopeBytes) throw new InputError("The request is larger than 200 KB.", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("The request body couldn't be read.");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * Linear preflight before native JSON.parse/stringify or the validator's
 * recursive parser. Brackets inside strings (including escaped quotes) do
 * not count. Syntax and conformance diagnostics remain the parser's job.
 */
export function checkJsonWork(text: string, maxDepth: number = HTTP_INPUT_LIMITS.depth): void {
  let depth = 0;
  let structure = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      depth++;
      structure++;
      if (depth > maxDepth) throw new InputError("The JSON is nested too deeply.", 413);
    } else if (char === "}" || char === "]") depth--;
    else if (char === "," || char === ":") structure++;
    if (structure > HTTP_INPUT_LIMITS.structure) throw new InputError("The JSON contains too many members or values.", 413);
  }
}
