# adonis-agora Personal Agent: the framework-agnostic Poppy client of @adonis-agora/agent
# (packages/adonis/src/poppy-client), built from source at the pinned commit and driven by the
# interop adapter. No model: the adapter calls the library's protocol functions directly.
FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS build
ARG AGENT_COMMIT=e66a2329d436f603dd7c57a0ca81b36e65bd486f
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /upstream
RUN git init -q agent && git -C agent fetch -q --depth 1 https://github.com/DavideCarvalho/adonis-agora-agent.git "$AGENT_COMMIT" \
  && git -C agent checkout -q FETCH_HEAD
WORKDIR /app
# The client's only runtime dependencies, at the versions packages/adonis/package.json pins.
RUN node -e "const d=require('/upstream/agent/packages/adonis/package.json').dependencies;\
require('fs').writeFileSync('package.json',JSON.stringify({private:true,type:'module',dependencies:{jose:d.jose,'@modelcontextprotocol/sdk':d['@modelcontextprotocol/sdk']}},null,2))" \
  && npm install --no-audit --no-fund --omit=dev && npm install --no-save --no-audit --no-fund esbuild@0.28.2
# One ESM file from the library's TypeScript source, its dependencies left external.
RUN npx esbuild /upstream/agent/packages/adonis/src/poppy-client/index.ts --bundle --platform=node \
  --format=esm --target=node22 --external:jose --external:@modelcontextprotocol/sdk \
  --outfile=/app/poppy-client.mjs && rm -rf node_modules/esbuild node_modules/@esbuild

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/poppy-client.mjs ./
COPY --from=build /upstream/agent/LICENSE /licenses/adonis-agora-agent.LICENSE
COPY app/adapter.mjs ./
COPY entrypoint.sh /interop-adapter/
# No /interop directory in the image: the runner copies the run CA to /interop (docs/interop-spec.md 3).
RUN chmod +x /interop-adapter/entrypoint.sh
ENV AGENT_ORIGIN=https://adonis-agora.agent.interop.test PORT=8080 ADAPTER_PORT=8081
EXPOSE 8080 8081
ENTRYPOINT ["/interop-adapter/entrypoint.sh"]
