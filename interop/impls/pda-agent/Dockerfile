# Our Personal Agent's Poppy client (src/poppy) behind the interop control API.
# Built with the repository root as context (registry.json "context": ".").
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /repo
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --no-save --no-package-lock --no-audit --no-fund esbuild@0.28.2 jose@6.2.12 @cfworker/json-schema@4.1.1 html-rewriter-wasm@0.4.1
COPY src ./src
COPY test/mock-company ./test/mock-company
COPY interop/impls ./interop/impls
# The strict fake agent runs the runner's own Company-side checks (profiles.ts).
COPY interop/runner ./interop/runner
RUN node interop/impls/shared/build.mjs interop/impls/pda-agent/adapter.ts /out/adapter.mjs

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
COPY --from=build /out /app
# Node's HTMLRewriter (interop/impls/pda-agent/html-rewriter.ts), with its .wasm, beside the bundle.
COPY --from=build /repo/node_modules/html-rewriter-wasm /app/node_modules/html-rewriter-wasm
EXPOSE 8080 8081
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/adapter.mjs"]
