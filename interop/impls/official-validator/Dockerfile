# No upstream code is executed on the host. This image uses the verified snapshot.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /state
COPY spec /repo/spec
COPY interop/impls/shared/serve.ts /repo/interop/impls/shared/serve.ts
COPY interop/impls/official-validator/adapter.ts /repo/interop/impls/official-validator/adapter.ts
EXPOSE 8080 8081
CMD ["node", "/repo/interop/impls/official-validator/adapter.ts"]
