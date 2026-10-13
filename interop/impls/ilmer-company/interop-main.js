// Container-only entry point for Ilmer Past's Poppy Worker: upstream's module unchanged,
// with HistoryAgent given a stand-in Workers AI binding. Copied into the image beside
// upstream's src/ and named as `main` in the container's wrangler.jsonc; never in src/.
// Plain JavaScript, so this repository's typecheck (interop/**/*.ts) doesn't try to
// resolve upstream's modules; Wrangler bundles it with the TypeScript it imports.
//
// Since de0d1ec (12 Oct) HistoryAgent installs web_search and web_fetch tools built from
// env.AI directly, and webFetchTool throws at construction when the binding is undefined,
// so without a binding every conversation fails before the model is asked. The stand-in
// refuses every call, as upstream's own `offline` object does for the model, so each
// Company Agent reply is still Ilmer's fixed apology. Nothing leaves the container.
import { HistoryAgent as UpstreamHistoryAgent } from './src/agent';

export * from './src/index';
export { default } from './src/index';

const unavailable = () => Promise.reject(new Error('Workers AI is not available in the interop grid.'));
const offlineAI = {
  run: unavailable,
  websearch: unavailable,
  toMarkdown: unavailable,
  gateway: () => ({ run: unavailable })
};

export class HistoryAgent extends UpstreamHistoryAgent {
  constructor(ctx, env) {
    super(ctx, { ...env, AI: env.AI ?? offlineAI });
  }
}
