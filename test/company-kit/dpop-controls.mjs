/** Independent wire controls use the upstream kit's signer, never PDA's JWT implementation. */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function dpopControls({ kit, directory, target, fetcher }) {
  const { loadIdentity } = await import(pathToFileURL(path.join(kit, "validate/identity.ts")));
  const { generateKey, nowSeconds, randomId, signJwt } = await import(pathToFileURL(path.join(kit, "validate/jose.ts")));
  const identity = await loadIdentity(directory);
  assert.ok(!("missing" in identity), "The upstream test identity must exist");
  const resource = await (await fetcher(`${target}/.well-known/oauth-protected-resource`)).json();
  const issuer = new URL(resource.authorization_servers[0]);
  const metadata = await (await fetcher(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`)).json();
  assert.ok(metadata.dpop_signing_alg_values_supported.includes("ES256"));
  const endpoint = metadata.token_endpoint;
  const key = await generateKey();
  const stranger = await generateKey();
  const results = [];
  let nonce;
  for (const mutation of ["valid", "missing", "signature", "method", "url", "valid-after-denials"]) {
    let response;
    let body;
    for (let attempt = 0; attempt < 2; attempt++) {
      const iat = nowSeconds();
      const assertion = await signJwt({ alg: "ES256", typ: "JWT", kid: identity.rootKey.publicJwk.kid }, {
        iss: identity.clientId, sub: identity.clientId, aud: metadata.issuer, iat, exp: iat + 60, jti: randomId(16)
      }, identity.rootKey.privateKey);
      const proof = await signJwt({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk }, {
        jti: randomId(16), iat, htm: mutation === "method" ? "GET" : "POST", htu: mutation === "url" ? `${endpoint}/other` : endpoint, ...(nonce ? { nonce } : {})
      }, mutation === "signature" ? stranger.privateKey : key.privateKey);
      response = await fetcher(endpoint, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(mutation === "missing" ? {} : { DPoP: proof }) },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: `rt_control_${randomId(16)}`, client_id: identity.clientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion })
      });
      body = await response.json();
      if (body.error !== "use_dpop_nonce") break;
      nonce = response.headers.get("DPoP-Nonce");
      assert.ok(nonce, "A DPoP nonce challenge must supply its nonce");
    }
    const expected = mutation.startsWith("valid") ? "invalid_grant" : "invalid_dpop_proof";
    assert.equal(response.status, 400, `DPoP ${mutation} control status`);
    assert.equal(body.error, expected, `DPoP ${mutation} control must reach its intended validation`);
    results.push({ mutation, status: response.status, error: body.error });
  }
  return results;
}
