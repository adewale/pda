# adonis-agora Company: @adonis-agora/authkit-server (Poppy authorization server) +
# @adonis-agora/agent (Poppy conversations), in a minimal AdonisJS host written for the grid.
#
# The packages are installed from npm at the versions their pinned commits released
# ("chore: version packages" commits); the build clones both repositories at those commits
# and fails unless each package.json names the version installed, so the image runs exactly
# the pinned source as its authors built it. Nothing upstream is vendored into this repository.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
ARG AUTHKIT_COMMIT=fe2a3ff453b469d759a9f9313be331f4324fa2bf
ARG AGENT_COMMIT=e139b9599e61db17f85fa186f4073f81ee6bc19b
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /upstream
RUN git init -q authkit && git -C authkit fetch -q --depth 1 https://github.com/DavideCarvalho/adonis-agora-authkit.git "$AUTHKIT_COMMIT" \
  && git -C authkit checkout -q FETCH_HEAD \
  && git init -q agent && git -C agent fetch -q --depth 1 https://github.com/DavideCarvalho/adonis-agora-agent.git "$AGENT_COMMIT" \
  && git -C agent checkout -q FETCH_HEAD
WORKDIR /app
COPY app/package.json ./
RUN node -e "const fs=require('fs');const want=require('./package.json').dependencies;\
const a=JSON.parse(fs.readFileSync('/upstream/authkit/packages/authkit-server/package.json'));\
const g=JSON.parse(fs.readFileSync('/upstream/agent/packages/adonis/package.json'));\
if(a.version!==want['@adonis-agora/authkit-server']||g.version!==want['@adonis-agora/agent']){console.error('version mismatch',a.version,g.version);process.exit(1)}\
console.log('authkit-server',a.version,'agent',g.version,'match the pinned commits')"
RUN npm install --legacy-peer-deps --no-audit --no-fund --omit=dev && npm ls --depth=0

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /upstream/authkit/LICENSE /licenses/adonis-agora-authkit.LICENSE
COPY --from=build /upstream/agent/LICENSE /licenses/adonis-agora-agent.LICENSE
COPY app/ ./
COPY entrypoint.sh /interop-adapter/
# No /interop directory in the image: the runner copies the run CA to /interop (docs/interop-spec.md 3).
RUN chmod +x /interop-adapter/entrypoint.sh && mkdir -p /data
ENV NODE_ENV=development INTEROP_ALLOW_PRIVATE_PEERS=1 \
    PUBLIC_ORIGIN=https://adonis-agora.company.interop.test \
    PORT=8080 HOST=0.0.0.0 ADAPTER_PORT=8081
EXPOSE 8080 8081
ENTRYPOINT ["/interop-adapter/entrypoint.sh"]
