/**
 * Interop-only: Workers' `HTMLRewriter` for Node, over `html-rewriter-wasm`,
 * Cloudflare's lol-html compiled to WebAssembly (BSD-3-Clause). Node has no
 * `HTMLRewriter`, and src/poppy/fetch-browser.ts reads every page with one.
 * At 0.3 that matters to the grid: the browser join reads its one-time code
 * from the Company's page (6, step 1), so a stand-in that reads every page as
 * empty can't join a browser at all. Only what fetch-browser.ts uses is here:
 * `on`, `onDocument` and `transform` of a whole response.
 */
import { HTMLRewriter as WasmRewriter, type DocumentHandlers, type ElementHandlers } from "html-rewriter-wasm";

export class NodeHTMLRewriter {
  readonly #elements: (readonly [string, ElementHandlers])[] = [];
  readonly #documents: DocumentHandlers[] = [];

  on(selector: string, handlers: ElementHandlers): this {
    this.#elements.push([selector, handlers]);
    return this;
  }

  onDocument(handlers: DocumentHandlers): this {
    this.#documents.push(handlers);
    return this;
  }

  transform(response: Response): Response {
    const elements = this.#elements;
    const documents = this.#documents;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const rewriter = new WasmRewriter((chunk) => controller.enqueue(chunk));
        for (const [selector, handlers] of elements) rewriter.on(selector, handlers);
        for (const handlers of documents) rewriter.onDocument(handlers);
        try {
          if (response.body) {
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await rewriter.write(value);
            }
          }
          await rewriter.end();
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          rewriter.free();
        }
      }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
