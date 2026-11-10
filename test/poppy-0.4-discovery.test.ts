import { describe, expect, it } from "vitest";
import { discover, DiscoveryError, isCompany, protocolEndpoint, tokenHostAllowed, type Company } from "../src/poppy/discovery";

/**
 * Discovery under the 0.4 draft (F1 in docs/poppy-0.4-upgrade.md): the
 * version the agent chooses from poppy.json and `supported_versions` (3.4),
 * and what it reads from a 0.4 document (3.3, 6, 9). Until P1 the agent
 * speaks 0.3 alone, so tests that read 0.4 pass the versions explicitly.
 */

const ISSUER = "https://auth.shop.test";
const BOTH = ["0.3", "0.4"];

const auth = { scopes: { "orders:read": "See your orders", "poppy:browser-sign-in": "Use the website signed in" } };
const POPPY_03 = {
  protocol_version: "0.3",
  organization: { name: "Shop", domain: "shop.test" },
  auth,
  agent: { protocols: [{ type: "poppy", endpoint: "https://api.shop.test/poppy/conversations" }] },
  web: { browser_session_endpoint: "https://shop.test/poppy/browser-session" },
  feedback: { endpoint: "https://api.shop.test/poppy/feedback" },
  excluded_tasks: { url: "https://shop.test/excluded.json" },
  extensions: { operations: { version: "2" } }
};
const POPPY_04 = {
  protocol_version: "0.4",
  supported_versions: { "0.3": "https://shop.test/poppy/0.3.json" },
  organization: { name: "Shop", domain: "shop.test" },
  auth,
  agent: { protocols: [{ type: "poppy", endpoint: "https://api.shop.test/poppy/conversations" }] },
  web: { browser_session_endpoint: "https://shop.test/poppy/browser-session", unscoped: true },
  tasks: { endpoint: "https://api.shop.test/poppy/tasks" },
  extensions: {
    operations: [{ version: "2" }, { version: "3", endpoint: "https://shop.test/poppy/operations" }],
    "mediated-sign-in": [{ version: "1", fields: [{ name: "email", label: "Email", secret: true }], scopes: ["orders:read"] }]
  }
};
const METADATA = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/oauth/token`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  authorization_response_iss_parameter_supported: true,
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token", "https://personalagentprotocol.org/grant/mediated-sign-in"],
  scopes_supported: ["orders:read", "poppy:browser-sign-in"],
  protected_resources: ["https://shop.test", "https://api.shop.test"]
};

/** A fetcher serving these documents at shop.test and its issuer, and 404 elsewhere. */
function serving(documents: { poppy: unknown; linked?: Record<string, unknown> }) {
  const served = new Map<string, unknown>([
    ["https://shop.test/.well-known/poppy.json", documents.poppy],
    ["https://shop.test/.well-known/oauth-protected-resource", { resource: "https://shop.test", authorization_servers: [ISSUER] }],
    [`${ISSUER}/.well-known/oauth-authorization-server`, METADATA],
    ...Object.entries(documents.linked ?? {})
  ]);
  const requests: string[] = [];
  const fetcher = async (request: Request) => {
    requests.push(request.url);
    const body = served.get(request.url);
    return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body);
  };
  return { fetcher, requests };
}

async function company(documents: Parameters<typeof serving>[0], versions?: readonly string[]): Promise<Company> {
  const { result } = await discover(serving(documents).fetcher, "shop.test", versions);
  if (!isCompany(result)) throw new Error("discovered as website only");
  return result;
}

describe("choosing a version (3.4)", () => {
  it("an agent that speaks 0.3 alone uses the 0.3 document a 0.4 poppy.json links", async () => {
    const { fetcher, requests } = serving({ poppy: POPPY_04, linked: { "https://shop.test/poppy/0.3.json": POPPY_03 } });
    const { result } = await discover(fetcher, "shop.test");
    expect(result).toMatchObject({ protocolVersion: "0.3", feedback: { endpoint: POPPY_03.feedback.endpoint }, excludedTasks: { url: POPPY_03.excluded_tasks.url }, extensions: { operations: true } });
    expect(result).not.toHaveProperty("tasks");
    expect(requests).toContain("https://shop.test/poppy/0.3.json");
  });

  it("an agent that speaks 0.4 uses it, without fetching the 0.3 document", async () => {
    const { fetcher, requests } = serving({ poppy: POPPY_04, linked: { "https://shop.test/poppy/0.3.json": POPPY_03 } });
    const { result } = await discover(fetcher, "shop.test", BOTH);
    expect(result).toMatchObject({ protocolVersion: "0.4", specificationRevision: "2026-11-10" });
    expect(requests).not.toContain("https://shop.test/poppy/0.3.json");
  });

  it("a 0.3 poppy.json that links 0.4 gives 0.4 to an agent that speaks it", async () => {
    const poppy = { ...POPPY_03, supported_versions: { "0.4": "https://shop.test/poppy/0.4.json" } };
    const { supported_versions: _linked, ...linked } = POPPY_04;
    expect(await company({ poppy, linked: { "https://shop.test/poppy/0.4.json": linked } }, BOTH)).toMatchObject({ protocolVersion: "0.4" });
    expect(await company({ poppy, linked: { "https://shop.test/poppy/0.4.json": linked } })).toMatchObject({ protocolVersion: "0.3" });
  });

  it("never falls back to a version the Company doesn't list", async () => {
    const { supported_versions: _linked, ...only04 } = POPPY_04;
    await expect(discover(serving({ poppy: only04 }).fetcher, "shop.test")).rejects.toBeInstanceOf(DiscoveryError);
    // The linked 0.3 document is missing: a 404 can't be used, so nothing is left to choose.
    await expect(discover(serving({ poppy: POPPY_04 }).fetcher, "shop.test")).rejects.toBeInstanceOf(DiscoveryError);
  });
});

describe("reading a 0.4 poppy.json", () => {
  it("reads the entry for each extension version it implements, the tasks endpoint, and web.unscoped", async () => {
    const found = await company({ poppy: POPPY_04 }, BOTH);
    expect(found.extensions).toEqual({ operations: true, operationsEndpoint: "https://shop.test/poppy/operations" });
    expect(found.signIn.mediated).toMatchObject({ scopes: ["orders:read"], fields: [{ name: "email", label: "Email", secret: true }] });
    expect(found.tasks).toEqual({ endpoint: "https://api.shop.test/poppy/tasks" });
    expect(found.web).toEqual({ browserSessionEndpoint: "https://shop.test/poppy/browser-session", unscoped: true });
  });

  it("ignores the members 0.4 moved to the tasks endpoint", async () => {
    const poppy = { ...POPPY_04, feedback: POPPY_03.feedback, excluded_tasks: POPPY_03.excluded_tasks };
    const found = await company({ poppy }, BOTH);
    expect(found).not.toHaveProperty("feedback");
    expect(found).not.toHaveProperty("excludedTasks");
  });

  it("skips an extension written as 0.3's single object, and one whose versions it doesn't implement", async () => {
    const poppy = { ...POPPY_04, extensions: { operations: { version: "3" }, "mediated-sign-in": [{ version: "2", fields: [], scopes: [] }] } };
    const found = await company({ poppy }, BOTH);
    expect(found.extensions).toEqual({});
    expect(found.signIn.mediated).toBeUndefined();
  });

  it("reads web.disabled", async () => {
    const poppy = { ...POPPY_04, web: { disabled: true }, extensions: {} };
    expect((await company({ poppy }, BOTH)).web).toEqual({ disabled: true });
  });

  it("keeps the model's API calls off the tasks and operations endpoints, which still receive Session JWTs", async () => {
    const found = await company({ poppy: { ...POPPY_04, tasks: { endpoint: "https://tasks.shop-cdn.test/poppy/tasks" } } }, BOTH);
    expect(protocolEndpoint(found, new URL("https://shop.test/poppy/operations/op_1"))).toBe("https://shop.test/poppy/operations");
    expect(protocolEndpoint(found, new URL("https://tasks.shop-cdn.test/poppy/tasks"))).toBe("https://tasks.shop-cdn.test/poppy/tasks");
    expect(tokenHostAllowed(found, new URL("https://tasks.shop-cdn.test/poppy/tasks"))).toBe(true);
  });
});
