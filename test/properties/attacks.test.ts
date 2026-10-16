/** The real interop replay generator against the real Company verifier, without sockets. */
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { runAttack } from "../../interop/impls/pda-agent/attacks";
import { assertTrace } from "../../interop/runner/traces";
import { recording, TOKEN, type Spec } from "../../interop/test/helpers";
import type { Company as DiscoveredCompany } from "../../src/poppy/discovery";
import { toIssuer } from "../../src/poppy/issuer";
import { clientMetadata } from "../../src/poppy/routes";
import { AuthServer } from "../mock-company/auth";
import { Company, HttpError } from "../mock-company/core";
import { DEFAULT_CONFIG } from "../mock-company/types";
import { violationId } from "../mock-company/violations";
import { gs, propertyAsync } from "./hegel";

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const signingJwks = JSON.stringify([{ ...await exportJWK(privateKey), kid: "attack-key", alg: "ES256", use: "sig" }]);
const jwks = { keys: [{ ...await exportJWK(publicKey), kid: "attack-key", alg: "ES256", use: "sig" }] };
const origin = "https://evil-agent.agent.interop.test";
const env = { PUBLIC_ORIGIN: origin, POPPY_CLIENT_NAME: "Replay test agent", POPPY_LOGO_URI: `${origin}/logo.svg`, POPPY_SIGNING_JWKS: signingJwks } as unknown as Env;

for (const [id, replay, error, violation] of [
  ["YR", "assertion", "invalid_grant", "session-assertion.jti-reused"],
  ["YD", "dpop", "invalid_dpop_proof", "dpop.jti-reused"],
  ["YA", "client_audience", "invalid_client", "client-assertion.aud"]
] as const) {
  describe(id, () => {
    it("reaches exactly the intended replay refusal under generated nonce and assertion readings", propertyAsync(async (tc) => {
      const core = new Company("acme", env);
      core.config = { ...DEFAULT_CONFIG,
        requireNonce: tc.draw(gs.booleans()), strictAssertions: tc.draw(gs.booleans()),
        nonceScope: tc.draw(gs.sampledFrom(["company", "origin"] as const)),
        clientAssertionAud: tc.draw(gs.sampledFrom(["lenient", "exact", "token-endpoint"] as const))
      };
      core.hosts = { ...core.hosts, domain: "acme.company.interop.test", issuer: "https://auth.acme.company.interop.test", tokenEndpoint: TOKEN };
      core.served.set(`${origin}/poppy/client.json`, { status: 200, body: JSON.stringify(clientMetadata(env)) });
      core.served.set(`${origin}/poppy/jwks.json`, { status: 200, body: JSON.stringify(jwks) });
      const auth = new AuthServer(core);
      const company: DiscoveredCompany = {
        issuer: toIssuer(core.hosts.issuer), domain: core.hosts.domain, name: "Acme", protocolVersion: "0.1",
        endpoints: { token: TOKEN, revocation: `${core.hosts.issuer}/oauth/revoke` }, signIn: {}, customScopes: {}, apis: [], extensions: {}
      };
      const records: Spec[] = [];
      const result = await runAttack({ clientId: `${origin}/poppy/client.json`, signingJwks,
        fetcher: async (request) => {
          const body = await request.text();
          let response: Response;
          try {
            response = await auth.token({ request, url: new URL(request.url), bodyText: body, bodyBytes: new TextEncoder().encode(body) });
          } catch (failure) {
            if (!(failure instanceof HttpError)) throw failure;
            response = failure.response;
          }
          records.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body,
            status: response.status, responseHeaders: Object.fromEntries(response.headers), response: await response.clone().json() });
          return response;
        }
      }, company, id, {});
      expect(result).toMatchObject({ status: id === "YA" ? 401 : 400, poppy_error: error });
      expect(core.recorded.map(violationId)).toEqual([violation]);
      const trace = recording(...records);
      const evidence = id === "YA" ? { mutation: replay } : { replay };
      expect(assertTrace(trace, { check: "attack_observed", ...evidence }).kind).toBe("ok");
      expect(assertTrace(trace, { check: id === "YA" ? "audience_rejected" : "replay_rejected", replay }).kind).toBe("ok");
    }));
  });
}
