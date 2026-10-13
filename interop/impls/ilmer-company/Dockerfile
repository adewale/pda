# Ilmer Past's signed-out Poppy Company (agent/ in rbirkby/Ilmer.org), under
# `wrangler dev`, behind a spec 5.3 adapter.
# Upstream: https://github.com/rbirkby/Ilmer.org (MIT). Nothing upstream is vendored.
FROM node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8

ARG ILMER_COMMIT=de0d1ec50f09906fedf26a83b7b88042ebfebd56
ARG WRANGLER_VERSION=4.149.0
ENV WRANGLER_SEND_METRICS=false \
    CI=1

WORKDIR /opt/ilmer
RUN git clone https://github.com/rbirkby/Ilmer.org.git . \
 && git checkout --detach "$ILMER_COMMIT"

WORKDIR /opt/ilmer/agent
# Upstream's lockfile; upstream runs through the cf CLI, so Wrangler is added beside it.
RUN npm ci --no-audit --no-fund \
 && npm install --no-save --no-audit --no-fund "wrangler@$WRANGLER_VERSION"

COPY wrangler.jsonc interop-main.js /opt/ilmer/agent/
COPY adapter.mjs entrypoint.sh /interop-adapter/
RUN chmod +x /interop-adapter/entrypoint.sh

# The public origin comes from INTEROP_ORIGIN (default https://ilmer.company.interop.test).
ENV PORT=8080 \
    ADAPTER_PORT=8081
EXPOSE 8080 8081
ENTRYPOINT ["/interop-adapter/entrypoint.sh"]
