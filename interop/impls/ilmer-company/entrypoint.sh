#!/bin/sh
# Trust the run's private CA (spec section 3), then run the adapter, which starts
# `wrangler dev` itself and restarts it with empty state on POST /reset.
set -e
if [ -f /interop/ca.pem ]; then
  cp /interop/ca.pem /usr/local/share/ca-certificates/interop-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
  export NODE_EXTRA_CA_CERTS=/interop/ca.pem
  export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
fi
exec node /interop-adapter/adapter.mjs
