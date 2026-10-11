# Datalayer's TypeScript Personal Agent SDK behind the interop adapter (docs/interop-spec.md 5.2).
# Upstream is fetched at a pinned commit; nothing upstream is vendored in this repository.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM=https://github.com/datalayer/personal-agent-protocol
ARG COMMIT=12d71877d477b93f3ee68ebdc542560ba85997b9

WORKDIR /upstream
RUN git init -q . \
 && git remote add origin "$UPSTREAM" \
 && git fetch -q --depth 1 origin "$COMMIT" \
 && git checkout -q FETCH_HEAD

# Interop-only changes, if any (none are needed at this commit).
COPY patches/ /patches/
RUN for p in /patches/*.patch; do [ -e "$p" ] || continue; git apply "$p"; done

# Upstream has no lockfile at this commit, so dependency versions float within package.json ranges.
RUN npm install --no-audit --no-fund --ignore-scripts && npm run build

COPY adapter.mjs /upstream/interop/adapter.mjs

EXPOSE 8080 8081
CMD ["node", "/upstream/interop/adapter.mjs"]
