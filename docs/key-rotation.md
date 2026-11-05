# Key rotation and recovery

Use an isolated deployment to rehearse these steps. Keep secrets in the operator's private store or pipe them directly to `wrangler secret put`; do not put values in Git, command arguments, evidence or chat. Record only the deployed commit, Worker version, public key IDs and outcomes.

## Poppy signing keys

`POPPY_SIGNING_JWKS` is an ordered array: its first key signs and every public half is published. Give each new key a new `kid`.

1. Generate a new key with `node scripts/poppy-secrets.mjs signing-keys` into the private store. Preserve the current array.
2. Publish an array with the existing signer first and the new key after it. Verify `/poppy/jwks.json` includes both public keys and no private `d` member. Wait at least its advertised cache lifetime (currently one hour), and longer if a peer documents a longer cache.
3. Put the new key first, retaining the old public keys by retaining their private entries in the secret. Verify a fresh request at an authorized sandbox uses the new `kid` and is accepted. Check a fresh agent instance as well as an already active one: memory-only delegations may outlive the switch.
4. Keep the old key published until the last delegation it signed has expired, plus verifier clock tolerance and the peer's cache lifetime. See `DELEGATION_HOURS` in `src/poppy/jwt.ts`; do not guess from a deployment's age. Then remove it and verify the sandbox again.

If the signer is compromised, replace it and remove the compromised key immediately; the overlap procedure is inappropriate. Cached keys can continue verifying old signatures, so contact affected peer operators privately and arrange invalidation of outstanding delegations/Sessions. Do not claim that removing a JWKS entry instantly revokes every cached signature.

## Stored-token encryption

Back up `TOKEN_ENC_KEY` before changing it. Losing it loses sealed Company refresh tokens, pending sign-in secrets and model keys.

1. Set `TOKEN_ENC_KEY_PREVIOUS` to the existing key, then set `TOKEN_ENC_KEY` to a newly generated token key. Keep the previous key in the private store.
2. Verify a pre-existing Company account and own-model key still open, and new values use the current key. Values migrate lazily when read; inactive agents and pending revocations may still require the previous key.
3. Retire the previous key only after an inventory/migration establishes that no retained value needs it. The application has no whole-deployment bulk reseal command. Do not remove it merely because several days have elapsed.

For compromise, prefer revoking Company grants and provider keys, then asking people to reconnect under new encryption keys. Re-encrypting a previously stolen credential does not revoke the stolen copy.

## Other secrets

- Replacing `SESSION_SECRET` invalidates every browser login. Verify old cookies fail and a new Google/GitHub login works; do not restore a compromised session secret to ease rollback.
- Replacing `WEB_PUSH_VAPID_JWK` requires devices to subscribe again. Test delivery on each supported device after replacement.
- `POPPY_OPERATOR_KEY` publishes one operator key rather than an overlapping key set. Coordinate rotation with the verifying edge and its directory cache; verify the directory possession proof and a signed sandbox request. See [setup](setup.md).

Deploy configuration changes through the normal checked build. If a rotation fails, retain unknown-outcome action receipts and revocation work; do not reset an agent or roll its task ledger back to make a key change appear successful.
