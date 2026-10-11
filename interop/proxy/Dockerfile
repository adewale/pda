# The recording proxy: Node only, no dependencies.
FROM node:24-alpine
WORKDIR /app
COPY routing.mjs proxy.mjs ./
EXPOSE 443 8082
CMD ["node", "/app/proxy.mjs"]
