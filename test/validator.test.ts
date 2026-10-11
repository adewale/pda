import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MESSAGES,
  validateClient,
  validateCompany,
  validateTarget,
  validateText,
  type DocumentKind,
  type Fetcher,
  type MessageId,
  type Report
} from "../src/validator/index.ts";
import { handleValidator } from "../src/validator/http.ts";
import type { MockCompany } from "./mock-company";
import worker, { testFetcher } from "./worker";

/**
 * The discovery-document validator. As with feed validators' test suites,
 * every message id must be produced by at least one fixture here, and the
 * last test checks that.
 */

const seen = new Set<MessageId>();
function record(report: Report): Report {
  for (const message of report.messages) seen.add(message.id);
  return report;
}
const ids = (report: Report) => report.messages.map((m) => m.id);

function text(kind: DocumentKind, doc: unknown, options: Parameters<typeof validateText>[2] = {}): Report {
  return record(validateText(kind, typeof doc === "string" ? doc : JSON.stringify(doc, null, 2), options));
}

/** A fake network: URL → response. Anything else fails like a DNS error. */
function network(routes: Record<string, () => Response>): Fetcher {
  return async (request) => {
    const route = routes[request.url];
    if (!route) throw new TypeError("fetch failed");
    return route();
  };
}
const jsonResponse = (body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300", ...headers }
  });

/** The example in spec section 3, verbatim. */
const SPEC_POPPY = {
  protocol_version: "0.1",
  organization: { name: "Example Company", domain: "example.com" },
  auth: {
    issuer: "https://auth.example.com",
    direct: { scopes: ["poppy:read", "poppy:write", "addresses"] },
    device: { scopes: ["poppy:read", "poppy:write"] },
    mediated: {
      endpoint: "https://auth.example.com/poppy/sign-in",
      fields: [
        { name: "email", label: "Email", secret: false },
        { name: "password", label: "Password", secret: true }
      ],
      scopes: ["poppy:read"]
    },
    custom_scopes: { addresses: "Manage saved shipping addresses" }
  },
  agent: { protocols: [{ type: "poppy", endpoint: "https://api.example.com/poppy/conversations" }] },
  web: { browser_session_endpoint: "https://example.com/poppy/browser-session" },
  apis: [
    { type: "openapi", url: "https://api.example.com/openapi.json", description: "Orders, returns, and exchanges" },
    { type: "mcp", url: "https://mcp.example.com/mcp", description: "Product search and sizing" }
  ]
};

/** The OAuth server metadata example in spec 3.2, verbatim. */
const SPEC_METADATA = {
  issuer: "https://auth.example.com",
  token_endpoint: "https://auth.example.com/oauth/token",
  revocation_endpoint: "https://auth.example.com/oauth/revoke",
  authorization_endpoint: "https://auth.example.com/oauth/authorize",
  device_authorization_endpoint: "https://auth.example.com/oauth/device",
  poppy_domains: ["example.com", "example.co.uk"]
};

/** The client metadata example in spec 4.1, verbatim. */
const SPEC_CLIENT = {
  client_id: "https://agent.example/agent.json",
  client_name: "Example Agent",
  logo_uri: "https://agent.example/logo.png",
  jwks_uri: "https://agent.example/jwks.json",
  redirect_uris: ["https://agent.example/oauth/callback"],
  token_endpoint_auth_method: "private_key_jwt",
  extensions: { operations: { version: "1" } }
};

const EC_KEY = { kty: "EC", crv: "P-256", x: "8-v-FQSg6HqFvDLzsN9fEh7NvGi44Yqf-NKynVlZowc", y: "NgMN41ye2FK9tOqb9Ok-UknmdzyXZp5RUrGqivhZjZY", kid: "k1", use: "sig", alg: "ES256" };

/** poppy-demo (irvinebroque/poppy-demo), as served on 11 Oct 2026. */
const DEMO = {
  poppy: '{"protocol_version":"0.1","organization":{"name":"Northstar Outfitters","domain":"poppy-receiver.roundtrip.workers.dev"},"auth":{"issuer":"https://poppy-receiver.roundtrip.workers.dev","direct":{"scopes":["poppy:read","poppy:write"]}},"agent":{"protocols":[{"type":"poppy","endpoint":"https://poppy-receiver.roundtrip.workers.dev/poppy/conversations"}]},"apis":[{"type":"openapi","url":"https://poppy-receiver.roundtrip.workers.dev/openapi.json","description":"Orders and jacket exchanges"}],"web":{}}',
  metadata:
    '{"issuer":"https://poppy-receiver.roundtrip.workers.dev","poppy_domains":["poppy-receiver.roundtrip.workers.dev"],"authorization_endpoint":"https://poppy-receiver.roundtrip.workers.dev/oauth/authorize","token_endpoint":"https://poppy-receiver.roundtrip.workers.dev/oauth/token","revocation_endpoint":"https://poppy-receiver.roundtrip.workers.dev/oauth/revoke","grant_types_supported":["urn:ietf:params:oauth:grant-type:jwt-bearer","authorization_code","refresh_token"],"response_types_supported":["code"],"token_endpoint_auth_methods_supported":["private_key_jwt"],"token_endpoint_auth_signing_alg_values_supported":["ES256"],"code_challenge_methods_supported":["S256"],"dpop_signing_alg_values_supported":["ES256"],"scopes_supported":["poppy:read","poppy:write"]}',
  client:
    '{"client_id":"https://poppy-caller.roundtrip.workers.dev/agent.json","client_name":"Poppy Personal Agent","jwks_uri":"https://poppy-caller.roundtrip.workers.dev/jwks.json","redirect_uris":["https://poppy-caller.roundtrip.workers.dev/oauth/callback"],"token_endpoint_auth_method":"private_key_jwt"}',
  jwks: '{"keys":[{"kty":"EC","crv":"P-256","x":"8-v-FQSg6HqFvDLzsN9fEh7NvGi44Yqf-NKynVlZowc","y":"NgMN41ye2FK9tOqb9Ok-UknmdzyXZp5RUrGqivhZjZY","kid":"agent-key-1","use":"sig","alg":"ES256"}]}'
};

const withPoppy = (change: (doc: Record<string, any>) => void) => {
  const doc = structuredClone(SPEC_POPPY) as Record<string, any>;
  change(doc);
  return doc;
};

describe("valid documents", () => {
  it("accepts the specification's own examples with no errors or warnings", async () => {
    const poppy = text("poppy", SPEC_POPPY, { domain: "example.com" });
    expect(poppy.outcome).toBe("valid");
    expect(poppy.counts).toEqual({ error: 0, warning: 0, info: 0 });
    const client = text("client-metadata", SPEC_CLIENT, { fetchedFrom: SPEC_CLIENT.client_id });
    expect(client.counts).toEqual({ error: 0, warning: 0, info: 0 });
    const company = record(
      await validateCompany(
        network({
          "https://example.com/.well-known/poppy.json": jsonResponse(SPEC_POPPY),
          "https://auth.example.com/.well-known/oauth-authorization-server": jsonResponse(SPEC_METADATA)
        }),
        "example.com"
      )
    );
    expect(company.outcome).toBe("valid");
    // The spec's metadata example doesn't say authorization responses carry iss.
    expect(ids(company)).toEqual(["metadata-iss-parameter"]);
  });

  it("accepts poppy-demo's live documents", async () => {
    const fetcher = network({
      "https://poppy-receiver.roundtrip.workers.dev/.well-known/poppy.json": jsonResponse(DEMO.poppy),
      "https://poppy-receiver.roundtrip.workers.dev/.well-known/oauth-authorization-server": jsonResponse(DEMO.metadata),
      "https://poppy-caller.roundtrip.workers.dev/agent.json": jsonResponse(DEMO.client),
      "https://poppy-caller.roundtrip.workers.dev/jwks.json": jsonResponse(DEMO.jwks)
    });
    const company = record(await validateTarget(fetcher, "poppy-receiver.roundtrip.workers.dev"));
    expect(company.outcome).toBe("valid");
    expect(company.counts.error + company.counts.warning).toBe(0);
    const client = record(await validateTarget(fetcher, "https://poppy-caller.roundtrip.workers.dev/agent.json"));
    expect(client.outcome).toBe("valid");
    expect(client.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it("accepts the mock Company's documents, which the conformance tests rely on", async () => {
    const id = `v${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await (env as Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> }).MOCK_COMPANY.getByName(id).configure({});
    const result = record(await validateCompany(testFetcher(env), `${id}.shop.test`));
    expect(result.outcome).toBe("valid");
    expect(result.counts.error + result.counts.warning).toBe(0);
    // Its deliberately unknown API, protocol, extension and field are reported as info only.
    expect(ids(result)).toEqual(expect.arrayContaining(["api-type-unknown", "protocol-type-unknown", "unknown-member"]));
  });

  it("accepts our own client metadata and keys", async () => {
    const result = record(await validateClient(testFetcher(env), "https://agent.test/poppy/client.json"));
    expect(result.outcome).toBe("valid");
    expect(result.counts).toEqual({ error: 0, warning: 0, info: 0 });
    expect(result.documents.map((d) => d.kind)).toEqual(["client-metadata", "jwks"]);
  });
});

describe("poppy.json", () => {
  it("reports JSON problems with line and column", () => {
    const syntax = text("poppy", '{\n  "protocol_version": "0.1",\n  "organization": {\n}');
    expect(syntax.messages[0]).toMatchObject({ id: "json-syntax", line: 4, column: 2 });
    expect(syntax.outcome).toBe("invalid");
    const duplicate = text("poppy", '{"protocol_version":"0.1","protocol_version":"0.1","organization":{"name":"A","domain":"a.example"},"web":{}}');
    expect(duplicate.messages.find((m) => m.id === "json-duplicate-member")).toMatchObject({ line: 1, column: 27, pointer: "/protocol_version" });
    expect(ids(text("poppy", `﻿${JSON.stringify(SPEC_POPPY)}`))).toContain("json-bom");
  });

  it("chooses rules by protocol_version", () => {
    expect(ids(text("poppy", withPoppy((d) => (d.protocol_version = "1"))))).toContain("version-format");
    const major = text("poppy", withPoppy((d) => (d.protocol_version = "1.0")));
    expect(ids(major)).toEqual(["version-unsupported-major"]);
    expect(major.messages[0]!.text).toMatch(/version 1\.0/);
    const minor = text("poppy", withPoppy((d) => {
      d.protocol_version = "0.7";
      d.loyalty = { tier: "gold" };
    }));
    expect(minor.outcome).toBe("valid");
    expect(ids(minor)).toEqual(["version-newer-minor", "unknown-member"]);
    expect(ids(text("poppy", withPoppy((d) => delete d.protocol_version)))).toContain("missing-member");
  });

  it("checks organization", () => {
    expect(ids(text("poppy", withPoppy((d) => (d.organization = "Example"))))).toContain("wrong-type");
    expect(ids(text("poppy", withPoppy((d) => delete d.organization.name)))).toEqual(["organization-name-missing"]);
    expect(ids(text("poppy", withPoppy((d) => (d.organization.domain = "https://example.com/"))))).toContain("domain-invalid");
    const mismatch = text("poppy", SPEC_POPPY, { domain: "evil.example" });
    expect(ids(mismatch)).toEqual(["organization-domain-mismatch"]);
    // A leading www. is ignored.
    expect(text("poppy", SPEC_POPPY, { domain: "www.example.com" }).outcome).toBe("valid");
  });

  it("requires auth for Sessions and something to offer", () => {
    const noAuth = text("poppy", withPoppy((d) => delete d.auth));
    expect(ids(noAuth)).toEqual(["auth-required"]);
    expect(noAuth.messages[0]!.text).toMatch(/agent, apis, web.browser_session_endpoint/);
    const websiteOnly = text("poppy", { protocol_version: "0.1", organization: { name: "A", domain: "a.example" }, web: {} });
    expect(websiteOnly.outcome).toBe("valid");
    expect(ids(websiteOnly)).toEqual(["website-only"]);
    expect(ids(text("poppy", withPoppy((d) => {
      delete d.agent;
      delete d.apis;
      delete d.web;
    })))).toEqual(["nothing-offered"]);
  });

  it("checks the issuer and sign-in types", () => {
    expect(ids(text("poppy", withPoppy((d) => (d.auth.issuer = "http://auth.example.com"))))).toEqual(["not-https-url"]);
    expect(ids(text("poppy", withPoppy((d) => (d.auth.issuer = "https://auth.example.com?tenant=1"))))).toEqual(["issuer-query"]);
    expect(ids(text("poppy", withPoppy((d) => (d.auth.issuer = "https://auth.example.com/#x"))))).toEqual(["url-has-fragment"]);
    expect(ids(text("poppy", withPoppy((d) => (d.auth.issuer = "auth.example.com"))))).toEqual(["not-a-url"]);
    expect(ids(text("poppy", withPoppy((d) => (d.auth = { issuer: "https://auth.example.com" }))))).toEqual(["signed-out-only"]);
  });

  it("checks scopes", () => {
    const scoped = text("poppy", withPoppy((d) => {
      d.auth.direct.scopes = ["poppy:read", "poppy:read", "poppy:admin", "bad scope", "loyalty"];
      d.auth.device.scopes = [];
      d.auth.custom_scopes.gift_cards = "Use gift cards";
      d.auth.custom_scopes["poppy:everything"] = "All of it";
    }));
    expect(ids(scoped)).toEqual(expect.arrayContaining([
      "scope-duplicate",
      "scope-reserved",
      "scope-syntax",
      "scopes-empty",
      "scope-undescribed",
      "scope-unoffered"
    ]));
    expect(scoped.messages.filter((m) => m.id === "scope-reserved").map((m) => m.pointer)).toEqual([
      "/auth/direct/scopes/2",
      "/auth/custom_scopes/poppy:everything"
    ]);
  });

  it("checks Mediated Sign-In's fields", () => {
    expect(ids(text("poppy", withPoppy((d) => (d.auth.mediated.fields = []))))).toEqual(["mediated-fields-empty"]);
    const fields = text("poppy", withPoppy((d) => {
      d.auth.mediated.fields = [
        { name: "email", label: "Email" },
        { name: "pin", label: "PIN", secret: false },
        { name: "email", label: "Email again", secret: false }
      ];
    }));
    expect(ids(fields)).toEqual(["mediated-secret-missing", "mediated-looks-secret", "mediated-field-duplicate"]);
  });

  it("checks the agent, APIs and resources", () => {
    const agent = text("poppy", withPoppy((d) => {
      d.agent.protocols = [{ type: "example.com/chat", endpoint: "https://api.example.com/chat", resource: "not a uri" }];
    }));
    expect(ids(agent)).toEqual(["resource-invalid", "protocol-type-unknown", "no-poppy-protocol"]);
    const apis = text("poppy", withPoppy((d) => {
      d.apis = [
        { type: "graphql", url: "https://api.example.com/graphql", description: "Everything" },
        { type: "openapi", url: "https://api.example.com/openapi.json" },
        { type: "mcp", url: "https://mcp.example.com/mcp", description: "Search", resource: "https://mcp.example.com/" }
      ];
    }));
    expect(ids(apis)).toEqual(["api-type-unknown", "api-description-missing", "mcp-resource-mismatch"]);
  });

  it("checks extensions", () => {
    const result = text("poppy", withPoppy((d) => {
      d.extensions = {
        operations: { version: "1", endpoint: "https://api.example.com/poppy/operations" },
        "example.com/gift-wrap": { version: "2", anything: true },
        "gift-wrap": { version: "1" },
        "notadomain/gift-wrap": { version: "1" },
        "example.com/no-version": {}
      };
    }));
    expect(ids(result)).toEqual(["extension-plain-unknown", "extension-name", "missing-member"]);
    expect(ids(text("poppy", withPoppy((d) => (d.extensions = { operations: { version: "2" } }))))).toEqual(["extension-version-unknown"]);
    expect(ids(text("poppy", withPoppy((d) => (d.extensions = { operations: { version: "1" } }))))).toEqual(["missing-member"]);
  });
});

describe("OAuth server metadata, checked against poppy.json", () => {
  const company = (metadata: unknown, poppy: unknown = SPEC_POPPY) =>
    validateCompany(
      network({
        "https://example.com/.well-known/poppy.json": jsonResponse(poppy),
        "https://auth.example.com/.well-known/oauth-authorization-server": jsonResponse(metadata)
      }),
      "example.com"
    ).then(record);

  it("requires the issuer to match exactly and the domain to be listed", async () => {
    const issuer = await company({ ...SPEC_METADATA, issuer: "https://auth.example.com/" });
    expect(ids(issuer)).toContain("metadata-issuer-mismatch");
    expect(issuer.outcome).toBe("invalid");
    // poppy_domains must include organization.domain itself, not a www. variant (3.2).
    const domains = await company({ ...SPEC_METADATA, poppy_domains: ["www.example.com"] });
    expect(ids(domains)).toContain("metadata-domain-missing");
  });

  it("requires the endpoints each sign-in type needs", async () => {
    const { authorization_endpoint, device_authorization_endpoint, ...rest } = SPEC_METADATA;
    const result = await company(rest);
    expect(result.messages.filter((m) => m.id === "missing-member").map((m) => m.pointer)).toEqual([
      "/authorization_endpoint",
      "/device_authorization_endpoint"
    ]);
    void authorization_endpoint;
    void device_authorization_endpoint;
  });

  it("warns when advertised capabilities leave out what agents use", async () => {
    const result = await company({
      ...SPEC_METADATA,
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      token_endpoint_auth_signing_alg_values_supported: ["HS256"],
      grant_types_supported: ["authorization_code"],
      dpop_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["plain"]
    });
    expect(result.outcome).toBe("valid");
    expect(ids(result)).toEqual([
      "metadata-auth-method",
      "metadata-signing-alg",
      "metadata-grant-type",
      "metadata-grant-type",
      "metadata-grant-type",
      "metadata-dpop-alg",
      "metadata-pkce",
      "metadata-iss-parameter"
    ]);
  });

  it("finds metadata for an issuer with a path (RFC 8414 §3.1)", async () => {
    const poppy = withPoppy((d) => (d.auth.issuer = "https://auth.example.com/tenant/"));
    const result = record(
      await validateCompany(
        network({
          "https://example.com/.well-known/poppy.json": jsonResponse(poppy),
          "https://auth.example.com/.well-known/oauth-authorization-server/tenant": jsonResponse({ ...SPEC_METADATA, issuer: "https://auth.example.com/tenant/" })
        }),
        "example.com"
      )
    );
    expect(result.counts.error).toBe(0);
  });
});

describe("client metadata and keys", () => {
  it("checks client_id, domains and the auth method", () => {
    const result = text(
      "client-metadata",
      { ...SPEC_CLIENT, jwks_uri: "https://keys.other.example/jwks.json", redirect_uris: ["https://other.example/cb"], token_endpoint_auth_method: "none" },
      { fetchedFrom: "https://agent.example/client.json" }
    );
    expect(ids(result)).toEqual(["client-id-mismatch", "client-other-domain", "client-other-domain", "client-auth-method"]);
    const { redirect_uris, ...noRedirects } = SPEC_CLIENT;
    void redirect_uris;
    expect(ids(text("client-metadata", noRedirects))).toEqual(["client-no-redirects"]);
  });

  it("checks every key", () => {
    const result = text("jwks", {
      keys: [
        { ...EC_KEY, d: "private" },
        { kty: "EC", crv: "P-384", x: "a", y: "b", kid: "k2" },
        { kty: "RSA", n: "AQAB", e: "AQAB", kid: "k3" },
        { kty: "oct", k: "secret", kid: "k4" },
        { ...EC_KEY, kid: "k5", alg: "ES384", use: "enc" },
        { ...EC_KEY, kid: undefined },
        { ...EC_KEY, kid: "k1" }
      ]
    });
    expect(ids(result)).toEqual([
      "jwks-private-key",
      "jwks-key-type",
      "jwks-rsa-small",
      "jwks-private-key",
      "jwks-key-type",
      "jwks-alg",
      "jwks-use",
      "jwks-no-kid",
      "jwks-kid-duplicate"
    ]);
    expect(ids(text("jwks", { keys: [] }))).toEqual(["jwks-empty"]);
  });

  it("refuses a client_id that redirects, as Companies do", async () => {
    const result = record(
      await validateClient(
        network({ "https://agent.example/agent.json": () => new Response(null, { status: 302, headers: { Location: "https://agent.example/v2.json" } }) }),
        "https://agent.example/agent.json"
      )
    );
    expect(ids(result)).toEqual(["http-redirect-not-allowed"]);
  });
});

describe("fetching", () => {
  const wellKnown = "https://example.com/.well-known/poppy.json";
  const fetchOne = (route: () => Response) => validateCompany(network({ [wellKnown]: route }), "example.com").then(record);

  it("follows HTTPS redirects but not to HTTP, and not too many", async () => {
    const http = await fetchOne(() => new Response(null, { status: 302, headers: { Location: "http://cdn.example.com/poppy.json" } }));
    expect(ids(http)).toEqual(["http-redirect-not-https"]);
    const loop = await fetchOne(() => new Response(null, { status: 302, headers: { Location: wellKnown } }));
    expect(ids(loop)).toEqual(["http-too-many-redirects"]);
  });

  it("calls an unreachable document indeterminate, not invalid", async () => {
    const missing = await fetchOne(() => new Response("Not found", { status: 404 }));
    expect(ids(missing)).toEqual(["http-status"]);
    expect(missing.outcome).toBe("indeterminate");
    const down = record(await validateCompany(network({}), "example.com"));
    expect(ids(down)).toEqual(["http-failed"]);
    expect(down.outcome).toBe("indeterminate");
  });

  it("checks size, encoding, type and caching", async () => {
    expect(ids(await fetchOne(jsonResponse("x".repeat(100_001))))).toEqual(["http-too-large"]);
    expect(ids(await fetchOne(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } })))).toEqual(["not-utf8"]);
    const loose = await fetchOne(() => new Response(JSON.stringify(withPoppy((d) => delete d.auth.issuer)), { headers: { "Content-Type": "text/plain" } }));
    expect(ids(loose)).toEqual(["http-content-type", "http-no-cache-headers", "missing-member"]);
    expect(ids(await fetchOne(jsonResponse({ ...withPoppy((d) => delete d.auth) }, { "Cache-Control": "max-age=5" })))).toContain("http-cache-bounded");
  });

  it("refuses non-HTTPS and private hosts, and non-domains", async () => {
    expect(ids(record(await validateClient(network({}), "http://agent.example/agent.json")))).toEqual(["http-not-https"]);
    expect(ids(record(await validateClient(network({}), "https://localhost/agent.json")))).toEqual(["http-non-public-host"]);
    expect(ids(record(await validateCompany(network({}), "not a domain")))).toEqual(["domain-invalid"]);
  });
});

describe("over HTTP", () => {
  const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://agent.test${path}`, init), env);

  it("serves the form and the messages page", async () => {
    const form = await call("/validator");
    expect(form.status).toBe(200);
    const page = await form.text();
    expect(page).toContain("<title>Poppy Validator</title>");
    expect(page).toContain('<label for="url">');
    const messages = await (await call("/validator/messages")).text();
    for (const id of Object.keys(MESSAGES)) expect(messages).toContain(`id="${id}"`);
  });

  it("answers a JSON POST with the JSON report, for any origin", async () => {
    const response = await call("/validator/api", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://elsewhere.example" },
      body: JSON.stringify({ document: SPEC_POPPY, kind: "poppy", domain: "example.com" })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const report = (await response.json()) as Report;
    expect(report).toMatchObject({ outputVersion: 1, outcome: "valid", checkedAgainst: "Draft 0.1" });
    const preflight = await call("/validator/api", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    const bad = await call("/validator/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document: "{}", kind: "feed" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/kind must be/);
  });

  it("answers the form with an escaped results page", async () => {
    const response = await call("/validator", {
      method: "POST",
      body: new URLSearchParams({ document: '{"protocol_version":"0.1","organization":{"name":"<script>alert(1)</script>","domain":"a.example"},"agent":{}}', kind: "poppy" })
    });
    const page = await response.text();
    expect(page).toContain("Not valid");
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&#60;script&#62;");
  });

  it("checks a URL, within the caller's rate limit", async () => {
    const id = `v${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await (env as Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> }).MOCK_COMPANY.getByName(id).configure({});
    const request = () => new Request(`https://agent.test/validator/api?url=${id}.shop.test`);
    const allowed = await handleValidator(request(), { fetcher: testFetcher(env), allowFetch: async () => true });
    expect(((await allowed!.json()) as Report).outcome).toBe("valid");
    const limited = await handleValidator(request(), { fetcher: testFetcher(env), allowFetch: async () => false });
    expect(limited!.status).toBe(429);
  });
});

// Last, so every fixture above has run (tests in a file run in order).
describe("the message catalog", () => {
  it("has a fixture above that produces every message", () => {
    const missing = (Object.keys(MESSAGES) as MessageId[]).filter((id) => !seen.has(id));
    expect(missing).toEqual([]);
  });
});
