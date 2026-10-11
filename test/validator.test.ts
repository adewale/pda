import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
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
import { LIMITS } from "../src/validator/fetch.ts";
import { handleValidator } from "../src/validator/http.ts";
import type { MockCompany } from "./mock-company";
import worker, { testFetcher } from "./worker";

/**
 * The discovery-document validator. As with feed validators' test suites,
 * every message id must be produced by at least one fixture here, and the
 * message catalog test checks that.
 *
 * A fixture is plain data: a name (its test's title), how to get its
 * report, and the message ids the report must have, exactly and in order or
 * at least. The catalog test reads the ids the fixtures declare, not reports
 * from earlier tests, so it gives the same answer alone, in any order, or
 * shuffled; each fixture's own test proves its declared ids are produced.
 */
type Fixture = {
  readonly name: string;
  readonly run: () => Report | Promise<Report>;
  /** The report's message ids: exactly these, in order, or at least these. */
  readonly ids: readonly MessageId[] | { readonly contains: readonly MessageId[] };
  readonly outcome?: Report["outcome"];
  /** Assertions beyond ids and outcome: pointers, positions, wording, counts. */
  readonly also?: (report: Report) => void;
};

const ids = (report: Report) => report.messages.map((m) => m.id);

const declaredIds = (fixture: Fixture): readonly MessageId[] =>
  "contains" in fixture.ids ? fixture.ids.contains : (fixture.ids as readonly MessageId[]);

async function check(fixture: Fixture) {
  const report = await fixture.run();
  if ("contains" in fixture.ids) {
    expect(ids(report)).toEqual(expect.arrayContaining([...fixture.ids.contains]));
  } else {
    expect(ids(report)).toEqual(fixture.ids);
  }
  if (fixture.outcome) expect(report.outcome).toBe(fixture.outcome);
  fixture.also?.(report);
}

/** Each fixture is its own test, titled by its name. */
function testEach(fixtures: readonly Fixture[]) {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) =>
    check(fixture)
  );
}

function text(kind: DocumentKind, doc: unknown, options: Parameters<typeof validateText>[2] = {}): Report {
  const source = typeof doc === "string" ? doc : JSON.stringify(doc, null, 2);
  return validateText(kind, source, options);
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

const demoNetwork = () =>
  network({
    "https://poppy-receiver.roundtrip.workers.dev/.well-known/poppy.json": jsonResponse(DEMO.poppy),
    "https://poppy-receiver.roundtrip.workers.dev/.well-known/oauth-authorization-server": jsonResponse(DEMO.metadata),
    "https://poppy-caller.roundtrip.workers.dev/agent.json": jsonResponse(DEMO.client),
    "https://poppy-caller.roundtrip.workers.dev/jwks.json": jsonResponse(DEMO.jwks)
  });

const withPoppy = (change: (doc: Record<string, any>) => void) => {
  const doc = structuredClone(SPEC_POPPY) as Record<string, any>;
  change(doc);
  return doc;
};

/** A fresh mock Company, whose documents the conformance tests rely on. */
async function mockCompany(): Promise<string> {
  const id = `v${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await (env as Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> }).MOCK_COMPANY.getByName(id).configure({});
  return `${id}.shop.test`;
}

/** example.com's poppy.json and OAuth metadata, from a fake network. */
const company = (metadata: unknown, poppy: unknown = SPEC_POPPY) =>
  validateCompany(
    network({
      "https://example.com/.well-known/poppy.json": jsonResponse(poppy),
      "https://auth.example.com/.well-known/oauth-authorization-server": jsonResponse(metadata)
    }),
    "example.com"
  );

const wellKnown = "https://example.com/.well-known/poppy.json";
const fetchOne = (route: () => Response) => validateCompany(network({ [wellKnown]: route }), "example.com");

const noErrorsOrWarnings = (report: Report) => expect(report.counts.error + report.counts.warning).toBe(0);

const VALID: readonly Fixture[] = [
  {
    name: "accepts the specification's poppy.json example with no messages",
    run: () => text("poppy", SPEC_POPPY, { domain: "example.com" }),
    ids: [],
    outcome: "valid"
  },
  {
    name: "accepts the specification's client metadata example with no messages",
    run: () => text("client-metadata", SPEC_CLIENT, { fetchedFrom: SPEC_CLIENT.client_id }),
    ids: [],
    outcome: "valid"
  },
  {
    // The spec's metadata example doesn't say authorization responses carry iss.
    name: "accepts the specification's examples as a Company, noting only the missing iss parameter",
    run: () =>
      validateCompany(
        network({
          "https://example.com/.well-known/poppy.json": jsonResponse(SPEC_POPPY),
          "https://auth.example.com/.well-known/oauth-authorization-server": jsonResponse(SPEC_METADATA)
        }),
        "example.com"
      ),
    ids: ["metadata-iss-parameter"],
    outcome: "valid"
  },
  {
    name: "accepts poppy-demo's live Company documents",
    run: () => validateTarget(demoNetwork(), "poppy-receiver.roundtrip.workers.dev"),
    ids: ["metadata-iss-parameter"],
    outcome: "valid",
    also: noErrorsOrWarnings
  },
  {
    name: "accepts poppy-demo's live client metadata and keys with no messages",
    run: () => validateTarget(demoNetwork(), "https://poppy-caller.roundtrip.workers.dev/agent.json"),
    ids: [],
    outcome: "valid"
  },
  {
    // Its deliberately unknown API, protocol, extension and field are reported as info only.
    name: "accepts the mock Company's documents, which the conformance tests rely on",
    run: async () => validateCompany(testFetcher(env), await mockCompany()),
    ids: { contains: ["api-type-unknown", "protocol-type-unknown", "unknown-member"] },
    outcome: "valid",
    also: noErrorsOrWarnings
  },
  {
    name: "accepts our own client metadata and keys",
    run: () => validateClient(testFetcher(env), "https://agent.test/poppy/client.json"),
    ids: [],
    outcome: "valid",
    also: (report) => expect(report.documents.map((d) => d.kind)).toEqual(["client-metadata", "jwks"])
  }
];

const POPPY_JSON: readonly Fixture[] = [
  {
    name: "reports a JSON syntax error with line and column",
    run: () => text("poppy", '{\n  "protocol_version": "0.1",\n  "organization": {\n}'),
    ids: { contains: ["json-syntax"] },
    outcome: "invalid",
    also: (report) => expect(report.messages[0]).toMatchObject({ id: "json-syntax", line: 4, column: 2 })
  },
  {
    name: "reports a duplicate member name with line, column and pointer",
    run: () => text("poppy", '{"protocol_version":"0.1","protocol_version":"0.1","organization":{"name":"A","domain":"a.example"},"web":{}}'),
    ids: { contains: ["json-duplicate-member"] },
    also: (report) =>
      expect(report.messages.find((m) => m.id === "json-duplicate-member")).toMatchObject({ line: 1, column: 27, pointer: "/protocol_version" })
  },
  {
    name: "reports a byte order mark",
    run: () => text("poppy", `﻿${JSON.stringify(SPEC_POPPY)}`),
    ids: { contains: ["json-bom"] }
  },
  {
    name: "chooses rules by protocol_version: a version that isn't major.minor",
    run: () => text("poppy", withPoppy((d) => (d.protocol_version = "1"))),
    ids: { contains: ["version-format"] }
  },
  {
    name: "chooses rules by protocol_version: an unsupported major version",
    run: () => text("poppy", withPoppy((d) => (d.protocol_version = "1.0"))),
    ids: ["version-unsupported-major"],
    also: (report) => expect(report.messages[0]!.text).toMatch(/version 1\.0/)
  },
  {
    name: "chooses rules by protocol_version: a newer minor version, whose new fields are ignored",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.protocol_version = "0.7";
        d.loyalty = { tier: "gold" };
      })),
    ids: ["version-newer-minor", "unknown-member"],
    outcome: "valid"
  },
  {
    name: "chooses rules by protocol_version: none given",
    run: () => text("poppy", withPoppy((d) => delete d.protocol_version)),
    ids: { contains: ["missing-member"] }
  },
  {
    name: "checks organization: not an object",
    run: () => text("poppy", withPoppy((d) => (d.organization = "Example"))),
    ids: { contains: ["wrong-type"] }
  },
  {
    name: "checks organization: no name",
    run: () => text("poppy", withPoppy((d) => delete d.organization.name)),
    ids: ["organization-name-missing"]
  },
  {
    name: "checks organization: a URL as the domain",
    run: () => text("poppy", withPoppy((d) => (d.organization.domain = "https://example.com/"))),
    ids: { contains: ["domain-invalid"] }
  },
  {
    name: "checks organization: a domain other than the one asked for",
    run: () => text("poppy", SPEC_POPPY, { domain: "evil.example" }),
    ids: ["organization-domain-mismatch"]
  },
  {
    name: "checks organization: a leading www. is ignored",
    run: () => text("poppy", SPEC_POPPY, { domain: "www.example.com" }),
    ids: [],
    outcome: "valid"
  },
  {
    name: "requires auth for Sessions",
    run: () => text("poppy", withPoppy((d) => delete d.auth)),
    ids: ["auth-required"],
    also: (report) => expect(report.messages[0]!.text).toMatch(/agent, apis, web.browser_session_endpoint/)
  },
  {
    name: "accepts a website-only Company, with a note",
    run: () => text("poppy", { protocol_version: "0.1", organization: { name: "A", domain: "a.example" }, web: {} }),
    ids: ["website-only"],
    outcome: "valid"
  },
  {
    name: "requires something to offer",
    run: () =>
      text("poppy", withPoppy((d) => {
        delete d.agent;
        delete d.apis;
        delete d.web;
      })),
    ids: ["nothing-offered"]
  },
  {
    name: "checks the issuer: http",
    run: () => text("poppy", withPoppy((d) => (d.auth.issuer = "http://auth.example.com"))),
    ids: ["not-https-url"]
  },
  {
    name: "checks the issuer: a query",
    run: () => text("poppy", withPoppy((d) => (d.auth.issuer = "https://auth.example.com?tenant=1"))),
    ids: ["issuer-query"]
  },
  {
    name: "checks the issuer: a fragment",
    run: () => text("poppy", withPoppy((d) => (d.auth.issuer = "https://auth.example.com/#x"))),
    ids: ["url-has-fragment"]
  },
  {
    name: "checks the issuer: not a URL",
    run: () => text("poppy", withPoppy((d) => (d.auth.issuer = "auth.example.com"))),
    ids: ["not-a-url"]
  },
  {
    name: "checks sign-in types: none offered",
    run: () => text("poppy", withPoppy((d) => (d.auth = { issuer: "https://auth.example.com" }))),
    ids: ["signed-out-only"]
  },
  {
    name: "checks scopes",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.auth.direct.scopes = ["poppy:read", "poppy:read", "poppy:admin", "bad scope", "loyalty"];
        d.auth.device.scopes = [];
        d.auth.custom_scopes.gift_cards = "Use gift cards";
        d.auth.custom_scopes["poppy:everything"] = "All of it";
      })),
    ids: {
      contains: ["scope-duplicate", "scope-reserved", "scope-syntax", "scopes-empty", "scope-undescribed", "scope-unoffered"]
    },
    also: (report) =>
      expect(report.messages.filter((m) => m.id === "scope-reserved").map((m) => m.pointer)).toEqual([
        "/auth/direct/scopes/2",
        "/auth/custom_scopes/poppy:everything"
      ])
  },
  {
    name: "checks Mediated Sign-In's fields: none",
    run: () => text("poppy", withPoppy((d) => (d.auth.mediated.fields = []))),
    ids: ["mediated-fields-empty"]
  },
  {
    name: "checks Mediated Sign-In's fields: secret missing, looks secret, duplicate",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.auth.mediated.fields = [
          { name: "email", label: "Email" },
          { name: "pin", label: "PIN", secret: false },
          { name: "email", label: "Email again", secret: false }
        ];
      })),
    ids: ["mediated-secret-missing", "mediated-looks-secret", "mediated-field-duplicate"]
  },
  {
    name: "checks the agent's protocols and resources",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.agent.protocols = [{ type: "example.com/chat", endpoint: "https://api.example.com/chat", resource: "not a uri" }];
      })),
    ids: ["resource-invalid", "protocol-type-unknown", "no-poppy-protocol"]
  },
  {
    name: "checks the conversation endpoint: http",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.agent.protocols = [{ type: "poppy", endpoint: "http://api.example.com/poppy/conversations" }];
      })),
    ids: ["not-https-url"]
  },
  {
    name: "checks the APIs",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.apis = [
          { type: "graphql", url: "https://api.example.com/graphql", description: "Everything" },
          { type: "openapi", url: "https://api.example.com/openapi.json" },
          { type: "mcp", url: "https://mcp.example.com/mcp", description: "Search", resource: "https://mcp.example.com/" }
        ];
      })),
    ids: ["api-type-unknown", "api-description-missing", "mcp-resource-mismatch"]
  },
  {
    name: "checks extensions: names and versions",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.extensions = {
          operations: { version: "1", endpoint: "https://api.example.com/poppy/operations" },
          "example.com/gift-wrap": { version: "2", anything: true },
          "gift-wrap": { version: "1" },
          "notadomain/gift-wrap": { version: "1" },
          "example.com/no-version": {}
        };
      })),
    ids: ["extension-plain-unknown", "extension-name", "missing-member"]
  },
  {
    name: "checks extensions: an unknown operations version",
    run: () => text("poppy", withPoppy((d) => (d.extensions = { operations: { version: "2" } }))),
    ids: ["extension-version-unknown"]
  },
  {
    name: "checks extensions: operations without its endpoint",
    run: () => text("poppy", withPoppy((d) => (d.extensions = { operations: { version: "1" } }))),
    ids: ["missing-member"]
  }
];

const METADATA: readonly Fixture[] = [
  {
    name: "requires the issuer to match exactly, so a trailing slash doesn't",
    run: () => company({ ...SPEC_METADATA, issuer: "https://auth.example.com/" }),
    ids: { contains: ["metadata-issuer-mismatch"] },
    outcome: "invalid"
  },
  {
    // poppy_domains must include organization.domain itself, not a www. variant (3.2).
    name: "requires the domain to be listed in poppy_domains, not a www. variant",
    run: () => company({ ...SPEC_METADATA, poppy_domains: ["www.example.com"] }),
    ids: { contains: ["metadata-domain-missing"] }
  },
  {
    name: "requires the endpoints each sign-in type needs",
    run: () => {
      const { authorization_endpoint: _a, device_authorization_endpoint: _d, ...rest } = SPEC_METADATA;
      return company(rest);
    },
    ids: { contains: ["missing-member"] },
    also: (report) =>
      expect(report.messages.filter((m) => m.id === "missing-member").map((m) => m.pointer)).toEqual([
        "/authorization_endpoint",
        "/device_authorization_endpoint"
      ])
  },
  {
    name: "warns when advertised capabilities leave out what agents use",
    run: () =>
      company({
        ...SPEC_METADATA,
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        token_endpoint_auth_signing_alg_values_supported: ["HS256"],
        grant_types_supported: ["authorization_code"],
        dpop_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["plain"]
      }),
    ids: [
      "metadata-auth-method",
      "metadata-signing-alg",
      "metadata-grant-type",
      "metadata-grant-type",
      "metadata-grant-type",
      "metadata-dpop-alg",
      "metadata-pkce",
      "metadata-iss-parameter"
    ],
    outcome: "valid"
  },
  {
    name: "finds metadata for an issuer with a path (RFC 8414 §3.1)",
    run: () =>
      validateCompany(
        network({
          "https://example.com/.well-known/poppy.json": jsonResponse(withPoppy((d) => (d.auth.issuer = "https://auth.example.com/tenant/"))),
          "https://auth.example.com/.well-known/oauth-authorization-server/tenant": jsonResponse({ ...SPEC_METADATA, issuer: "https://auth.example.com/tenant/" })
        }),
        "example.com"
      ),
    ids: ["metadata-iss-parameter"],
    also: (report) => expect(report.counts.error).toBe(0)
  }
];

const CLIENT: readonly Fixture[] = [
  {
    name: "checks client_id, domains and the auth method",
    run: () =>
      text(
        "client-metadata",
        { ...SPEC_CLIENT, jwks_uri: "https://keys.other.example/jwks.json", redirect_uris: ["https://other.example/cb"], token_endpoint_auth_method: "none" },
        { fetchedFrom: "https://agent.example/client.json" }
      ),
    ids: ["client-id-mismatch", "client-other-domain", "client-other-domain", "client-auth-method"]
  },
  {
    name: "requires redirect_uris",
    run: () => {
      const { redirect_uris: _r, ...noRedirects } = SPEC_CLIENT;
      return text("client-metadata", noRedirects);
    },
    ids: ["client-no-redirects"]
  },
  {
    name: "checks every key",
    run: () =>
      text("jwks", {
        keys: [
          { ...EC_KEY, d: "private" },
          { kty: "EC", crv: "P-384", x: "a", y: "b", kid: "k2" },
          { kty: "RSA", n: "AQAB", e: "AQAB", kid: "k3" },
          { kty: "oct", k: "secret", kid: "k4" },
          { ...EC_KEY, kid: "k5", alg: "ES384", use: "enc" },
          { ...EC_KEY, kid: undefined },
          { ...EC_KEY, kid: "k1" }
        ]
      }),
    ids: [
      "jwks-private-key",
      "jwks-key-type",
      "jwks-rsa-small",
      "jwks-private-key",
      "jwks-key-type",
      "jwks-alg",
      "jwks-use",
      "jwks-no-kid",
      "jwks-kid-duplicate"
    ]
  },
  {
    name: "requires at least one key",
    run: () => text("jwks", { keys: [] }),
    ids: ["jwks-empty"]
  },
  {
    name: "refuses a client_id that redirects, as Companies do",
    run: () =>
      validateClient(
        network({ "https://agent.example/agent.json": () => new Response(null, { status: 302, headers: { Location: "https://agent.example/v2.json" } }) }),
        "https://agent.example/agent.json"
      ),
    ids: ["http-redirect-not-allowed"]
  }
];

const FETCHING: readonly Fixture[] = [
  {
    name: "follows HTTPS redirects but not to HTTP",
    run: () => fetchOne(() => new Response(null, { status: 302, headers: { Location: "http://cdn.example.com/poppy.json" } })),
    ids: ["http-redirect-not-https"]
  },
  {
    name: "follows redirects, but not too many",
    run: () => fetchOne(() => new Response(null, { status: 302, headers: { Location: wellKnown } })),
    ids: ["http-too-many-redirects"]
  },
  {
    name: "calls a missing document indeterminate, not invalid",
    run: () => fetchOne(() => new Response("Not found", { status: 404 })),
    ids: ["http-status"],
    outcome: "indeterminate"
  },
  {
    name: "calls an unreachable host indeterminate, not invalid",
    run: () => validateCompany(network({}), "example.com"),
    ids: ["http-failed"],
    outcome: "indeterminate"
  },
  {
    name: "checks size",
    run: () => fetchOne(jsonResponse("x".repeat(100_001))),
    ids: ["http-too-large"]
  },
  {
    name: "checks encoding",
    run: () => fetchOne(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } })),
    ids: ["not-utf8"]
  },
  {
    name: "checks content type and caching headers",
    run: () => fetchOne(() => new Response(JSON.stringify(withPoppy((d) => delete d.auth.issuer)), { headers: { "Content-Type": "text/plain" } })),
    ids: ["http-content-type", "http-no-cache-headers", "missing-member"]
  },
  {
    name: "checks a cache lifetime is bounded",
    run: () => fetchOne(jsonResponse({ ...withPoppy((d) => delete d.auth) }, { "Cache-Control": "max-age=5" })),
    ids: { contains: ["http-cache-bounded"] }
  },
  {
    name: "refuses non-HTTPS",
    run: () => validateClient(network({}), "http://agent.example/agent.json"),
    ids: ["http-not-https"]
  },
  {
    name: "refuses private hosts",
    run: () => validateClient(network({}), "https://localhost/agent.json"),
    ids: ["http-non-public-host"]
  },
  {
    name: "refuses non-domains",
    run: () => validateCompany(network({}), "not a domain"),
    ids: ["domain-invalid"]
  }
];

describe("valid documents", () => testEach(VALID));
describe("poppy.json", () => testEach(POPPY_JSON));
describe("OAuth server metadata, checked against poppy.json", () => testEach(METADATA));
describe("client metadata and keys", () => testEach(CLIENT));
describe("fetching", () => {
  testEach(FETCHING);

  it("reports a body that stalls past the time limit as http-failed, not an exception", async () => {
    vi.useFakeTimers();
    try {
      // Headers at once, then one byte and silence: a fetcher that ignores the request's signal.
      let cancelled = false;
      const stalling: Fetcher = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
            cancel: () => {
              cancelled = true;
            }
          }),
          { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" } }
        );
      const pending = validateCompany(stalling, "example.com");
      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);
      const report = await pending;
      expect(ids(report)).toEqual(["http-failed"]);
      expect(report.outcome).toBe("indeterminate");
      expect(report.messages[0]!.text).toContain(`Fetching ${wellKnown} timed out after 5 seconds.`);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
    const host = await mockCompany();
    const request = () => new Request(`https://agent.test/validator/api?url=${host}`);
    const allowed = await handleValidator(request(), { fetcher: testFetcher(env), allowFetch: async () => true });
    expect(((await allowed!.json()) as Report).outcome).toBe("valid");
    const limited = await handleValidator(request(), { fetcher: testFetcher(env), allowFetch: async () => false });
    expect(limited!.status).toBe(429);
  });
});

describe("the message catalog", () => {
  const fixtures = [...VALID, ...POPPY_JSON, ...METADATA, ...CLIENT, ...FETCHING];

  it("has a fixture that produces every message", () => {
    const declared = new Set(fixtures.flatMap(declaredIds));
    const missing = (Object.keys(MESSAGES) as MessageId[]).filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it("has fixtures with distinct names", () => {
    const names = fixtures.map((fixture) => fixture.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });
});
