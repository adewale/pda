# Datalayer's Python reference Company (Manzanita) behind the interop hooks adapter.
# The upstream source is fetched at a pinned commit; nothing upstream is vendored here.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

ARG UPSTREAM=https://github.com/datalayer/personal-agent-protocol
ARG UPSTREAM_COMMIT=12d71877d477b93f3ee68ebdc542560ba85997b9

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --quiet "$UPSTREAM" /upstream \
 && git -C /upstream checkout --quiet "$UPSTREAM_COMMIT"

# Interop-only upstream patches (none needed at this commit; see README).
COPY patches/ /patches/
RUN for p in /patches/*.patch; do [ -e "$p" ] || continue; git -C /upstream apply "$p"; done

COPY constraints.txt /adapter/constraints.txt
RUN pip install --no-cache-dir -c /adapter/constraints.txt "/upstream[server]"

COPY adapter.py /adapter/adapter.py

# No /interop here: the runner copies its trust directory to /interop before start.
ENV UPSTREAM_COMMIT=$UPSTREAM_COMMIT \
    INTEROP_NAME=datalayer-py \
    INTEROP_ALLOW_TEST_HOSTS=1 \
    PYTHONUNBUFFERED=1
EXPOSE 8080 8081
CMD ["python", "-I", "/adapter/adapter.py"]
