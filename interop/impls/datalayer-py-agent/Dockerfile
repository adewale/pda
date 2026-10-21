# Datalayer's Python Personal Agent SDK behind the interop control adapter.
# The upstream source is fetched at a pinned commit; nothing upstream is vendored here.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

ARG UPSTREAM=https://github.com/datalayer/personal-agent-protocol
ARG UPSTREAM_COMMIT=00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN --mount=type=secret,id=proxy_ca --mount=type=secret,id=system_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    if [ -f /run/secrets/system_ca ]; then export GIT_SSL_CAINFO=/run/secrets/system_ca PIP_CERT=/run/secrets/system_ca; fi; \
    git clone --quiet "$UPSTREAM" /upstream \
 && git -C /upstream checkout --quiet "$UPSTREAM_COMMIT"

# Interop-only upstream patches (none needed at this commit; see README).
COPY patches/ /patches/
RUN --mount=type=secret,id=proxy_ca --mount=type=secret,id=system_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    if [ -f /run/secrets/system_ca ]; then export GIT_SSL_CAINFO=/run/secrets/system_ca PIP_CERT=/run/secrets/system_ca; fi; \
    for p in /patches/*.patch; do [ -e "$p" ] || continue; git -C /upstream apply "$p"; done

COPY constraints.txt /adapter/constraints.txt
RUN --mount=type=secret,id=proxy_ca --mount=type=secret,id=system_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    if [ -f /run/secrets/system_ca ]; then export GIT_SSL_CAINFO=/run/secrets/system_ca PIP_CERT=/run/secrets/system_ca; fi; \
    pip install --no-cache-dir -c /adapter/constraints.txt "/upstream[server]"

COPY adapter.py /adapter/adapter.py

# No /interop here: the runner copies its trust directory to /interop before start.
ENV UPSTREAM_COMMIT=$UPSTREAM_COMMIT \
    INTEROP_NAME=datalayer-py \
    INTEROP_ALLOW_TEST_HOSTS=1 \
    PYTHONUNBUFFERED=1
EXPOSE 8080 8081
CMD ["python", "-I", "/adapter/adapter.py"]
