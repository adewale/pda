# print-with-poppy (spenciefy/print-with-poppy), an agent-first photo-print store, in its
# demo mode, behind a spec 5.3 adapter.
# Upstream: https://github.com/spenciefy/print-with-poppy (no licence declared). Nothing upstream
# is vendored: it is cloned at the pinned commit when the image is built.
# Nothing goes in /interop: the runner copies its CA there before the container starts.

# Build: clone, patch, install the runtime dependencies. The compiler is there in case a native
# module (better-sqlite3, sharp) has no prebuilt binary for the platform, as upstream's image has it.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM=https://github.com/spenciefy/print-with-poppy.git
ARG COMMIT=7ef69bef9ca9e485386b28a679c532ed7cbee739
WORKDIR /opt/pwp
RUN git clone --quiet "$UPSTREAM" . && git checkout --quiet --detach "$COMMIT"

# Patch 0001: ALLOW_COMPAT_AGENT_SESSIONS=false turns the Bearer compatibility path off in demo
# mode too (upstream forces it on there). See README.md.
COPY patches /interop-patches
RUN git apply --verbose /interop-patches/*.patch

# Runtime dependencies only (upstream's lockfile). The adapter runs server/ with tsx, as upstream's
# `npm start` does; the browser frontend isn't built, since no Poppy endpoint serves it.
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error

# Run: the server, its runtime dependencies and the adapter; no compiler, no git.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

WORKDIR /opt/pwp
COPY --from=build /opt/pwp/package.json /opt/pwp/package-lock.json ./
COPY --from=build /opt/pwp/node_modules ./node_modules
COPY --from=build /opt/pwp/server ./server
COPY --from=build /opt/pwp/src/offer.ts ./src/offer.ts
COPY adapter.mjs /interop-adapter/adapter.mjs
RUN mkdir -p /data && chown node:node /data

# The proxy reaches the store on 8080; the runner reaches the adapter on 8081. The public origin
# comes from INTEROP_ORIGIN (default https://print-with-poppy.company.interop.test). Node trusts
# the run's CA through NODE_EXTRA_CA_CERTS, which the runner sets; the adapter passes it on.
ENV PORT=8080 \
    ADAPTER_PORT=8081 \
    INTEROP_COMMIT=7ef69bef9ca9e485386b28a679c532ed7cbee739
USER node
EXPOSE 8080 8081
CMD ["node", "/interop-adapter/adapter.mjs"]
