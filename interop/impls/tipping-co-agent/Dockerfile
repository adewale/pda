# The Personal Agent of timothyohare/personal-agent-protocol (packages/agent and agent-host),
# behind the interop control adapter (docs/interop-spec.md 5.2).
# Upstream declares no licence, so nothing of it is kept in this repository: the build clones
# it at the pinned commit, and the image is built and run only on the grid's machine.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM=https://github.com/timothyohare/personal-agent-protocol.git
ARG COMMIT=fb7b4e64ad343d9406055a995f4beb06269c1ce6

WORKDIR /upstream
RUN git init -q . \
 && git fetch -q --depth 1 "$UPSTREAM" "$COMMIT" \
 && git checkout -q FETCH_HEAD \
 && rm -rf .git

# Upstream's lockfile; its workspace packages (agent, agent-host, poppy-core) resolve through node_modules
# symlinks, and Node 24 runs their TypeScript as upstream's own scripts do.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

COPY adapter.mjs /upstream/interop-adapter.mjs

# No /interop in the image: the runner copies its trust directory there (docs/interop-spec.md 3).
ENV PORT=8080 ADAPTER_PORT=8081 \
    INTEROP_COMMIT=fb7b4e64ad343d9406055a995f4beb06269c1ce6
EXPOSE 8080 8081
CMD ["node", "/upstream/interop-adapter.mjs"]
