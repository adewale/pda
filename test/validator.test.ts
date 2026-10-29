import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  levelOf,
  MESSAGES,
  severityOf,
  validateClient,
  validateCompany,
  validateTarget,
  validateText,
  type CompanyReport,
  type DocumentKind,
  type Fetcher,
  type MessageId,
  type Report
} from "../src/validator/index.ts";
import { isPublicAddress, NonPublicAddressError, parseIPv6, pinnedLookup } from "../src/validator/address.ts";
import { fetchDocument, isPublicHost, LIMITS, readLimited } from "../src/validator/fetch.ts";
import { Checker } from "../src/validator/primitives.ts";
import { handleValidator } from "../src/validator/http.ts";
import type { MockCompany, MockConfig } from "./mock-company";
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
  readonly also?: (report: Report) => void | Promise<void>;
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
  await fixture.also?.(report);
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

/** The poppy.json example in spec section 3, with Mediated Sign-In and Operations 2 from the extension pages. */
const SPEC_POPPY = {
  protocol_version: "0.3",
  organization: { name: "Example Company", domain: "example.com" },
  auth: {
    scopes: {
      "orders:read": "See your orders, returns, and bookings",
      "orders:write": "Exchange or return items, and change bookings",
      addresses: "See and change your saved shipping addresses"
    },
    scope_hints: {
      "orders:read": { changes: "none", personal_data: true },
      "orders:write": { changes: "irreversible", personal_data: true },
      addresses: { changes: "reversible", personal_data: true }
    }
  },
  agent: { protocols: [{ type: "poppy", endpoint: "https://api.example.com/poppy/conversations" }] },
  web: { browser_session_endpoint: "https://example.com/poppy/browser-session" },
  feedback: { endpoint: "https://api.example.com/poppy/feedback" },
  excluded_tasks: { url: "https://example.com/poppy/excluded-tasks.json" },
  apis: [
    { type: "openapi", url: "https://api.example.com/openapi.json", description: "Orders, returns, and exchanges" },
    { type: "mcp", url: "https://mcp.example.com/mcp", description: "Product search and sizing" }
  ],
  extensions: {
    operations: { version: "2" },
    "mediated-sign-in": {
      version: "1",
      fields: [
        { name: "email", label: "Email", secret: false },
        { name: "password", label: "Password", secret: true }
      ],
      scopes: ["orders:read"]
    }
  }
};

/** Spec 3.2's protected resource metadata for example.com. */
const SPEC_PRM = { resource: "https://example.com", authorization_servers: ["https://auth.example.com"] };

/** Spec 3.2's issuer metadata, with the Mediated Sign-In grant and the iss parameter. */
const SPEC_METADATA = {
  issuer: "https://auth.example.com",
  token_endpoint: "https://auth.example.com/oauth/token",
  revocation_endpoint: "https://auth.example.com/oauth/revoke",
  authorization_endpoint: "https://auth.example.com/oauth/authorize",
  device_authorization_endpoint: "https://auth.example.com/oauth/device",
  grant_types_supported: ["refresh_token", "authorization_code", "urn:ietf:params:oauth:grant-type:device_code", "https://personalagentprotocol.org/grant/mediated-sign-in"],
  scopes_supported: ["orders:read", "orders:write", "addresses"],
  protected_resources: ["https://example.com", "https://example.co.uk", "https://mcp.example.com/mcp"],
  authorization_response_iss_parameter_supported: true
};

/** The client metadata example in spec 4.1, verbatim. */
const SPEC_CLIENT = {
  client_id: "https://agent.example/agent.json",
  client_name: "Example Agent",
  logo_uri: "https://agent.example/logo.png",
  jwks_uri: "https://agent.example/jwks.json",
  redirect_uris: ["https://agent.example/oauth/callback"],
  token_endpoint_auth_method: "private_key_jwt"
};

const EC_KEY = { kty: "EC", crv: "P-256", x: "8-v-FQSg6HqFvDLzsN9fEh7NvGi44Yqf-NKynVlZowc", y: "NgMN41ye2FK9tOqb9Ok-UknmdzyXZp5RUrGqivhZjZY", kid: "k1", use: "sig", alg: "ES256" };
/** A 2048-bit modulus, as far as the key size check is concerned. */
const RSA_N = "x".repeat(342);

const withPoppy = (change: (doc: Record<string, any>) => void) => {
  const doc = structuredClone(SPEC_POPPY) as Record<string, any>;
  change(doc);
  return doc;
};

/** A Company that offers only its website, which needs no issuer (3.2). */
const WEBSITE_ONLY = { protocol_version: "0.3", organization: { name: "A", domain: "example.com" }, web: {} };

/** A fresh mock Company, whose documents the conformance tests rely on. */
async function mockCompany(config: Partial<MockConfig> = {}): Promise<string> {
  const id = `v${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await (env as Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> }).MOCK_COMPANY.getByName(id).configure(config);
  return `${id}.shop.test`;
}

/** example.com's poppy.json, protected resource metadata and issuer metadata, from a fake network, each changed as given. */
const company = (change: { poppy?: (doc: Record<string, any>) => void; prm?: unknown; metadata?: (doc: Record<string, any>) => void; routes?: Record<string, () => Response> } = {}) => {
  const poppy = structuredClone(SPEC_POPPY) as Record<string, any>;
  change.poppy?.(poppy);
  const metadata = structuredClone(SPEC_METADATA) as Record<string, any>;
  change.metadata?.(metadata);
  return validateCompany(
    network({
      "https://example.com/.well-known/poppy.json": jsonResponse(poppy),
      "https://example.com/.well-known/oauth-protected-resource": jsonResponse(change.prm ?? SPEC_PRM),
      "https://auth.example.com/.well-known/oauth-authorization-server": jsonResponse(metadata),
      "https://auth.example.org/.well-known/oauth-authorization-server": jsonResponse({ ...metadata, issuer: "https://auth.example.org" }),
      ...(change.routes ?? {})
    }),
    "example.com"
  );
};

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
    name: "accepts the specification's examples as a Company, with the issuer from the domain's protected resource metadata",
    run: () => company(),
    ids: [],
    outcome: "valid",
    also: (report) => {
      expect(report.checkedAgainst).toBe("Draft 0.3");
      expect(report.protocolVersion).toBe("0.3");
      expect((report as CompanyReport).issuer).toBe("https://auth.example.com");
      expect(report.documents.map((d) => d.kind)).toEqual(["poppy", "protected-resource", "oauth-metadata"]);
    }
  },
  {
    // As the interop grid serves it (MOCK_BASE: no unknown API type). Its deliberately unknown
    // protocol, extension and field are reported as info only.
    name: "accepts the mock Company's documents, as the reference Company in the grid serves them",
    run: async () => validateCompany(testFetcher(env), await mockCompany({ unknownApi: false })),
    ids: { contains: ["protocol-type-unknown", "unknown-member"] },
    outcome: "valid",
    also: noErrorsOrWarnings
  },
  {
    // The conformance tests' default lists a graphql API on purpose, to check that agents skip
    // it (7: SHOULD skip). 0.3 allows other types, so that's information, not an error.
    name: "notes the unknown API type the conformance tests' mock lists on purpose",
    run: async () => validateCompany(testFetcher(env), await mockCompany()),
    ids: { contains: ["api-type-unknown", "protocol-type-unknown", "unknown-member"] },
    outcome: "valid",
    also: (report) => {
      noErrorsOrWarnings(report);
      expect(report.refused).toBe(false);
    }
  },
  {
    name: "accepts the mock Company's documents without its deliberate oddities, with no messages",
    run: async () => validateCompany(testFetcher(env), await mockCompany({ unknownApi: false, unknownExtension: false, unknownField: false, unknownProtocol: false })),
    ids: [],
    outcome: "valid"
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
    name: "refuses cumulative JSON location amplification as an implementation limit, not a syntax error",
    run: () => text("poppy", { ["x".repeat(4_000)]: Array(300).fill(0) }),
    ids: ["json-resource-limit"],
    outcome: "indeterminate",
    also: (report) => expect(report).toMatchObject({ refused: true, counts: { error: 0, warning: 1 } })
  },
  {
    name: "reports a JSON syntax error with line and column",
    run: () => text("poppy", '{\n  "protocol_version": "0.3",\n  "organization": {\n}'),
    ids: { contains: ["json-syntax"] },
    outcome: "invalid",
    also: (report) => expect(report.messages[0]).toMatchObject({ id: "json-syntax", line: 4, column: 2 })
  },
  {
    name: "reports a duplicate member name with line, column and pointer",
    run: () => text("poppy", '{"protocol_version":"0.3","protocol_version":"0.3","organization":{"name":"A","domain":"a.example"},"web":{}}'),
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
    run: () => text("poppy", withPoppy((d) => (d.protocol_version = "3"))),
    ids: { contains: ["version-format"] }
  },
  {
    name: "chooses rules by protocol_version: an unsupported major version",
    run: () => text("poppy", withPoppy((d) => (d.protocol_version = "1.0"))),
    ids: ["version-unsupported-major"],
    also: (report) => expect(report.messages[0]!.text).toMatch(/version 1\.0/)
  },
  {
    name: "refuses a newer pre-1.0 version before checking its fields",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.protocol_version = "0.7";
        d.loyalty = { tier: "gold" };
      })),
    ids: ["version-unsupported"],
    outcome: "invalid"
  },
  {
    // Before 1.0 every version can break the one before (3.1), and 0.3 is the only one checked.
    name: "refuses a 0.2 document, which this validator no longer checks",
    run: () => text("poppy", withPoppy((d) => (d.protocol_version = "0.2"))),
    ids: ["version-unsupported"],
    outcome: "invalid",
    also: (report) => expect(report.messages[0]!.text).toBe("poppy.json is protocol version 0.2; this validator supports 0.3.")
  },
  {
    name: "chooses rules by protocol_version: none given",
    run: () => text("poppy", withPoppy((d) => delete d.protocol_version)),
    ids: ["missing-member"],
    also: (report) => expect(report.checkedAgainst).toBe("Draft 0.3")
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
    name: "checks organization: a blank name is no display name, and our client refuses it",
    run: () => text("poppy", withPoppy((d) => (d.organization.name = "  "))),
    ids: ["organization-name-missing"],
    outcome: "invalid",
    also: (report) => expect(report.refused).toBe(true)
  },
  {
    name: "checks organization: a URL as the domain",
    run: () => text("poppy", withPoppy((d) => (d.organization.domain = "https://example.com/"))),
    ids: { contains: ["domain-invalid"] }
  },
  {
    name: "checks organization: a domain other than the one that served it",
    run: () => text("poppy", SPEC_POPPY, { domain: "evil.example" }),
    ids: ["organization-domain-mismatch"]
  },
  {
    // 3.1: "Domains are compared ignoring case, with no other normalization."
    name: "checks organization: compares the domain ignoring case only, so a leading www. counts",
    run: () => text("poppy", SPEC_POPPY, { domain: "www.example.com" }),
    ids: ["organization-domain-mismatch"],
    also: () => expect(ids(text("poppy", SPEC_POPPY, { domain: "EXAMPLE.com" }))).toEqual([])
  },
  {
    name: "accepts a website-only Company, with a note",
    run: () => text("poppy", WEBSITE_ONLY),
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
    name: "checks the issuer: a URL with no usable host",
    run: () => text("poppy", withPoppy((d) => (d.auth.issuer = "https://."))),
    ids: ["not-a-url"],
    outcome: "invalid"
  },
  {
    name: "checks the issuer: not a URL",
    run: () => text("poppy", withPoppy((d) => (d.auth.issuer = "auth.example.com"))),
    ids: ["not-a-url"]
  },
  {
    name: "checks scope descriptions and hints: names that aren't OAuth scopes, and a description that isn't a string",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.auth.scopes["bad scope"] = "Everything";
        d.auth.scopes.loyalty = 7;
        d.auth.scope_hints["bad\"hint"] = { changes: "none", personal_data: false };
      })),
    ids: ["scope-syntax", "wrong-type", "scope-syntax"]
  },
  {
    name: "warns of an extension version written as a number, whose type the draft doesn't give (N22)",
    run: () => text("poppy", withPoppy((d) => (d.extensions.operations = { version: 2 }))),
    ids: ["extension-version-number"],
    outcome: "valid",
    also: (report) => expect(report.refused).toBe(false)
  },
  {
    name: "checks Mediated Sign-In's scopes: a duplicate and a name that isn't an OAuth scope",
    run: () => text("poppy", withPoppy((d) => (d.extensions["mediated-sign-in"].scopes = ["orders:read", "orders:read", "bad scope"]))),
    ids: ["scope-duplicate", "scope-syntax"],
    also: (report) => expect(report.messages.map((m) => m.pointer)).toEqual(["/extensions/mediated-sign-in/scopes/1", "/extensions/mediated-sign-in/scopes/2"])
  },
  {
    name: "checks Mediated Sign-In's scopes: none",
    run: () => text("poppy", withPoppy((d) => (d.extensions["mediated-sign-in"].scopes = []))),
    ids: ["scopes-empty"]
  },
  {
    name: "checks Mediated Sign-In's fields: none",
    run: () => text("poppy", withPoppy((d) => (d.extensions["mediated-sign-in"].fields = []))),
    ids: ["mediated-fields-empty"],
    also: (report) => expect(report.messages[0]!.text).toBe("extensions.mediated-sign-in.fields is empty.")
  },
  {
    name: "checks Mediated Sign-In's fields: secret missing, looks secret, duplicate",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.extensions["mediated-sign-in"].fields = [
          { name: "email", label: "Email" },
          { name: "pin", label: "PIN", secret: false },
          { name: "email", label: "Email again", secret: false }
        ];
      })),
    ids: ["mediated-secret-missing", "mediated-looks-secret", "mediated-field-duplicate"]
  },
  {
    // 0.3 removed `resource` from agent.protocols and apis (4.5): it's an unknown member now.
    name: "checks the agent's protocols, and notes a resource, which 0.3 removed",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.agent.protocols = [{ type: "example.com/chat", endpoint: "https://api.example.com/chat", resource: "https://api.example.com" }];
      })),
    ids: ["protocol-type-unknown", "unknown-member", "no-poppy-protocol"],
    also: (report) => expect(report.messages[1]!.pointer).toBe("/agent/protocols/0/resource")
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
          { type: "mcp", url: "https://mcp.example.com/mcp", description: "Search", resource: "https://mcp.example.com/mcp" }
        ];
      })),
    ids: ["api-type-unknown", "api-description-missing", "unknown-member"],
    // A normative statement without a key word ("a short description") is an error, but one
    // our client tolerates: it still uses the Company. Another API type is allowed (7).
    outcome: "invalid",
    also: (report) => {
      expect(report.messages.find((m) => m.id === "api-type-unknown")).toMatchObject({ severity: "info", refuses: false });
      expect(report.messages.find((m) => m.id === "api-description-missing")).toMatchObject({ basis: "Rule", severity: "error", refuses: false });
      expect(report.refused).toBe(false);
    }
  },
  {
    // 3: "Every URL this protocol defines or exchanges MUST be an HTTPS URL", which spec-issues N9 asked for.
    name: "requires an HTTPS API URL, as every URL the protocol defines",
    run: () => text("poppy", withPoppy((d) => (d.apis = [{ type: "openapi", url: "http://api.example.com/openapi.json", description: "Orders" }]))),
    ids: ["not-https-url"],
    outcome: "invalid",
    also: (report) => {
      expect(report.messages[0]).toMatchObject({ basis: "MUST", severity: "error", refuses: true });
      expect(report.messages[0]!.ref.label).toBe("Spec 7");
    }
  },
  {
    name: "warns of a fragment in an API URL, where no rule forbids one, and our client refuses it",
    run: () => text("poppy", withPoppy((d) => (d.apis[0].url = "https://api.example.com/openapi.json#x"))),
    ids: ["url-has-fragment-unstated"],
    outcome: "valid",
    also: (report) => expect(report.refused).toBe(true)
  },
  {
    name: "checks extensions: names and versions",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.extensions = {
          operations: { version: "2" },
          "example.com/gift-wrap": { version: "2", anything: true },
          "gift-wrap": { version: "1" },
          "notadomain/gift-wrap": { version: "1" },
          "example.com/no-version": {}
        };
      })),
    ids: ["extension-plain-unknown", "extension-name", "missing-member"]
  },
  {
    // Operations 2 has no endpoint: 0.3 removed the operations endpoint and resource.
    name: "notes an Operations 2 entry with an endpoint, which version 2 doesn't have",
    run: () => text("poppy", withPoppy((d) => (d.extensions.operations = { version: "2", endpoint: "https://api.example.com/poppy/operations" }))),
    ids: ["unknown-member"],
    outcome: "valid"
  },
  {
    name: "refuses a Mediated Sign-In field named like a grant parameter",
    run: () => text("poppy", withPoppy((d) => (d.extensions["mediated-sign-in"].fields[0].name = "scope"))),
    ids: ["mediated-field-reserved"],
    outcome: "invalid"
  },
  {
    name: "refuses a scope hint without both fields, and notes a changes value it doesn't define",
    run: () =>
      text("poppy", withPoppy((d) => {
        d.auth.scope_hints["orders:read"] = { changes: "none" };
        d.auth.scope_hints.addresses = { changes: "sometimes", personal_data: true };
      })),
    ids: ["scope-hint-invalid", "scope-hint-changes-unknown"],
    outcome: "invalid"
  }
];

const DISCOVERY: readonly Fixture[] = [
  {
    name: "refuses a document a redirect moved off the well-known path",
    run: () =>
      company({
        routes: {
          "https://example.com/.well-known/poppy.json": () => new Response(null, { status: 302, headers: { Location: "https://example.com/uploads/poppy.json" } }),
          "https://example.com/uploads/poppy.json": jsonResponse(SPEC_POPPY)
        }
      }),
    ids: ["poppy-redirect-path"],
    outcome: "invalid"
  },
  {
    // 3: the document speaks for the host that served it, after any redirects.
    name: "compares organization.domain with the host a redirect ended at",
    run: () =>
      company({
        routes: {
          "https://example.com/.well-known/poppy.json": () => new Response(null, { status: 302, headers: { Location: "https://www.example.com/.well-known/poppy.json" } }),
          "https://www.example.com/.well-known/poppy.json": jsonResponse(SPEC_POPPY)
        }
      }),
    ids: ["organization-domain-mismatch"],
    outcome: "invalid",
    also: (report) => expect(report.messages[0]!.text).toBe("organization.domain is example.com, but the document was served by www.example.com.")
  },
  {
    name: "refuses protected resource metadata for another resource",
    run: () => company({ prm: { ...SPEC_PRM, resource: "https://example.com/api" } }),
    ids: ["prm-resource-mismatch"],
    outcome: "invalid"
  },
  {
    name: "refuses protected resource metadata with no authorization server",
    run: () => company({ prm: { ...SPEC_PRM, authorization_servers: [] } }),
    ids: ["prm-no-issuer"],
    outcome: "invalid"
  },
  {
    name: "refuses an auth.issuer the domain doesn't list",
    run: () => company({ poppy: (doc) => { doc.auth.issuer = "https://auth.example.org"; } }),
    ids: ["issuer-not-listed"],
    outcome: "invalid"
  },
  {
    name: "refuses several authorization servers without auth.issuer, and uses auth.issuer when it chooses one",
    run: () => company({ prm: { ...SPEC_PRM, authorization_servers: ["https://auth.example.com", "https://staff.example.com"] } }),
    ids: ["issuer-ambiguous"],
    outcome: "invalid",
    also: async () => {
      const chosen = await company({ prm: { ...SPEC_PRM, authorization_servers: ["https://staff.example.com", "https://auth.example.com"] }, poppy: (doc) => { doc.auth.issuer = "https://auth.example.com"; } });
      expect(chosen.messages).toEqual([]);
      expect(chosen.issuer).toBe("https://auth.example.com");
    }
  },
  {
    name: "checks pasted protected resource metadata",
    run: () => text("protected-resource", { resource: "https://example.com", authorization_servers: [] }),
    ids: ["prm-no-issuer"],
    outcome: "invalid"
  }
];

const METADATA: readonly Fixture[] = [
  {
    name: "requires the issuer to match exactly, so a trailing slash doesn't",
    run: () => company({ metadata: (doc) => { doc.issuer = "https://auth.example.com/"; } }),
    ids: { contains: ["metadata-issuer-mismatch"] },
    outcome: "invalid"
  },
  {
    name: "refuses issuer metadata whose protected_resources leaves out the domain, compared exactly but for the host's case",
    run: () => company({ metadata: (doc) => { doc.protected_resources = ["https://example.com/", "https://EXAMPLE.co.uk"]; } }),
    ids: ["metadata-protected-resources"],
    outcome: "invalid",
    also: async () => {
      expect((await company({ metadata: (doc) => { doc.protected_resources = ["https://EXAMPLE.com"]; } })).messages).toEqual([]);
    }
  },
  {
    name: "requires grant_types_supported, with refresh_token",
    run: () => company({ metadata: (doc) => { doc.grant_types_supported = ["authorization_code", "https://personalagentprotocol.org/grant/mediated-sign-in"]; delete doc.device_authorization_endpoint; } }),
    ids: ["metadata-refresh-grant"],
    outcome: "invalid"
  },
  {
    name: "requires the endpoint each sign-in grant needs",
    run: () => company({ metadata: (doc) => { delete doc.authorization_endpoint; delete doc.device_authorization_endpoint; } }),
    ids: ["missing-member", "missing-member"],
    outcome: "invalid",
    also: (report) => expect(report.messages.map((m) => m.pointer)).toEqual(["/authorization_endpoint", "/device_authorization_endpoint"])
  },
  {
    name: "requires scopes_supported when the Company offers sign-in",
    run: () => company({ metadata: (doc) => { delete doc.scopes_supported; } }),
    ids: ["missing-member"],
    outcome: "invalid",
    also: (report) => expect(report.messages[0]!.pointer).toBe("/scopes_supported")
  },
  {
    name: "refuses Mediated Sign-In without its grant, or with scopes the issuer doesn't support",
    run: () =>
      company({
        poppy: (doc) => { doc.extensions["mediated-sign-in"].scopes = ["orders:read", "gift-cards"]; },
        metadata: (doc) => { doc.grant_types_supported = doc.grant_types_supported.filter((grant: string) => !grant.endsWith("mediated-sign-in")); }
      }),
    ids: ["mediated-grant-missing", "mediated-scope-unsupported"],
    outcome: "invalid"
  },
  {
    // 4.7: described in an OpenAPI description poppy.json lists, or otherwise in auth.scopes.
    name: "requires auth.scopes to describe each supported scope when no OpenAPI description could",
    run: () =>
      company({
        poppy: (doc) => { doc.apis = doc.apis.filter((api: { type: string }) => api.type !== "openapi"); },
        metadata: (doc) => { doc.scopes_supported.push("loyalty"); }
      }),
    ids: ["scope-undescribed"],
    outcome: "invalid",
    also: async (report) => {
      expect(report.messages[0]!.pointer).toBe("/scopes_supported/3");
      // With an OpenAPI description listed, it may describe the scope: nothing to say.
      expect((await company({ metadata: (doc) => { doc.scopes_supported.push("loyalty"); } })).messages).toEqual([]);
    }
  },
  {
    name: "notes what agents can't use in the advertised capabilities",
    run: () =>
      company({
        metadata: (doc) => {
          doc.dpop_signing_alg_values_supported = ["RS256"];
          doc.code_challenge_methods_supported = ["plain"];
          delete doc.authorization_response_iss_parameter_supported;
        }
      }),
    ids: ["metadata-dpop-alg", "metadata-pkce", "metadata-iss-parameter"],
    outcome: "valid"
  },
  {
    name: "notes poppy_domains, which 0.3 replaced with protected_resources, and an Operations version it doesn't know",
    run: () => company({ poppy: (doc) => { doc.extensions.operations = { version: "1", endpoint: "https://api.example.com/poppy/operations" }; }, metadata: (doc) => { doc.poppy_domains = ["example.com"]; } }),
    ids: ["extension-version-unknown", "unknown-member"],
    outcome: "valid"
  },
  {
    name: "finds metadata for an issuer with a path (RFC 8414 §3.1)",
    run: () =>
      company({
        prm: { ...SPEC_PRM, authorization_servers: ["https://auth.example.com/tenant/"] },
        routes: {
          "https://auth.example.com/.well-known/oauth-authorization-server/tenant": jsonResponse({ ...SPEC_METADATA, issuer: "https://auth.example.com/tenant/" })
        }
      }),
    ids: [],
    outcome: "valid",
    also: (report) => expect((report as CompanyReport).issuer).toBe("https://auth.example.com/tenant/")
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
    // 4.1: an HTTPS URL on client_id's domain, or a loopback redirect URI as RFC 8252 §7.3 defines.
    name: "accepts loopback redirect URIs on any port, but not localhost, which RFC 8252 doesn't recommend",
    run: () =>
      text("client-metadata", {
        ...SPEC_CLIENT,
        redirect_uris: ["https://agent.example/oauth/callback", "http://127.0.0.1/callback", "http://[::1]:8080/cb", "http://localhost:8080/cb", "http://127.0.0.1/cb#x"]
      }),
    ids: ["not-https-url", "url-has-fragment"],
    also: (report) => expect(report.messages.map((m) => m.pointer)).toEqual(["/redirect_uris/3", "/redirect_uris/4"])
  },
  {
    name: "requires an HTTPS logo_uri, as every URL in client metadata",
    run: () => text("client-metadata", { ...SPEC_CLIENT, logo_uri: "http://agent.example/logo.png" }),
    ids: ["not-https-url"],
    outcome: "invalid"
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
          { ...EC_KEY, kid: "k1" },
          { kty: "RSA", n: RSA_N, e: "AQAB", kid: "k6", alg: "PS384" },
          { kty: "RSA", n: RSA_N, e: "AQAB", kid: "k7", alg: "RS256" }
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
      "jwks-kid-duplicate",
      "jwks-alg"
    ],
    // PS384 is one of the two algorithms Companies must accept (4.1); RS256 can't sign a delegation (5.2).
    also: (report) => expect(report.messages.filter((m) => m.id === "jwks-alg").map((m) => m.pointer)).toEqual(["/keys/4/alg", "/keys/8/alg"])
  },
  {
    name: "requires at least one key",
    run: () => text("jwks", { keys: [] }),
    ids: ["jwks-empty"]
  },
  {
    // 5.3: Companies fetch client_id without following redirects, as the CIMD draft requires.
    name: "refuses a client_id that redirects, as Companies do",
    run: () =>
      validateClient(
        network({ "https://agent.example/agent.json": () => new Response(null, { status: 302, headers: { Location: "https://agent.example/v2.json" } }) }),
        "https://agent.example/agent.json"
      ),
    ids: ["http-redirect-not-allowed"],
    outcome: "indeterminate",
    also: (report) => expect(report.messages[0]).toMatchObject({ basis: "Rule", severity: "error", refuses: true })
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
    ids: ["http-too-many-redirects"],
    // A Guides limit: a warning, but the document wasn't fetched, so nothing was checked, and our client refuses it.
    outcome: "indeterminate",
    also: (report) => expect(report.refused).toBe(true)
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
    ids: ["http-too-large"],
    outcome: "indeterminate"
  },
  {
    name: "checks encoding",
    run: () => fetchOne(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } })),
    ids: ["not-utf8"]
  },
  {
    name: "checks content type and caching headers",
    run: () => fetchOne(() => new Response(JSON.stringify(WEBSITE_ONLY), { headers: { "Content-Type": "text/plain" } })),
    ids: ["http-content-type", "http-no-cache-headers", "website-only"]
  },
  {
    name: "checks a cache lifetime is bounded",
    run: () => fetchOne(jsonResponse(WEBSITE_ONLY, { "Cache-Control": "max-age=5" })),
    ids: { contains: ["http-cache-bounded"] }
  },
  {
    name: "refuses non-HTTPS",
    run: () => validateClient(network({}), "http://agent.example/agent.json"),
    ids: ["http-not-https"]
  },
  {
    // 3: "MUST NOT connect to a loopback, private, or link-local address" a party gave them.
    name: "refuses private hosts",
    run: () => validateClient(network({}), "https://localhost/agent.json"),
    ids: ["http-non-public-host"],
    outcome: "indeterminate",
    also: (report) => expect(report.messages[0]).toMatchObject({ basis: "MUST", severity: "error", refuses: true })
  },
  {
    name: "refuses special-use and private-use names, such as .internal and .home.arpa",
    run: () => validateClient(network({}), "https://metadata.google.internal/agent.json"),
    ids: ["http-non-public-host"],
    outcome: "indeterminate"
  },
  {
    // The CLI's fetcher (scripts/node-fetcher.ts) throws this when a public-looking name resolves to a private address.
    name: "refuses a name a fetcher found resolves to a private address",
    run: () =>
      validateCompany(async (request) => {
        throw new NonPublicAddressError(new URL(request.url).hostname, "169.254.169.254");
      }, "169.254.169.254.nip.io"),
    ids: ["http-non-public-address"],
    outcome: "indeterminate",
    also: (report) => {
      expect(report.refused).toBe(true);
      expect(report.messages[0]!.text).toBe(
        "169.254.169.254.nip.io resolves to 169.254.169.254, which isn't a public address, so https://169.254.169.254.nip.io/.well-known/poppy.json wasn't fetched."
      );
    }
  },
  {
    name: "refuses non-domains",
    run: () => validateCompany(network({}), "not a domain"),
    ids: ["domain-invalid"]
  }
];

describe("valid documents", () => testEach(VALID));
describe("poppy.json", () => testEach(POPPY_JSON));
describe("discovery: the issuer from the domain's protected resource metadata", () => testEach(DISCOVERY));
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
      expect(report.messages[0]!.text).toContain(`Fetching ${wellKnown} timed out after 10 seconds.`);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out before headers even if the fetcher ignores abort, and cancels its eventual response", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    try {
      const pending = validateCompany(() => new Promise((resolve) => { release = resolve; }), "example.com");
      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);
      const report = await pending;
      expect(ids(report)).toEqual(["http-failed"]);
      expect(report.outcome).toBe("indeterminate");
      expect(report.messages[0]!.text).toContain("timed out after 10 seconds");
      release(new Response(new ReadableStream({ cancel })));
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an already-aborted buffered response", async () => {
    const deadline = new AbortController();
    const reason = new DOMException("Expired", "TimeoutError");
    deadline.abort(reason);
    await expect(readLimited(Response.json({ accepted: true }), LIMITS.maxBytes, deadline.signal)).rejects.toBe(reason);
  });

  it("refuses a buffered read that completes in the same turn as abort", async () => {
    const deadline = new AbortController();
    const reason = new DOMException("Expired", "TimeoutError");
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
        deadline.abort(reason);
      }
    }));
    await expect(readLimited(response, LIMITS.maxBytes, deadline.signal)).rejects.toBe(reason);
  });

  it.each(["pending source cancellation", "a clone reader"] as const)("reports a body timeout without waiting for %s", async (mode) => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; controller.enqueue(new TextEncoder().encode("{")); },
      cancel
    }), { headers: { "Content-Type": "application/json" } });
    // Match the harness's detached JSON observer: cancelling one tee branch
    // cannot finish while its sibling is still consuming the stalled source.
    const clone = mode === "a clone reader" ? response.clone().text().catch(() => undefined) : undefined;
    try {
      const pending = validateCompany(async () => response, "example.com");
      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);
      const report = await pending;
      expect(ids(report)).toEqual(["http-failed"]);
      expect(report.outcome).toBe("indeterminate");
      expect(report.messages[0]!.text).toContain("timed out after 10 seconds");
      expect(cancel).toHaveBeenCalledTimes(clone ? 0 : 1);
    } finally {
      if (clone) { source.close(); await clone; }
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "declared oversize", status: 200, headers: new Headers({ "Content-Length": String(LIMITS.maxBytes + 1) }), bytes: 1, message: "http-too-large" },
    { name: "streamed oversize", status: 200, headers: new Headers(), bytes: LIMITS.maxBytes + 1, message: "http-too-large" },
    { name: "redirect", status: 302, headers: new Headers({ Location: "https://elsewhere.example/poppy.json" }), bytes: 1, message: "http-redirect-not-allowed" },
    { name: "HTTP error", status: 503, headers: new Headers(), bytes: 1, message: "http-status" }
  ])("keeps the $name verdict even if discarding its body never finishes", async ({ status, headers, bytes, message }) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(bytes)); },
      cancel
    }), { status, headers });
    const checker = new Checker("poppy");
    const result = await fetchDocument(async () => response, wellKnown, checker, { followRedirects: false });
    expect(result.text).toBeUndefined();
    expect(checker.messages.map((entry) => entry.id)).toEqual([message]);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("which hosts and addresses are public (Guides, 'Fetching metadata safely')", () => {
  it("refuses by name: IP literals, single labels, and special-use and private-use names", () => {
    const refused = [
      "127.0.0.1",
      "[::1]",
      "localhost",
      "intranet",
      "foo.localhost",
      "printer.local",
      "printer.local.",
      "router.home.arpa",
      "1.0.0.127.in-addr.arpa",
      "ipv4only.arpa",
      "metadata.google.internal",
      "INTERNAL.Example.internal",
      "x.invalid",
      "abc.onion",
      "x.alt",
      "nas.lan",
      "mail.corp",
      "box.home",
      "wiki.intranet",
      "db.private"
    ];
    for (const host of refused) expect(isPublicHost(new URL(`https://${host}/`)), host).toBe(false);
    // Names alone can't tell where these resolve: the address check is the fetcher's (below).
    const byName = ["example.com", "localtest.me", "127.0.0.1.nip.io", "169.254.169.254.nip.io", "company.interop.test", "local.example.com", "internal.example.com", "arpa.example"];
    for (const host of byName) expect(isPublicHost(new URL(`https://${host}/`)), host).toBe(true);
  });

  it("classifies resolved addresses: loopback, RFC 1918, link-local, CGNAT, ULA, mapped, unspecified and multicast are not public", () => {
    const notPublic = [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "224.0.0.1",
      "239.255.255.250",
      "255.255.255.255",
      "192.0.0.170",
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%en0",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.1.2.3",
      "::ffff:169.254.169.254",
      "::ffff:100.64.0.1",
      "64:ff9b::192.168.0.1",
      "2002:c0a8:0101::1",
      "::127.0.0.1",
      "2001:db8::1",
      "not an address",
      "1.2.3",
      "256.1.1.1"
    ];
    for (const address of notPublic) expect(isPublicAddress(address), address).toBe(false);
    const isPublic = ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "169.253.0.1", "2606:4700::1111", "2001:4860:4860::8888", "::ffff:1.1.1.1", "64:ff9b::808:808"];
    for (const address of isPublic) expect(isPublicAddress(address), address).toBe(true);
  });

  it("reads IPv6 in its short, full and mixed forms alike", () => {
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("0:0:0:0:0:ffff:7f00:1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("[fe80::1]")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    for (const bad of ["1::2::3", "1:2:3:4:5:6:7:8:9", "12345::", "::ffff:300.0.0.1", "1:2:3:4:5:6:7"]) expect(parseIPv6(bad), bad).toBeNull();
  });

  // The CLI's fetcher (scripts/node-fetcher.ts) hands this lookup to Node's https.request, with the system resolver in place of `resolve`.
  describe("the CLI's pinned lookup", () => {
    const lookupOf = (answers: Record<string, readonly { address: string; family: 4 | 6 }[]>) => {
      const asked: string[] = [];
      const lookup = pinnedLookup(async (hostname) => {
        asked.push(hostname);
        return answers[hostname] ?? [];
      });
      const run = (hostname: string, options: { all?: boolean } = {}) =>
        new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) => lookup(hostname, options, (error, address, family) => resolve({ error, address, family })));
      return { run, asked };
    };

    it("refuses a public-looking name that resolves to a private address, before any connection", async () => {
      const { run } = lookupOf({ "127.0.0.1.nip.io": [{ address: "127.0.0.1", family: 4 }], "169.254.169.254.nip.io": [{ address: "169.254.169.254", family: 4 }] });
      for (const host of ["127.0.0.1.nip.io", "169.254.169.254.nip.io"]) {
        const { error } = await run(host);
        expect(error, host).toBeInstanceOf(NonPublicAddressError);
        expect((error as NonPublicAddressError).hostname).toBe(host);
      }
    });

    it("refuses a name when any of its addresses isn't public, so a mixed answer can't pick the private one", async () => {
      const { run } = lookupOf({ "mixed.example": [{ address: "93.184.216.34", family: 4 }, { address: "::ffff:10.0.0.1", family: 6 }] });
      const { error } = await run("mixed.example");
      expect((error as NonPublicAddressError).address).toBe("::ffff:10.0.0.1");
    });

    it("hands the connection exactly the addresses it checked, resolving once per connection", async () => {
      const { run, asked } = lookupOf({ "public.example": [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }] });
      expect(await run("public.example")).toEqual({ error: null, address: "93.184.216.34", family: 4 });
      expect(await run("public.example", { all: true })).toEqual({
        error: null,
        address: [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:2800:220:1::1", family: 6 }
        ],
        family: undefined
      });
      expect(asked).toEqual(["public.example", "public.example"]);
    });

    it("fails a name with no address, or whose lookup fails", async () => {
      const { run } = lookupOf({});
      expect((await run("nowhere.example")).error?.message).toBe("nowhere.example has no address");
      const failing = pinnedLookup(async () => {
        throw new Error("SERVFAIL");
      });
      const error = await new Promise<Error | null>((resolve) => failing("x.example", {}, (e) => resolve(e)));
      expect(error?.message).toBe("SERVFAIL");
    });
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
    expect(report).toMatchObject({ outputVersion: 1, outcome: "valid", checkedAgainst: "Draft 0.3" });
    const preflight = await call("/validator/api", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    const bad = await call("/validator/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document: "{}", kind: "feed" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/kind must be/);
  });

  it("answers the form with an escaped results page", async () => {
    const response = await call("/validator", {
      method: "POST",
      body: new URLSearchParams({ document: '{"protocol_version":"0.3","organization":{"name":"<script>alert(1)</script>","domain":"a.example"},"agent":{}}', kind: "poppy" })
    });
    const page = await response.text();
    expect(page).toContain("Not valid");
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&#60;script&#62;");
  });

  it("checks a URL, within the caller's rate limit", async () => {
    const host = await mockCompany({ unknownApi: false });
    const request = () => new Request(`https://agent.test/validator/api?url=${host}`);
    const allowed = await handleValidator(request(), { fetcher: testFetcher(env), allowFetch: async () => true });
    expect(((await allowed!.json()) as Report).outcome).toBe("valid");
    const limited = await handleValidator(request(), { fetcher: testFetcher(env), allowFetch: async () => false });
    expect(limited!.status).toBe(429);
  });
});

describe("the message catalog", () => {
  const fixtures = [...VALID, ...POPPY_JSON, ...DISCOVERY, ...METADATA, ...CLIENT, ...FETCHING];

  it("has a fixture that produces every message", () => {
    const declared = new Set(fixtures.flatMap(declaredIds));
    // Retired diagnostics, kept for saved reports and never emitted.
    const retired = new Set<MessageId>(["version-newer-minor", "api-type-newer"]);
    const missing = (Object.keys(MESSAGES) as MessageId[]).filter((id) => !declared.has(id) && !retired.has(id));
    expect(missing).toEqual([]);
  });

  it("has fixtures with distinct names", () => {
    const names = fixtures.map((fixture) => fixture.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  // docs/conformance-levels.md: a MUST, an RFC's MUST or a keyword-less rule is an error; a
  // SHOULD, the Guides or our reading a warning; a message reporting a fact (note) is info.
  it("derives each message's severity from its basis", () => {
    const entries = Object.entries(MESSAGES) as [MessageId, (typeof MESSAGES)[MessageId]][];
    const wrong = entries.filter(([, m]) => m.severity !== ("note" in m && m.note ? "info" : severityOf(levelOf(m.basis))));
    expect(wrong.map(([id]) => id)).toEqual([]);
    // Nothing optional is reported against the document that takes the option.
    expect(entries.filter(([, m]) => (m.basis as string) === "MAY").map(([id]) => id)).toEqual([]);
  });

  it("refuses over every error but those a reader is told to tolerate, and names the warnings it refuses", () => {
    const entries = Object.entries(MESSAGES) as [MessageId, (typeof MESSAGES)[MessageId]][];
    expect(entries.filter(([, m]) => m.severity === "error" && !m.refuses).map(([id]) => id)).toEqual(["json-bom", "api-description-missing"]);
    // Refused warnings guard against a hostile or unusable document; each says so in its explanation.
    const refusedWarnings = entries.filter(([, m]) => m.severity !== "error" && m.refuses);
    expect(refusedWarnings.map(([id]) => id)).toEqual([
      "http-too-many-redirects",
      "http-failed",
      "http-too-large",
      "json-resource-limit",
      "json-duplicate-member",
      "url-has-fragment-unstated",
      "mediated-fields-empty"
    ]);
    for (const [id, m] of refusedWarnings) expect(m.explain, id).toMatch(/our client|nothing was checked/i);
  });
});
