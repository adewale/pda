# Our strict mock Company (test/mock-company) behind the interop hooks API.
# Built with the repository root as context (registry.json "context": ".").
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /repo
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --no-save --no-package-lock --no-audit --no-fund esbuild@0.28.2 jose@6.2.12
COPY src ./src
COPY test/mock-company ./test/mock-company
COPY interop/impls ./interop/impls
RUN node interop/impls/shared/build.mjs interop/impls/pda-mock/adapter.ts /out/adapter.mjs

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
COPY --from=build /out /app
EXPOSE 8080 8081
CMD ["node", "/app/adapter.mjs"]
