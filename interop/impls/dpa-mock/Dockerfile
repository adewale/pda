# Our strict mock Company (test/mock-company) behind the interop hooks API.
# Built with the repository root as context (registry.json "context": ".").
FROM node:24-slim AS build
WORKDIR /repo
RUN npm install --no-save --no-package-lock --no-audit --no-fund esbuild@0.28.2 jose@6.2.12
COPY src ./src
COPY test/mock-company ./test/mock-company
COPY interop/impls ./interop/impls
RUN node interop/impls/shared/build.mjs interop/impls/dpa-mock/adapter.ts /out/adapter.mjs

FROM node:24-slim
COPY --from=build /out /app
EXPOSE 8080 8081
CMD ["node", "/app/adapter.mjs"]
