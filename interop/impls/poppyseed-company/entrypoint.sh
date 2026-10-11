#!/bin/sh
# Trust the run's private CA (spec section 3), then run the adapter, which starts
# and restarts the Company itself (POST /reset restarts it with an empty store).
set -e
if [ -f /interop/ca.pem ]; then
  cp /interop/ca.pem /usr/local/share/ca-certificates/interop-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
  export NODE_EXTRA_CA_CERTS=/interop/ca.pem
  export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
fi
# poppyseed's fixture app reads these at startup. The secret seals tokens; any
# per-run value of 32+ characters works.
export POPPYSEED_TEST_HOOKS=1
export POPPYSEED_INTEROP_HOOKS=1
export POPPYSEED_SECRET="${POPPYSEED_SECRET:-interop-only-secret-interop-only-secret-0}"
exec node /interop-adapter/adapter.mjs
