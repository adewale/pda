# syntax=docker/dockerfile:1.7
# everruns as a Poppy Personal Agent behind the interop adapter.
# Spec: docs/interop-spec.md v1. Upstream is fetched at a pinned commit; nothing is vendored.
#   docker build -t interop/everruns-agent:dev interop/impls/everruns-agent
# The cargo caches are shared with interop/impls/everruns-company (same id), so the
# second image only builds its own test target.

ARG EVERRUNS_COMMIT=aceb2e2fcfdf9c91022e390ee5efe5a773043bb2

FROM rust:1.96-slim-bookworm@sha256:e18a79fc84dfcfc3ab5ba72290398a644c135c97eaa881447fddc354ee4701a3 AS build
ARG EVERRUNS_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates pkg-config clang lld cmake make perl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src/everruns
RUN git init -q . \
 && git remote add origin https://github.com/everruns/everruns.git \
 && git fetch -q --depth 1 origin "$EVERRUNS_COMMIT" \
 && git checkout -q FETCH_HEAD
COPY patches/ /interop-patches/
RUN for p in /interop-patches/*.patch; do git apply -v "$p"; done
# The adapter is an integration-test target of everruns-server, so it can use
# everruns' own in-process server assembly (crates/server/tests/test_harness.rs).
COPY adapter/main.rs crates/server/tests/interop_adapter/main.rs
# everruns-server is one very large crate; compiling it alongside others ran an
# 8 GB builder out of memory, so jobs default to 1 (raise on bigger machines).
ARG CARGO_BUILD_JOBS=1
ENV CARGO_TERM_COLOR=never CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=everruns-cargo-registry \
    --mount=type=cache,target=/usr/local/cargo/git,id=everruns-cargo-git \
    --mount=type=cache,target=/src/everruns/target,id=everruns-target,sharing=locked \
    cargo test -p everruns-server --test interop_adapter --no-run \
 && mkdir -p /out \
 && cp "$(find target/debug/deps -maxdepth 1 -type f -perm -u+x -name 'interop_adapter-*' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2)" /out/adapter \
 && strip /out/adapter

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
ARG EVERRUNS_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /opt/pg-cache
# Migrations are embedded at compile time; the directory is kept at its source
# path for the few code paths that read it from disk.
COPY --from=build /src/everruns/crates/server/migrations /src/everruns/crates/server/migrations
COPY --from=build /src/everruns/docs/api /src/everruns/docs/api
COPY --from=build /out/adapter /app/adapter
ENV EVERRUNS_COMMIT=$EVERRUNS_COMMIT \
    EVERRUNS_PG_CACHE=/opt/pg-cache \
    EVERRUNS_INTEROP_ALLOW_PRIVATE_NETWORKS=1 \
    RUST_LOG=warn
# Download the embedded PostgreSQL binaries now, not on the private test network.
RUN /app/adapter warm --ignored --exact --nocapture && chmod -R a+rX /opt/pg-cache
EXPOSE 8080 8081
HEALTHCHECK --interval=5s --timeout=3s --retries=24 CMD curl -fsS http://127.0.0.1:8081/healthz || exit 1
CMD ["/app/adapter", "serve", "--ignored", "--exact", "--nocapture", "--test-threads=1"]
