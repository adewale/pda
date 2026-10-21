import { exportJWK, generateKeyPair } from "jose";
import { memoryState } from "../../interop/impls/shared/cloudflare-workers";
import { memorySql } from "../../interop/impls/pda-agent/sqlite";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client";
import { readSigningKeys } from "../../src/poppy/keys";
import { CompanyLimiter } from "../../src/poppy/limiter";
import { clientMetadata } from "../../src/poppy/routes";
import { migrate } from "../../src/poppy/store";
import type { Card } from "../../src/poppy/wire";
import { MockCompany } from "../mock-company/index";
import { companyIdFromHost, hostsFor } from "../mock-company/types";

const ORIGIN = "https://agent.test";

// These histories vary protocol/account state, not key generation. One fresh
// deployment key set per test worker suffices; signature/rotation tests own the
// key variants. Reuse avoids generating two EC pairs for every history.
const deploymentKeys = await Promise.all(["m-current", "m-next"].map(async (kid) => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return { ...(await exportJWK(privateKey)), kid, alg: "ES256", use: "sig" };
}));
export async function world(config: Record<string, unknown>) {
  const limiters = new Map<string, CompanyLimiter>();
  const env = {
    PUBLIC_ORIGIN: ORIGIN,
    POPPY_CLIENT_NAME: "Model Agent",
    POPPY_LOGO_URI: `${ORIGIN}/logo.svg`,
    POPPY_SIGNING_JWKS: JSON.stringify(deploymentKeys),
    TOKEN_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    CompanyLimiter: {
      getByName(name: string) {
        let limiter = limiters.get(name);
        if (!limiter) limiters.set(name, (limiter = new CompanyLimiter(memoryState(name) as never, {} as Env)));
        return limiter;
      }
    }
  } as unknown as Env;

  const id = `m${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const mock = new MockCompany(memoryState(id) as never, env);
  await mock.configure({ deviceInterval: 1, ...config });
  await mock.serveClientDocument(`${ORIGIN}/poppy/client.json`, clientMetadata(env));
  await mock.serveClientDocument(`${ORIGIN}/poppy/jwks.json`, { keys: (await readSigningKeys(env)).map((key) => key.publicJwk) });

  const createClient = async () => {
    const sql = memorySql();
    migrate(sql);
    const cards = new Map<string, Card>();
    const notices: Array<{ text: string; operationId: string }> = [];
    const jobs = new Map<string, Parameters<PoppyHost["schedule"]>>();
    const host: PoppyHost = {
      env,
      sql,
      fetcher: async (request) =>
        companyIdFromHost(new URL(request.url).host) === id ? mock.fetch(request) : new Response("No network here", { status: 502 }),
      showCard: async (card) => void cards.set(card.id, card),
      notifyModel: async (text, operationId) => { notices.push({ text, operationId }); },
      schedule: async (...args) => { jobs.set(args[3], args); },
      hasJob: (id) => jobs.has(id),
      pushDirect: () => undefined,
      userContext: () => ({ locale: "en-GB", time_zone: "Europe/London", user_available: true }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now()
    };
    const client = new PoppyClient(host);
    const company = await client.company(hostsFor(id).domain);
    return { client, company, cards, sql, notices, jobs };
  };
  return { ...await createClient(), mock, createClient, hosts: hostsFor(id) };
}
