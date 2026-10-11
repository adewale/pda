/**
 * Generated Companies: a poppy.json and its issuer's OAuth metadata that
 * the draft calls valid, built directly (not filtered from noise), and a
 * fetcher that serves them as a Company's hosts would.
 */
import { metadataUrl } from "../../src/validator/fetch";
import { gs } from "./hegel";

/** RFC 6749 scope-token characters: %x21 / %x23-5B / %x5D-7E. */
export const SCOPE_ALPHABET = String.fromCharCode(
  0x21,
  ...Array.from({ length: 0x5b - 0x23 + 1 }, (_, i) => 0x23 + i),
  ...Array.from({ length: 0x7e - 0x5d + 1 }, (_, i) => 0x5d + i)
);

/** A Company's own scope: any scope token outside the reserved `poppy:` names. */
export const customScopes = gs.text({ alphabet: SCOPE_ALPHABET, minSize: 1, maxSize: 16 }).filter((scope) => !scope.startsWith("poppy:"));

/**
 * A DNS name: Hegel's `domains()` draws names up to 255 characters, but a
 * name in text is at most 253 (RFC 1035's 255 octets on the wire).
 */
export const hosts = gs.domains({ maxLength: 253 });

/** A path for an endpoint: zero or more segments of URL-safe characters. */
const paths = gs.arrays(gs.fromRegex("[A-Za-z0-9_.~-]{1,10}", { fullmatch: true }).filter((segment) => segment !== "." && segment !== ".."), { maxSize: 3 }).map(
  (segments) => segments.map((segment) => `/${segment}`).join("")
);

export type GeneratedCompany = {
  /** What the User typed: the domain, in any case, maybe with `www.`. */
  readonly requested: string;
  /** `organization.domain`. */
  readonly domain: string;
  readonly poppy: Record<string, any>;
  readonly metadata: Record<string, any>;
};

export const companies = gs.composite<GeneratedCompany>((tc) => {
  const domain = tc.draw(hosts);
  // `www.` only where the name stays a DNS name, at most 253 characters.
  const www = domain.length <= 249 && tc.draw(gs.booleans());
  const requested = `${www ? "www." : ""}${tc.draw(gs.booleans()) ? domain.toUpperCase() : domain}`;
  const authHost = tc.draw(gs.oneOf(gs.just(`auth.${domain}`), gs.just(domain), hosts));
  const issuer = `https://${authHost}${tc.draw(paths)}${tc.draw(gs.booleans()) ? "/" : ""}`;
  const at = (path: string) => `https://${authHost}${path}`;
  const api = `https://${tc.draw(gs.sampledFrom(["api.", "", "www."]))}${domain}`;

  const custom = [...tc.draw(gs.sets(customScopes, { maxSize: 3 }))];
  const all = ["poppy:read", "poppy:write", ...custom];
  const types = [...tc.draw(gs.sets(gs.sampledFrom(["direct", "device", "mediated"] as const), { minSize: 1 }))];
  const auth: Record<string, unknown> = { issuer };
  types.forEach((type, index) => {
    // The first type offers every scope, so each custom scope is offered somewhere.
    const scopes = index === 0 ? all : [...tc.draw(gs.sets(gs.sampledFrom(all), { minSize: 1 }))];
    if (type !== "mediated") {
      auth[type] = { scopes };
      return;
    }
    const names = [...tc.draw(gs.sets(gs.fromRegex("[a-z_]{1,12}", { fullmatch: true }), { minSize: 1, maxSize: 3 }))];
    auth.mediated = {
      endpoint: at(`/poppy/sign-in${tc.draw(paths)}`),
      // Every field secret: a field that looks secret must be marked so, and secret is always allowed.
      fields: names.map((name) => ({ name, label: tc.draw(gs.text({ minSize: 1, maxSize: 20 })), secret: true })),
      scopes
    };
  });
  if (custom.length > 0) {
    auth.custom_scopes = Object.fromEntries(custom.map((scope) => [scope, tc.draw(gs.text({ maxSize: 40 }))]));
  }

  const poppy: Record<string, any> = {
    protocol_version: `0.${tc.draw(gs.integers({ minValue: 0, maxValue: 1 }))}`,
    organization: { name: tc.draw(gs.text({ maxSize: 40 })), domain },
    auth
  };
  const unknownProtocol = { type: "example.com/chat-v9", endpoint: `${api}/chat` };
  const poppyProtocol = { type: "poppy", endpoint: `${api}/poppy/conversations${tc.draw(paths)}` };
  const offers = tc.draw(gs.sets(gs.sampledFrom(["agent", "apis", "web"] as const), { minSize: 1 }));
  if (offers.has("agent")) poppy.agent = { protocols: tc.draw(gs.booleans()) ? [unknownProtocol, poppyProtocol] : [poppyProtocol] };
  if (offers.has("apis")) {
    poppy.apis = tc.draw(
      gs.arrays(
        gs.composite((inner) => {
          const type = inner.draw(gs.sampledFrom(["openapi", "mcp", "graphql"]));
          return { type, url: `${api}${inner.draw(paths)}/${type}`, description: inner.draw(gs.text({ minSize: 1, maxSize: 30 })) };
        }),
        { minSize: 1, maxSize: 3 }
      )
    );
  }
  if (offers.has("web")) poppy.web = tc.draw(gs.booleans()) ? { browser_session_endpoint: `https://${domain}/poppy/browser-session` } : {};
  if (tc.draw(gs.booleans())) poppy.extensions = { operations: { version: "1", endpoint: `${api}/poppy/operations${tc.draw(paths)}` } };

  const metadata: Record<string, any> = {
    issuer,
    token_endpoint: at("/oauth/token"),
    revocation_endpoint: at("/oauth/revoke"),
    poppy_domains: [tc.draw(gs.booleans()) ? domain.toUpperCase() : domain, ...tc.draw(gs.arrays(hosts, { maxSize: 2 }))],
    ...(auth.direct ? { authorization_endpoint: at("/oauth/authorize"), authorization_response_iss_parameter_supported: true } : {}),
    ...(auth.device ? { device_authorization_endpoint: at("/oauth/device") } : {})
  };
  return { requested, domain, poppy, metadata };
});

/** A fetcher that serves a Company's two documents, and nothing else. */
export function serving(company: { readonly requested: string; readonly domain: string; readonly poppy: unknown; readonly metadata: unknown }) {
  const host = company.requested.toLowerCase();
  const issuer = (company.poppy as { auth?: { issuer?: unknown } } | null)?.auth?.issuer;
  const documents = new Map<string, unknown>([[`https://${host}/.well-known/poppy.json`, company.poppy]]);
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
