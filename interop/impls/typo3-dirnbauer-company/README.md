# TYPO3 Poppy extension (dirnbauer): live lane only

The extension's source is private, so there's no image to build and nothing for the local lane. It isn't in [`registry.json`](../../registry.json) yet, because spec section 2 needs either a `build` or a `url`, plus a pinned `commit`, and we have neither.

What its public docs say (read 11 October 2026; we sent it no requests):

- The lab deployment sits behind HTTP Basic auth, with the Poppy protocol paths exempt.
- Its allowed-clients list starts empty. Until the operator adds our `client_id`, every token request from our agent gets `invalid_client`.
- Its `auth.issuer` has a path (`https://<host>/poppy`), so it's the one known Company where reading S3 matters: RFC 8414 insertion (`/.well-known/oauth-authorization-server/poppy`) and the append form (`/poppy/.well-known/oauth-authorization-server`) give different URLs.
- It rejects `scope` on a jwt-bearer grant with `invalid_scope` (see [docs/poppy-issues.md](../../../docs/poppy-issues.md)).

To join the live lane: the operator publishes a URL, allowlists `https://<our agent host>/…` and tells us the deployed version. Then add a registry entry with `url` and that version as `commit`. Only signed-out scenarios (`D`, `S0`, and `C` if signed-out conversations are allowed), at most one request a second.
