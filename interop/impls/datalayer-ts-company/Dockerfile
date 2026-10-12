# Datalayer's TypeScript Company (Manzanita) behind the interop adapter (docs/interop-spec.md 5.3).
# Upstream is fetched at a pinned commit; nothing upstream is vendored in this repository.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM=https://github.com/datalayer/personal-agent-protocol
ARG COMMIT=0c048aa7fef8d98bbc23de5474220b6e7206384a

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

# The one relaxation (see README): *.interop.test names may resolve to private addresses
# when the Company fetches client metadata. Off when unset.
ENV INTEROP_ALLOW_TEST_HOSTS=1
EXPOSE 8080 8081
CMD ["node", "/upstream/interop/adapter.mjs"]
