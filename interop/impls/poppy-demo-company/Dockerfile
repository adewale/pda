# poppy-demo's Company ("Northstar", workers/receiver) under wrangler dev, plus the spec 5.3 adapter.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM=https://github.com/irvinebroque/poppy-demo.git
ARG COMMIT=02a9b304e92fdfee465c57f2822742eecac8bdc8
WORKDIR /app
RUN git clone --quiet "$UPSTREAM" . && git checkout --quiet "$COMMIT"

COPY patches /interop/patches
RUN git apply --verbose /interop/patches/*.patch
RUN npm ci --no-audit --no-fund --loglevel=error

COPY wrangler.interop.jsonc /app/workers/receiver/wrangler.interop.jsonc
COPY adapter.mjs entrypoint.sh /interop/

ENV WRANGLER_SEND_METRICS=false \
    COMPANY_HOST=poppy-demo.company.interop.test \
    AGENT_HOST=poppy-demo.agent.interop.test \
    INTEROP_PEER_SUFFIX=.agent.interop.test \
    INTEROP_COMMIT=02a9b30
EXPOSE 8080 8081
CMD ["bash", "/interop/entrypoint.sh"]
