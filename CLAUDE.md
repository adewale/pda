# Durable Personal Agent

The design is `durable-personal-agent-spec.md`; read it before changing anything. v0 (milestone 1) is what is built, with the spec's Option B sign-in (Google and GitHub OAuth in the Worker) instead of Cloudflare Access: one Worker, one `PersonalAgent` Durable Object per signed-in identity running Pi through `PiHarness`, Claude Opus 5.5 through AI Gateway. The Poppy (Personal Agent Protocol) client is specified but not built yet; Appendix A of the spec lists every requirement it must meet.

- `src/protocol.ts`, `src/sockets.ts`, `src/view.ts` and `src/transcript.ts` are copied unchanged from Cloudflare's Pi example (`cloudflare/agents`, `examples/next/harnesses/pi`, commit `48d9c36`). Do not edit them; re-sync them from upstream instead.
- Our code: `src/index.ts` (Worker routes), `src/oauth.ts` (Google and GitHub sign-in), `src/session.ts` (signed session cookie, agent naming), `src/config.ts` (vars and secrets, no defaults), `src/agent.ts` (the Durable Object). The UI is the example's, adapted in `src/client.tsx` and `src/use-pi-session.ts`.
- No auth bypass anywhere, including tests and local dev.

Commands:

- Tests: `npm test` (Vitest in the Workers runtime; the model is pi-ai's faux provider, and Google's and GitHub's OAuth endpoints are faked in `test/vitest.config.ts`)
- Types: `npm run typecheck`; regenerate `env.d.ts` with `npm run types` after changing `wrangler.jsonc`
- Deploy: `npm run deploy`
