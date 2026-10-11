# Our Personal Agent's Poppy client (src/poppy) behind the interop control API.
# Built with the repository root as context (registry.json "context": ".").
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /repo
RUN npm install --no-save --no-package-lock --no-audit --no-fund esbuild@0.28.2 jose@6.2.12
COPY src ./src
COPY test/mock-company ./test/mock-company
COPY interop/impls ./interop/impls
RUN node interop/impls/shared/build.mjs interop/impls/dpa-agent/adapter.ts /out/adapter.mjs

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
COPY --from=build /out /app
EXPOSE 8080 8081
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/adapter.mjs"]
