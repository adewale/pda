# poppy-demo's Personal Agent (workers/caller) under wrangler dev, plus the spec 5.2 adapter.
# The adapter drives CallerSession's protocol actions through the caller's own /api/action route,
# the one its UI buttons use; the Pi model and Workers AI are never involved.
# Nothing goes in /interop: the runner copies its CA there before the container starts.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM=https://github.com/irvinebroque/poppy-demo.git
ARG COMMIT=02a9b304e92fdfee465c57f2822742eecac8bdc8
WORKDIR /app
RUN git clone --quiet "$UPSTREAM" . && git checkout --quiet "$COMMIT"

COPY patches /interop-adapter/patches
RUN git apply --verbose /interop-adapter/patches/*.patch
RUN npm ci --no-audit --no-fund --loglevel=error

# The chat UI isn't needed; a placeholder satisfies the ASSETS binding.
RUN mkdir -p workers/caller/public && echo '<!doctype html><title>poppy-demo caller (interop)</title>' > workers/caller/public/index.html
COPY wrangler.interop.jsonc /app/workers/caller/wrangler.interop.jsonc
COPY adapter.mjs entrypoint.sh /interop-adapter/

# INTEROP_DOMAIN (set by the runner) overrides AGENT_HOST.
ENV WRANGLER_SEND_METRICS=false \
    AGENT_HOST=poppy-demo.agent.interop.test \
    INTEROP_COMMIT=02a9b304e92fdfee465c57f2822742eecac8bdc8
EXPOSE 8080 8081
CMD ["bash", "/interop-adapter/entrypoint.sh"]
