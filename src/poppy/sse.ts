/** Maximum UTF-16 code units in one SSE event or unfinished streamed message. */
export const MAX_SSE_CHARS = 2_000_000;

/**
 * SSE accepts LF, CR and CRLF. A transport chunk can end between CR and LF;
 * remember that CR so its following LF never invents a blank event boundary.
 */
export class SseLineEndings {
  #afterCr = false;

  normalize(chunk: string): string {
    if (chunk.length === 0) return "";
    const skip = this.#afterCr && chunk.startsWith("\n") ? 1 : 0;
    this.#afterCr = chunk.endsWith("\r");
    // CR is emitted immediately, including a terminal CR. The state only
    // suppresses a following LF, so the end of a stream needs no flush.
    return chunk.slice(skip).replace(/\r\n?/g, "\n");
  }
}

/** One read against the stream's fixed deadline. Callers own cancellation. */
export async function readSseChunk(reader: Pick<ReadableStreamDefaultReader<string>, "read">, deadline: number): Promise<ReadableStreamReadResult<string> | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now())); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
