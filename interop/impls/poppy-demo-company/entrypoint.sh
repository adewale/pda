#!/bin/bash
# Trust the run's CA (spec section 3), then hand over to the adapter, which runs wrangler dev on 8080.
# Wrangler passes NODE_EXTRA_CA_CERTS on to workerd; the system store covers anything else.
set -euo pipefail
if [ -f /interop/ca.pem ]; then
  cp /interop/ca.pem /usr/local/share/ca-certificates/interop-ca.crt
  update-ca-certificates >/dev/null 2>&1
  export NODE_EXTRA_CA_CERTS=/interop/ca.pem
  export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
fi
exec node /interop-adapter/adapter.mjs
