# poppyseed's reference Company (fixtures/next-app: the reference company served
# through poppyseed/next), with its own test hooks on, behind a spec 5.3 adapter.
# Upstream: https://github.com/akshay5995/poppyseed (MIT). Nothing upstream is vendored.
FROM node:22-bookworm-slim

ARG POPPYSEED_COMMIT=f479fb6bd1754b9639440515f259e01936b0a18a
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /opt/poppyseed
RUN git clone https://github.com/akshay5995/poppyseed.git . \
 && git checkout --detach "$POPPYSEED_COMMIT"

# Only the fixture app and its workspace dependencies (poppyseed, poppyseed-reference),
# not the marketing site or the video.
RUN pnpm install --frozen-lockfile --filter "poppyseed-fixture-next-app..." \
 && pnpm --filter poppyseed-fixture-next-app build

COPY adapter.mjs entrypoint.sh /interop-adapter/
RUN chmod +x /interop-adapter/entrypoint.sh

# The proxy reaches the Company on 8080; the runner reaches the adapter on 8081.
ENV PORT=8080 \
    ADAPTER_PORT=8081 \
    POPPYSEED_BASE_URL=https://poppyseed.company.interop.test
EXPOSE 8080 8081
ENTRYPOINT ["/interop-adapter/entrypoint.sh"]
