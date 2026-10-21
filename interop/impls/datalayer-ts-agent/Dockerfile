# Datalayer's TypeScript Personal Agent SDK behind the interop adapter (docs/interop-spec.md 5.2).
# Upstream is fetched at a pinned commit; nothing upstream is vendored in this repository.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM=https://github.com/datalayer/personal-agent-protocol
ARG COMMIT=00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65

WORKDIR /upstream
RUN --mount=type=secret,id=proxy_ca --mount=type=secret,id=system_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    if [ -f /run/secrets/system_ca ]; then export GIT_SSL_CAINFO=/run/secrets/system_ca PIP_CERT=/run/secrets/system_ca; fi; \
    git init -q . \
 && git remote add origin "$UPSTREAM" \
 && git fetch -q --depth 1 origin "$COMMIT" \
 && git checkout -q FETCH_HEAD

# Interop-only changes, if any (none are needed at this commit).
COPY patches/ /patches/
RUN --mount=type=secret,id=proxy_ca --mount=type=secret,id=system_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    if [ -f /run/secrets/system_ca ]; then export GIT_SSL_CAINFO=/run/secrets/system_ca PIP_CERT=/run/secrets/system_ca; fi; \
    for p in /patches/*.patch; do [ -e "$p" ] || continue; git apply "$p"; done

# Upstream has no lockfile at this commit, so dependency versions float within package.json ranges.
RUN --mount=type=secret,id=proxy_ca --mount=type=secret,id=system_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    if [ -f /run/secrets/system_ca ]; then export GIT_SSL_CAINFO=/run/secrets/system_ca PIP_CERT=/run/secrets/system_ca; fi; \
    npm install --no-audit --no-fund --ignore-scripts && npm run build

COPY adapter.mjs /upstream/interop/adapter.mjs

EXPOSE 8080 8081
CMD ["node", "/upstream/interop/adapter.mjs"]
