import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { excludedTasks } from "../../src/poppy/coverage";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client";
import type { Company } from "../../src/poppy/discovery";
import { toIssuer } from "../../src/poppy/issuer";
import { migrate } from "../../src/poppy/store";
import { memorySql } from "../impls/pda-agent/sqlite";

const company = (name: string): Company => ({
  issuer: toIssuer(`https://auth.${name}.example`), domain: `${name}.example`, name, protocolVersion: "0.4",
  endpoints: { token: `https://auth.${name}.example/token`, revocation: `https://auth.${name}.example/revoke` },
  signIn: {}, customScopes: {}, extensions: {},
  apis: [{ type: "openapi", url: `https://api.${name}.example/openapi.json`, description: "Account API" }],
  tasks: { endpoint: `https://api.${name}.example/poppy/tasks` }
});

async function client(answer: () => Response): Promise<{ client: PoppyClient; requests: string[] }> {
  const sql = memorySql();
  migrate(sql);
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const requests: string[] = [];
  const host: PoppyHost = {
    env: {
      PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Tasks cache test", POPPY_LOGO_URI: "https://agent.example/logo.svg",
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"), POPPY_SIGNING_JWKS: JSON.stringify([{ ...await exportJWK(privateKey), kid: "tasks-cache-test", alg: "ES256", use: "sig" }]),
      CompanyLimiter: { getByName: () => ({ delay: async () => 0, observe: async () => {}, blockUntil: async () => {} }) }
    } as unknown as Env,
    sql,
    fetcher: async (request) => {
      requests.push(request.url);
      if (!new URL(request.url).pathname.endsWith("/poppy/tasks")) throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      return answer();
    },
    showCard: async () => {}, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false, pushDirect: () => {},
    userContext: () => ({ user_available: true }), sleep: async () => {}, now: Date.now
  };
  return { client: new PoppyClient(host), requests };
}

describe("tasks responses kept per Company and Session", () => {
  it("filters cached API references against each Company's own services on every read, keeping web links (9, 9.2)", async () => {
    const references = ["alpha", "beta"].flatMap(name => [
      { type: "openapi", url: `https://api.${name}.example/openapi.json`, operation_id: "closeAccount" },
      { type: "web", url: `https://${name}.example/close` }
    ]);
    // Both Companies answer with the same body, naming each other's API.
    const f = await client(() => Response.json({ excluded_tasks: [{ task: "Close an account", alternative: { references } }] }, { headers: { "Cache-Control": "max-age=600" } }));
    const alpha = company("alpha"), beta = company("beta");
    const a = await excludedTasks(f.client, alpha);
    const b = await excludedTasks(f.client, beta);
    // API references only to each Company's own listed APIs (9.2); web links on any HTTPS host, as links for the User.
    expect(a).toEqual([{ task: "Close an account", alternative: { references: [references[0], references[1], references[3]] } }]);
    expect(b).toEqual([{ task: "Close an account", alternative: { references: [references[1], references[2], references[3]] } }]);
    // One request per Company's Session, never shared between Companies.
    expect(f.requests).toEqual([alpha.tasks!.endpoint, beta.tasks!.endpoint]);
    expect(await excludedTasks(f.client, alpha)).toEqual(a);
    expect(f.requests).toHaveLength(2);
    // The cached response must also respect changed service declarations.
    expect(await excludedTasks(f.client, { ...alpha, apis: [] })).toEqual([{ task: "Close an account", alternative: { references: [references[1], references[3]] } }]);
    expect(f.requests).toHaveLength(2);
  });
});
