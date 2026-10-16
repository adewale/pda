# pi-poppy Personal Agent (github.com/richardanaya/pi-poppy, MIT) behind the interop adapter.
# Build context: this directory. Upstream is fetched at a pinned commit; nothing is vendored.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS source
ARG PI_POPPY_REPO=https://github.com/richardanaya/pi-poppy.git
ARG PI_POPPY_COMMIT=11ea10630180740f16ccd507b8f90f69870c7e32
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates patch \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --quiet "$PI_POPPY_REPO" /opt/pi-poppy \
 && git -C /opt/pi-poppy checkout --quiet --detach "$PI_POPPY_COMMIT" \
 && rm -rf /opt/pi-poppy/.git
COPY patches /patches
RUN cd /opt/pi-poppy && for p in /patches/*.patch; do patch -p1 --forward < "$p"; done

# pi-poppy's src/ imports only node: builtins, so no npm install is needed. Node 22.6+
# runs its .ts files with --experimental-strip-types, as its own test script does.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG PI_POPPY_COMMIT=11ea10630180740f16ccd507b8f90f69870c7e32
COPY --from=source /opt/pi-poppy /opt/pi-poppy
RUN install -d -m 0755 /opt/adapter
COPY --chmod=0644 adapter.ts /opt/adapter/adapter.ts
ENV PI_POPPY_DIR=/opt/pi-poppy \
    PI_POPPY_COMMIT=$PI_POPPY_COMMIT \
    PI_POPPY_INTEROP_PRIVATE_SUFFIX=.interop.test \
    INTEROP_NAME=pi-poppy
EXPOSE 8080 8081
USER node
CMD ["node", "--experimental-strip-types", "--no-warnings", "/opt/adapter/adapter.ts"]
