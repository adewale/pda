# print-with-poppy (spenciefy/print-with-poppy), an agent-first photo-print store, in its
# demo mode, behind a spec 5.3 adapter. Poppy 0.3 (the 28 October text) since b340741.
# Upstream: https://github.com/spenciefy/print-with-poppy (MIT). Nothing upstream
# is vendored: it is cloned at the pinned commit when the image is built.
# Nothing goes in /interop: the runner copies its CA there before the container starts.

# Build from the same small base as the runtime. Keep installation, cloning and npm ci
# in one layer: VFS builders otherwise retain a full copy of the compiler at every step.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build

ARG UPSTREAM=https://github.com/spenciefy/print-with-poppy.git
ARG COMMIT=b340741d696d867ff3190c10c1f1d1e0c368e846
WORKDIR /opt/pwp
# Managed builds provide their combined system trust bundle as a secret. Ordinary builds
# bootstrap verified HTTPS from the base's trust store, or Node's bundled public roots.
# Neither the session certificate nor the build tools remain in this layer.
RUN --mount=type=secret,id=system_ca,mode=0444 \
    --mount=type=secret,id=proxy_ca,mode=0444 \
    set -eu; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g; s|http://security.debian.org|https://security.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
    if [ -f /run/secrets/system_ca ]; then \
      build_ca=/run/secrets/system_ca; \
    else \
      build_ca=/tmp/build-ca.pem; \
      if [ -f /etc/ssl/certs/ca-certificates.crt ]; then \
        cat /etc/ssl/certs/ca-certificates.crt > "$build_ca"; \
      else \
        node -e 'require("node:fs").writeFileSync(process.argv[1], require("node:tls").rootCertificates.join("\n") + "\n")' "$build_ca"; \
      fi; \
      if [ -f /run/secrets/proxy_ca ]; then cat /run/secrets/proxy_ca >> "$build_ca"; fi; \
    fi; \
    apt-get -o Acquire::https::CaInfo="$build_ca" -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true update; \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::https::CaInfo="$build_ca" -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true install -y --no-install-recommends ca-certificates git python3 make g++; \
    export GIT_SSL_CAINFO="$build_ca" NODE_EXTRA_CA_CERTS="$build_ca"; \
    git clone --quiet "$UPSTREAM" .; \
    git checkout --quiet --detach "$COMMIT"; \
    npm ci --omit=dev --no-audit --no-fund --loglevel=error; \
    apt-get purge -y --auto-remove git python3 make g++; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /root/.npm /tmp/build-ca.pem

# Run: the server, its runtime dependencies and the adapter; no compiler, no git.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

WORKDIR /opt/pwp
COPY --from=build /opt/pwp/package.json /opt/pwp/package-lock.json ./
COPY --from=build /opt/pwp/node_modules ./node_modules
COPY --from=build /opt/pwp/server ./server
COPY --from=build /opt/pwp/src/offer.ts /opt/pwp/src/ordering-method.ts ./src/
RUN install -d -m 0755 /interop-adapter /data && chown node:node /data
COPY --chmod=0644 adapter.mjs /interop-adapter/adapter.mjs

# The proxy reaches the store on 8080; the runner reaches the adapter on 8081. The public origin
# comes from INTEROP_ORIGIN (default https://print-with-poppy.company.interop.test). Node trusts
# the run's CA through NODE_EXTRA_CA_CERTS, which the runner sets; the adapter passes it on.
ENV PORT=8080 \
    ADAPTER_PORT=8081 \
    INTEROP_COMMIT=b340741d696d867ff3190c10c1f1d1e0c368e846
USER node
EXPOSE 8080 8081
CMD ["node", "/interop-adapter/adapter.mjs"]
