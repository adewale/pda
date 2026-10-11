#!/bin/sh
# Trust the run's CA (docs/interop-spec.md section 3), then start the host app, which serves the
# Company on $PORT (8080) and the interop adapter on $ADAPTER_PORT (8081) from one process.
set -e
if [ -f /interop/ca.pem ]; then
  cp /interop/ca.pem /usr/local/share/ca-certificates/interop-run-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/interop/ca.pem}"
fi
cd /app
exec node server.mjs
