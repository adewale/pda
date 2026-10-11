# The recording proxy: Node only, no dependencies.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY routing.mjs proxy.mjs ./
EXPOSE 443 8082
CMD ["node", "/app/proxy.mjs"]
