import { describe, expect, it } from "vitest";
import { excludedTasks } from "../../src/poppy/coverage";
import type { PoppyClient } from "../../src/poppy/client";
import type { Company } from "../../src/poppy/discovery";
import { toIssuer } from "../../src/poppy/issuer";

const company = (name: string): Company => ({
  issuer: toIssuer(`https://auth.${name}.example`), domain: `${name}.example`, name, protocolVersion: "0.3",
  endpoints: { token: `https://auth.${name}.example/token`, revocation: `https://auth.${name}.example/revoke` },
  signIn: {}, customScopes: {}, extensions: {},
  apis: [{ type: "openapi", url: `https://api.${name}.example/openapi.json`, description: "Account API" }],
  excludedTasks: { url: "https://platform.example/excluded-tasks.json" }
});

describe("shared excluded-task document", () => {
  it("filters cached references against each Company's own services", async () => {
    let requests = 0;
    const references = ["alpha", "beta"].flatMap(name => [
      { type: "openapi", url: `https://api.${name}.example/openapi.json`, operation_id: "closeAccount" },
      { type: "web", url: `https://${name}.example/close` }
    ]);
    const client = { host: { fetcher: async () => {
      requests++;
      return Response.json({ tasks: [{ task: "Close an account", alternative: { references } }] }, { headers: { "Cache-Control": "max-age=600" } });
    } } } as unknown as PoppyClient;
    const alpha = company("alpha"), beta = company("beta");
    const a = await excludedTasks(client, alpha);
    const b = await excludedTasks(client, beta);
    expect(a).toEqual([{ task: "Close an account", alternative: { references: references.slice(0, 2) } }]);
    expect(b).toEqual([{ task: "Close an account", alternative: { references: references.slice(2) } }]);
    expect(await excludedTasks(client, alpha)).toEqual(a);
    expect(requests).toBe(1);
    // The cached raw document must also respect changed service declarations.
    expect(await excludedTasks(client, { ...alpha, apis: [] })).toEqual([{ task: "Close an account", alternative: { references: [references[1]] } }]);
    expect(requests).toBe(1);
  });
});
