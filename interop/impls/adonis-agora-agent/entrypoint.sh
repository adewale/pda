#!/bin/sh
# Trust the run's CA (docs/interop-spec.md section 3), then start the adapter, which serves the
# agent's client metadata, JWKS and redirect target on $PORT (8080) and the control API on
# $ADAPTER_PORT (8081).
set -e
if [ -f /interop/ca.pem ]; then
  cp /interop/ca.pem /usr/local/share/ca-certificates/interop-run-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/interop/ca.pem}"
fi
cd /app
exec node adapter.mjs
