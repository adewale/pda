/**
 * Generated Companies: a poppy.json, its domain's protected resource
 * metadata and its issuer's OAuth metadata that draft 0.3 calls valid, built
 * directly (not filtered from noise), and a fetcher that serves them as a
 * Company's hosts would.
 */
import { metadataUrl } from "../../src/validator/fetch";
import { gs } from "./hegel";

/** RFC 6749 scope-token characters: %x21 / %x23-5B / %x5D-7E. */
export const SCOPE_ALPHABET = String.fromCharCode(
  0x21,
  ...Array.from({ length: 0x5b - 0x23 + 1 }, (_, i) => 0x23 + i),
  ...Array.from({ length: 0x7e - 0x5d + 1 }, (_, i) => 0x5d + i)
);

/** A Company's scope: 0.3 defines none (4.7), so any scope token, 0.2's `poppy:` names included. */
export const scopeNames = gs.oneOf(gs.text({ alphabet: SCOPE_ALPHABET, minSize: 1, maxSize: 16 }), gs.sampledFrom(["orders:read", "orders:write", "addresses", "poppy:read"]));

/**
 * A DNS name: Hegel's `domains()` draws names up to 255 characters, but a
 * name in text is at most 253 (RFC 1035's 255 octets on the wire).
 */
export const hosts = gs.domains({ maxLength: 253 });

/** A path for an endpoint: zero or more segments of URL-safe characters. */
const paths = gs.arrays(gs.fromRegex("[A-Za-z0-9_.~-]{1,10}", { fullmatch: true }).filter((segment) => segment !== "." && segment !== ".."), { maxSize: 3 }).map(
  (segments) => segments.map((segment) => `/${segment}`).join("")
);

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in";

export type GeneratedCompany = {
  /** What the User typed: the domain, in any case, maybe with `www.`. */
  readonly requested: string;
  /** `organization.domain`. */
  readonly domain: string;
  /** The Company's issuer, which its domain's protected resource metadata names (3.2). */
  readonly issuer: string;
  readonly poppy: Record<string, any>;
  /** `https://{domain}/.well-known/oauth-protected-resource` (3.2, RFC 9728). */
  readonly resource: Record<string, any>;
  readonly metadata: Record<string, any>;
};

export const companies = gs.composite<GeneratedCompany>((tc) => {
  const host = tc.draw(hosts);
  // `www.` only where the name stays a DNS name, at most 253 characters.
  const www = host.length <= 249 && tc.draw(gs.booleans());
  // organization.domain is the host that serves the document (3.1): `www.` included when it does.
  const domain = `${www ? "www." : ""}${host}`;
  const requested = tc.draw(gs.booleans()) ? domain.toUpperCase() : domain;
  const authHost = tc.draw(gs.oneOf(gs.just(`auth.${host}`), gs.just(host), hosts));
  const issuer = `https://${authHost}${tc.draw(paths)}${tc.draw(gs.booleans()) ? "/" : ""}`;
  const at = (path: string) => `https://${authHost}${path}`;
  const api = `https://${tc.draw(gs.sampledFrom(["api.", "", "www."]))}${host}`;

  // Every scope the issuer supports, each described in auth.scopes (4.7), some with hints.
  const scopes = [...tc.draw(gs.sets(scopeNames, { minSize: 1, maxSize: 4 }))];
  const auth: Record<string, unknown> = {
    // With one authorization server, auth.issuer is optional, and names that server when present (3.1).
    ...(tc.draw(gs.booleans()) ? { issuer } : {}),
    scopes: Object.fromEntries(scopes.map((scope) => [scope, tc.draw(gs.text({ maxSize: 40 }))]))
  };
  const hinted = scopes.filter(() => tc.draw(gs.booleans()));
  if (hinted.length) {
    auth.scope_hints = Object.fromEntries(hinted.map((scope) => [scope, { changes: tc.draw(gs.sampledFrom(["none", "reversible", "irreversible"])), personal_data: tc.draw(gs.booleans()) }]));
  }
  const types = [...tc.draw(gs.sets(gs.sampledFrom(["direct", "device", "mediated"] as const)))];

  const poppy: Record<string, any> = {
    protocol_version: "0.3",
    // A display name (3.1): anything with something to show. A blank one is organization-name-missing, an error.
    organization: { name: tc.draw(gs.text({ minSize: 1, maxSize: 40 }).filter((name) => name.trim() !== "")), domain },
    auth
  };
  const unknownProtocol = { type: "example.com/chat-v9", endpoint: `${api}/chat` };
  const poppyProtocol = { type: "poppy", endpoint: `${api}/poppy/conversations${tc.draw(paths)}` };
  // Something that needs the issuer (3.2), so the Company isn't website only: the agent, an API or a browser join.
  const offers = tc.draw(gs.sets(gs.sampledFrom(["agent", "apis", "web"] as const), { minSize: 1 }));
  if (offers.has("agent")) poppy.agent = { protocols: tc.draw(gs.booleans()) ? [unknownProtocol, poppyProtocol] : [poppyProtocol] };
  if (offers.has("apis")) {
    poppy.apis = tc.draw(
      gs.arrays(
        gs.composite((inner) => {
          // 0.3 lets a Company list other API types, which agents skip (7).
          const type = inner.draw(gs.sampledFrom(["openapi", "mcp", "graphql"]));
          return { type, url: `${api}${inner.draw(paths)}/${type}`, description: inner.draw(gs.text({ minSize: 1, maxSize: 30 })) };
        }),
        { minSize: 1, maxSize: 3 }
      )
    );
  }
  if (offers.has("web")) poppy.web = { browser_session_endpoint: `https://${domain}/poppy/browser-session` };
  if (tc.draw(gs.booleans())) poppy.feedback = { endpoint: `${api}/poppy/feedback${tc.draw(paths)}` };
  if (tc.draw(gs.booleans())) poppy.excluded_tasks = { url: `https://${domain}/poppy/excluded-tasks.json` };
  const extensions: Record<string, unknown> = {};
  if (tc.draw(gs.booleans())) extensions.operations = { version: "2" };
  if (types.includes("mediated")) {
    const names = [...tc.draw(gs.sets(gs.fromRegex("[a-z_]{1,12}", { fullmatch: true }).filter((name) => !["grant_type", "scope", "resource", "client_id", "client_assertion", "client_assertion_type", "sign_in_id", "one_time_code"].includes(name)), { minSize: 1, maxSize: 3 }))];
    extensions["mediated-sign-in"] = {
      version: "1",
      // Every field secret: a field that looks secret must be marked so, and secret is always allowed.
      fields: names.map((name) => ({ name, label: tc.draw(gs.text({ minSize: 1, maxSize: 20 })), secret: true })),
      scopes: [...tc.draw(gs.sets(gs.sampledFrom(scopes), { minSize: 1 }))]
    };
  }
  if (Object.keys(extensions).length) poppy.extensions = extensions;

  const resource = { resource: `https://${tc.draw(gs.booleans()) ? domain.toUpperCase() : domain}`, authorization_servers: [issuer] };

  const grants = ["refresh_token", ...(types.includes("direct") ? ["authorization_code"] : []), ...(types.includes("device") ? [DEVICE_GRANT] : []), ...(types.includes("mediated") ? [MEDIATED_GRANT] : [])];
  const metadata: Record<string, any> = {
    issuer,
    token_endpoint: at("/oauth/token"),
    revocation_endpoint: at("/oauth/revoke"),
    grant_types_supported: tc.draw(gs.booleans()) ? grants : [...grants].reverse(),
    scopes_supported: scopes,
    // The domain, with its host in any case (3.2), and maybe other resources, such as an MCP server.
    protected_resources: [`https://${tc.draw(gs.booleans()) ? domain.toUpperCase() : domain}`, ...tc.draw(gs.arrays(hosts, { maxSize: 2 })).map((other) => `https://${other}`)],
    ...(tc.draw(gs.booleans()) ? { dpop_signing_alg_values_supported: ["ES256"] } : {}),
    ...(types.includes("direct") ? { authorization_endpoint: at("/oauth/authorize"), authorization_response_iss_parameter_supported: true, code_challenge_methods_supported: ["S256"] } : {}),
    ...(types.includes("device") ? { device_authorization_endpoint: at("/oauth/device") } : {})
  };
  return { requested, domain, issuer, poppy, resource, metadata };
});

/** A Company's documents, valid or not, as `serving` serves them. */
export type Documents = { readonly requested: string; readonly domain: string; readonly poppy: unknown; readonly resource: unknown; readonly metadata: unknown };

/**
 * A fetcher that serves a Company's three documents, and nothing else:
 * poppy.json at the requested host, the protected resource metadata at the
 * domain poppy.json names, and the issuer's metadata at the issuer that
 * protected resource metadata names.
 */
export function serving(company: Documents) {
  const host = company.requested.toLowerCase();
  const named = (company.poppy as { organization?: { domain?: unknown } } | null)?.organization?.domain;
  const servers = (company.resource as { authorization_servers?: unknown } | null)?.authorization_servers;
  const issuer = Array.isArray(servers) ? servers[0] : undefined;
  const documents = new Map<string, unknown>([[`https://${host}/.well-known/poppy.json`, company.poppy]]);
  if (typeof named === "string" && URL.canParse(`https://${named}`)) documents.set(`https://${named.toLowerCase()}/.well-known/oauth-protected-resource`, company.resource);
  if (typeof issuer === "string" && URL.canParse(issuer)) documents.set(metadataUrl(issuer), company.metadata);
  const requests: string[] = [];
  const fetcher = async (request: Request) => {
    requests.push(request.url);
    const body = documents.get(request.url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  return { fetcher, requests };
}
