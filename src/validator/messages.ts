/**
 * Every message the validator can give, with what it means and how to fix
 * it. The ids are stable: tools may key on them, and each one has an anchor
 * on the messages page (`/validator/messages#<id>`).
 *
 * Severity follows one rule: `error` is a MUST the document breaks, so a
 * conforming Personal Agent refuses the document (ours does). `warning` is a
 * SHOULD, or something that will stop some agents working with it. `info`
 * is worth knowing but harmless, such as a field this version ignores.
 */

export type Severity = "error" | "warning" | "info";

export type Ref = { readonly label: string; readonly url: string };

const SITE = "https://personalagentprotocol.org/docs";

export const spec = (section: string, anchor: string): Ref => ({
  label: `Spec ${section}`,
  url: `${SITE}/spec#${anchor}`
});
export const guides = (title: string, anchor: string): Ref => ({
  label: `Guides: ${title}`,
  url: `${SITE}/guides#${anchor}`
});
export const operationsExt = (section: string, anchor: string): Ref => ({
  label: `Operations ${section}`,
  url: `${SITE}/extensions/operations#${anchor}`
});
export const rfc = (number: number, section?: string): Ref => ({
  label: `RFC ${number}${section ? ` §${section}` : ""}`,
  url: `https://www.rfc-editor.org/rfc/rfc${number}${section ? `#section-${section}` : ""}`
});

type Definition = {
  readonly severity: Severity;
  readonly title: string;
  readonly explain: string;
  readonly fix: string;
  readonly ref: Ref;
};

const define = <T extends Record<string, Definition>>(catalog: T) => catalog;

export const MESSAGES = define({
  // Fetching
  "http-not-https": {
    severity: "error",
    title: "Not an HTTPS URL",
    explain: "Discovery documents, metadata and key sets are fetched only over HTTPS.",
    fix: "Serve the document over HTTPS and link to it with an https:// URL.",
    ref: spec("3", "discovery")
  },
  "http-non-public-host": {
    severity: "error",
    title: "Not a public host",
    explain:
      "Personal Agents and Companies refuse to fetch loopback, private, link-local and single-label hosts, so a document there can't be used by anyone else.",
    fix: "Publish the document on a public DNS name.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-redirect-not-https": {
    severity: "error",
    title: "Redirect to a non-HTTPS URL",
    explain: "Every redirect from the well-known URL must be to an HTTPS URL. Agents stop at the first one that isn't.",
    fix: "Make each Location header an https:// URL.",
    ref: spec("3", "discovery")
  },
  "http-too-many-redirects": {
    severity: "error",
    title: "Too many redirects",
    explain: "Agents follow only a few redirects (this validator, like our client, follows 3).",
    fix: "Redirect straight to where the document lives.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-redirect-not-allowed": {
    severity: "error",
    title: "Client metadata is served by a redirect",
    explain:
      "Companies fetch a client_id URL without following redirects, and client_id must equal the URL fetched, so a redirect there fails verification.",
    fix: "Serve the client metadata document directly at its client_id URL.",
    ref: guides("Verifying personal agents", "company-agents")
  },
  "http-status": {
    severity: "error",
    title: "Not served with HTTP 200",
    explain: "The document must be served successfully for anyone to use it.",
    fix: "Serve the document with status 200.",
    ref: spec("3", "discovery")
  },
  "http-failed": {
    severity: "error",
    title: "Couldn't fetch the document",
    explain: "The request failed before a response arrived: DNS, TLS, the connection, or the timeout (5 seconds).",
    fix: "Check that the URL is reachable from the public internet and answers within a few seconds.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-too-large": {
    severity: "error",
    title: "Document too large",
    explain: "Agents cap what they read from another party's URL; ours, and this validator, stop at 100 KB.",
    fix: "Keep the document under 100 KB.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-content-type": {
    severity: "warning",
    title: "Not served as JSON",
    explain: "The response's Content-Type isn't application/json. Some agents and proxies won't treat it as JSON.",
    fix: "Serve it with Content-Type: application/json.",
    ref: rfc(8259, "11")
  },
  "http-no-cache-headers": {
    severity: "info",
    title: "No caching headers",
    explain:
      "Agents cache discovery documents according to HTTP caching headers. Without them each agent picks its own lifetime, typically the minimum (a minute).",
    fix: "Send Cache-Control with a max-age, such as max-age=3600.",
    ref: spec("3", "discovery")
  },
  "http-cache-bounded": {
    severity: "info",
    title: "Cache lifetime outside common bounds",
    explain:
      "Agents bound cache lifetimes, such as to between a minute and a day, so a removed key or endpoint stops being trusted. Values outside that are clamped.",
    fix: "Use a max-age between 60 and 86400 seconds.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },

  // Encoding and JSON
  "not-utf8": {
    severity: "error",
    title: "Not UTF-8",
    explain: "JSON documents must be encoded as UTF-8.",
    fix: "Save and serve the document as UTF-8.",
    ref: guides("Transport and JSON", "both-transport")
  },
  "json-bom": {
    severity: "warning",
    title: "Starts with a byte order mark",
    explain: "JSON text must not begin with a byte order mark. Some parsers reject it.",
    fix: "Remove the BOM at the start of the file.",
    ref: rfc(8259, "8.1")
  },
  "json-syntax": {
    severity: "error",
    title: "Not valid JSON",
    explain: "The document isn't well-formed JSON, so nothing else can be checked.",
    fix: "Fix the syntax at the line and column given.",
    ref: rfc(8259)
  },
  "json-duplicate-member": {
    severity: "error",
    title: "Duplicate member name",
    explain:
      "An object has two members with the same name. Parsers disagree about which one wins, so both parties must reject such objects.",
    fix: "Remove one of the two members.",
    ref: guides("Transport and JSON", "both-transport")
  },

  // Generic structure
  "missing-member": {
    severity: "error",
    title: "Required member missing",
    explain: "A member the specification requires isn't there.",
    fix: "Add the member described in the message.",
    ref: spec("3.1", "fields")
  },
  "wrong-type": {
    severity: "error",
    title: "Wrong type",
    explain: "A member has the wrong JSON type, such as a string where an object is required.",
    fix: "Use the type given in the message.",
    ref: spec("3.1", "fields")
  },
  "not-a-url": {
    severity: "error",
    title: "Not an absolute URL",
    explain: "The value must be an absolute URL.",
    fix: "Use a full URL, starting with https://.",
    ref: spec("3.1", "fields")
  },
  "not-https-url": {
    severity: "error",
    title: "URL isn't HTTPS",
    explain: "Every endpoint and URL in these documents must be HTTPS.",
    fix: "Use an https:// URL.",
    ref: spec("3.1", "fields")
  },
  "url-has-fragment": {
    severity: "error",
    title: "URL has a fragment",
    explain: "Endpoints, issuers and redirect URIs can't contain a #fragment.",
    fix: "Remove the part after #.",
    ref: rfc(6749, "3.1")
  },
  "unknown-member": {
    severity: "info",
    title: "Member not defined in this version",
    explain:
      "This version of the specification doesn't define the member, so agents ignore it. That is allowed: it lets later versions add fields. It may also be a typo.",
    fix: "Check the spelling. If it's deliberate, nothing to do.",
    ref: spec("3.3", "extensions")
  },

  // poppy.json
  "version-format": {
    severity: "error",
    title: "protocol_version isn't major.minor",
    explain: 'protocol_version is a string of two numbers, such as "0.1".',
    fix: 'Set protocol_version to "0.1".',
    ref: spec("3.1", "fields")
  },
  "version-unsupported-major": {
    severity: "error",
    title: "Unsupported major version",
    explain: "A Personal Agent must not use a document whose major version it doesn't support. This validator knows the versions listed on the validator page.",
    fix: "Publish a document for a supported major version, or check a newer validator.",
    ref: spec("3.1", "fields")
  },
  "version-newer-minor": {
    severity: "info",
    title: "Newer minor version",
    explain:
      "A newer minor version doesn't break older agents: they use the document and ignore fields they don't recognize. It was checked against the newest rules this validator knows.",
    fix: "Nothing to do.",
    ref: spec("3.1", "fields")
  },
  "domain-invalid": {
    severity: "error",
    title: "Not a domain name",
    explain: "The value must be a DNS host name, such as example.com, with no scheme, port or path.",
    fix: "Use the bare host name.",
    ref: spec("3.1", "fields")
  },
  "organization-domain-mismatch": {
    severity: "error",
    title: "organization.domain doesn't match the requested domain",
    explain:
      "organization.domain must match the host of the well-known URL the agent requested, ignoring a leading www. The host it was redirected to doesn't count. Otherwise one domain could speak for another.",
    fix: "Set organization.domain to the domain whose /.well-known/poppy.json serves this document.",
    ref: spec("3.1", "fields")
  },
  "organization-name-missing": {
    severity: "warning",
    title: "No display name",
    explain: "organization holds the Company's display name and domain. Without name, agents show the domain to the User instead.",
    fix: "Add organization.name, such as \"Example Company\".",
    ref: spec("3.1", "fields")
  },
  "auth-required": {
    severity: "error",
    title: "auth is required",
    explain: "auth is required when agent, apis, or web.browser_session_endpoint is present, because all of them need Sessions.",
    fix: "Add auth with the Company's issuer, or remove the members that need Sessions.",
    ref: spec("3.1", "fields")
  },
  "nothing-offered": {
    severity: "error",
    title: "No agent, apis or web",
    explain: "A poppy.json must offer at least one of agent, apis, or web.",
    fix: "Add the Company Agent, an API, or the website.",
    ref: spec("3.1", "fields")
  },
  "website-only": {
    severity: "info",
    title: "Website only",
    explain: "Without auth, agents can't start Sessions, so they browse the site as ordinary signed-out visitors.",
    fix: "Add auth to offer Sessions, APIs or conversations.",
    ref: spec("3.1", "fields")
  },
  "signed-out-only": {
    severity: "info",
    title: "No sign-in types",
    explain: "auth lists none of direct, device or mediated, so Sessions can only be signed out.",
    fix: "Add a sign-in type if agents should act on Users' accounts.",
    ref: spec("4.4", "sign-in")
  },
  "issuer-query": {
    severity: "error",
    title: "Issuer has a query",
    explain: "An OAuth issuer identifier is an HTTPS URL with no query or fragment.",
    fix: "Remove the ?query from the issuer.",
    ref: rfc(8414, "2")
  },
  "scope-syntax": {
    severity: "error",
    title: "Invalid scope",
    explain: "Scopes follow OAuth scope syntax: printable ASCII with no spaces, double quotes or backslashes.",
    fix: "Rename the scope.",
    ref: rfc(6749, "3.3")
  },
  "scope-reserved": {
    severity: "error",
    title: "Reserved scope name",
    explain: "Names starting with poppy: are reserved for the protocol, which defines only poppy:read and poppy:write.",
    fix: "Rename the scope so it doesn't start with poppy:.",
    ref: spec("4.4", "sign-in")
  },
  "scope-undescribed": {
    severity: "warning",
    title: "Custom scope has no description",
    explain: "A Company describes each scope it defines in auth.custom_scopes, so agents can explain to the User what they're granting.",
    fix: "Add the scope to auth.custom_scopes with a short description.",
    ref: spec("4.4", "sign-in")
  },
  "scope-unoffered": {
    severity: "info",
    title: "Described scope isn't offered",
    explain: "auth.custom_scopes describes a scope that no sign-in type lists, so agents can never request it.",
    fix: "Add it to a sign-in type's scopes, or remove the description.",
    ref: spec("4.4", "sign-in")
  },
  "scopes-empty": {
    severity: "warning",
    title: "Sign-in type grants no scopes",
    explain: "A sign-in type with an empty scopes list can't grant anything, so agents can't usefully use it.",
    fix: "List the scopes the type can grant.",
    ref: spec("4.4", "sign-in")
  },
  "scope-duplicate": {
    severity: "warning",
    title: "Scope listed twice",
    explain: "The same scope appears twice in one list.",
    fix: "Remove the duplicate.",
    ref: spec("4.4", "sign-in")
  },
  "mediated-fields-empty": {
    severity: "error",
    title: "Mediated Sign-In lists no fields",
    explain: "auth.mediated.fields lists the credentials the agent sends. Without any, agents can't sign in.",
    fix: "List each credential with name, label and secret.",
    ref: spec("4.7", "mediated-sign-in")
  },
  "mediated-field-duplicate": {
    severity: "error",
    title: "Credential field named twice",
    explain: "Each field's name is the key in credentials, so names must be unique.",
    fix: "Give each field a different name.",
    ref: spec("4.7", "mediated-sign-in")
  },
  "mediated-secret-missing": {
    severity: "warning",
    title: "Field doesn't say whether it's secret",
    explain:
      "secret marks a value the agent must protect: never shown back, logged, or sent elsewhere. Without it, agents treat the value as not secret.",
    fix: "Add secret: true or secret: false.",
    ref: spec("4.7", "mediated-sign-in")
  },
  "mediated-looks-secret": {
    severity: "warning",
    title: "Credential looks secret but isn't marked",
    explain: "The field's name or label looks like a password, PIN or code, but secret is false, so agents may show or log it.",
    fix: "Set secret: true.",
    ref: spec("4.7", "mediated-sign-in")
  },
  "resource-invalid": {
    severity: "error",
    title: "Invalid resource",
    explain: "resource is a resource indicator: an absolute URI with no fragment.",
    fix: "Use the URL of the service, without a #fragment.",
    ref: rfc(8707, "2")
  },
  "no-poppy-protocol": {
    severity: "warning",
    title: "No poppy conversation protocol",
    explain: "agent.protocols has no entry of type poppy, the one protocol every Personal Agent implements, so most agents can't talk to the Company Agent.",
    fix: 'Add { "type": "poppy", "endpoint": "https://…" }.',
    ref: spec("7.1", "conversation-protocols")
  },
  "protocol-type-unknown": {
    severity: "info",
    title: "Conversation protocol agents may not know",
    explain: "Agents skip conversation protocol types they don't support.",
    fix: "Nothing to do, as long as a poppy entry is listed too.",
    ref: spec("7.1", "conversation-protocols")
  },
  "api-type-unknown": {
    severity: "info",
    title: "API type not defined in this version",
    explain: "The protocol defines openapi and mcp. Agents skip types they don't recognize, so later versions can add types.",
    fix: "Nothing to do, unless agents should use this API.",
    ref: spec("6", "apis")
  },
  "api-description-missing": {
    severity: "warning",
    title: "API has no description",
    explain: "Each API has a short description that helps the agent pick the right one.",
    fix: "Add a description, such as \"Orders, returns, and exchanges\".",
    ref: spec("6", "apis")
  },
  "mcp-resource-mismatch": {
    severity: "warning",
    title: "MCP resource differs from its url",
    explain: "An MCP server accepts only tokens issued for its url, and agents request Bearer tokens with resource set to that url. A different resource here is ambiguous.",
    fix: "Leave out resource for MCP entries, or set it to the url.",
    ref: spec("4.3", "sending-tokens")
  },
  "extension-name": {
    severity: "error",
    title: "Invalid extension name",
    explain:
      "Extensions defined with the protocol have plain names. Anyone else must start the name with a domain they control, such as example.com/gift-wrap.",
    fix: "Prefix the name with your domain and a slash.",
    ref: spec("3.3", "extensions")
  },
  "extension-plain-unknown": {
    severity: "warning",
    title: "Plain extension name the protocol doesn't define",
    explain: "Plain names are reserved for extensions defined with the protocol. This one isn't defined in the version checked.",
    fix: "If it's your own extension, name it with your domain, such as example.com/gift-wrap.",
    ref: spec("3.3", "extensions")
  },
  "extension-version-unknown": {
    severity: "info",
    title: "Extension version this validator doesn't know",
    explain: "Agents that don't support this version of the extension ignore it.",
    fix: "Nothing to do.",
    ref: spec("3.3", "extensions")
  },

  // OAuth authorization server metadata
  "metadata-issuer-mismatch": {
    severity: "error",
    title: "Metadata issuer doesn't match auth.issuer",
    explain:
      "The metadata's issuer must exactly equal auth.issuer, character for character. Otherwise any domain could claim another Company's issuer and receive its tokens.",
    fix: "Make the two strings identical, including any trailing slash.",
    ref: spec("3.2", "oauth-server")
  },
  "metadata-domain-missing": {
    severity: "error",
    title: "poppy_domains doesn't include the domain",
    explain: "poppy_domains must list every domain whose poppy.json names the issuer. Agents refuse a domain that isn't listed.",
    fix: "Add organization.domain to poppy_domains.",
    ref: spec("3.2", "oauth-server")
  },
  "metadata-auth-method": {
    severity: "warning",
    title: "private_key_jwt not advertised",
    explain: "Personal Agents authenticate at the token endpoint with private_key_jwt. The metadata lists other methods only.",
    fix: "Add private_key_jwt to token_endpoint_auth_methods_supported.",
    ref: spec("4.1", "agent-identity")
  },
  "metadata-signing-alg": {
    severity: "warning",
    title: "No supported algorithm for client assertions",
    explain: "Agents sign client assertions with ES256, or RS256. token_endpoint_auth_signing_alg_values_supported lists neither.",
    fix: "Add ES256, and RS256 if you can.",
    ref: rfc(8414, "2")
  },
  "metadata-grant-type": {
    severity: "warning",
    title: "Grant type not advertised",
    explain: "grant_types_supported leaves out a grant this Company needs for the sign-in types its poppy.json lists.",
    fix: "Add the grant type named in the message.",
    ref: spec("4.2", "starting-sessions")
  },
  "metadata-dpop-alg": {
    severity: "warning",
    title: "ES256 not advertised for DPoP",
    explain: "Agents sign DPoP proofs with ES256 when they can, and dpop_signing_alg_values_supported doesn't list it.",
    fix: "Add ES256.",
    ref: rfc(9449, "5.1")
  },
  "metadata-pkce": {
    severity: "warning",
    title: "S256 not advertised for PKCE",
    explain: "Direct Sign-In uses PKCE with S256, and code_challenge_methods_supported doesn't list it.",
    fix: "Add S256.",
    ref: spec("4.5", "direct-sign-in")
  },
  "metadata-iss-parameter": {
    severity: "info",
    title: "Authorization responses may not carry iss",
    explain:
      "authorization_response_iss_parameter_supported isn't true. Agents that check iss on the redirect (RFC 9207), as ours does, can then tell Companies apart only by state.",
    fix: "Return iss in authorization responses and set the flag to true.",
    ref: rfc(9207, "3")
  },

  // Client metadata and keys
  "client-id-mismatch": {
    severity: "error",
    title: "client_id isn't the URL it was fetched from",
    explain: "A Personal Agent's client_id must equal the URL its metadata document was fetched from.",
    fix: "Set client_id to the exact URL of this document.",
    ref: spec("4.1", "agent-identity")
  },
  "client-other-domain": {
    severity: "error",
    title: "URL on a different domain from client_id",
    explain: "jwks_uri and every redirect URI must be HTTPS URLs on the same domain as client_id.",
    fix: "Host them on client_id's domain.",
    ref: spec("4.1", "agent-identity")
  },
  "client-auth-method": {
    severity: "error",
    title: "Token endpoint auth method isn't private_key_jwt",
    explain: "Personal Agents authenticate with private_key_jwt. Without the member, OAuth's default (client_secret_basic) applies, which doesn't fit.",
    fix: 'Set "token_endpoint_auth_method": "private_key_jwt".',
    ref: spec("4.1", "agent-identity")
  },
  "client-no-redirects": {
    severity: "info",
    title: "No redirect URIs",
    explain: "Without redirect_uris the agent can't use Direct Sign-In; Device and Mediated Sign-In still work.",
    fix: "Add the agent's Direct Sign-In callback URL.",
    ref: spec("4.1", "agent-identity")
  },
  "jwks-empty": {
    severity: "error",
    title: "No keys",
    explain: "The key set has no keys, so nothing the agent signs can be verified.",
    fix: "Publish at least one public signing key.",
    ref: spec("4.1", "agent-identity")
  },
  "jwks-private-key": {
    severity: "error",
    title: "Private key material published",
    explain: "The key set contains only public keys. This key has private members (d, p, q, dp, dq, qi or k), so the key is compromised.",
    fix: "Remove the key, generate a new one, and publish only its public part.",
    ref: spec("4.1", "agent-identity")
  },
  "jwks-key-type": {
    severity: "error",
    title: "Unsupported key",
    explain: "Keys are EC P-256 (for ES256) or RSA (for RS256). Others can't be used for assertions.",
    fix: "Use an EC P-256 key, or an RSA key of at least 2048 bits.",
    ref: guides("Signing and verifying JWTs", "both-signing")
  },
  "jwks-rsa-small": {
    severity: "error",
    title: "RSA key too small",
    explain: "RSA keys must be at least 2048 bits.",
    fix: "Generate a 2048-bit or larger key, or use EC P-256.",
    ref: guides("Signing and verifying JWTs", "both-signing")
  },
  "jwks-alg": {
    severity: "warning",
    title: "Key algorithm isn't ES256 or RS256",
    explain: "Companies support ES256 and RS256. A key marked with another alg may be ignored.",
    fix: "Use ES256 or RS256.",
    ref: guides("Signing and verifying JWTs", "both-signing")
  },
  "jwks-no-kid": {
    severity: "warning",
    title: "Key has no kid",
    explain: "Every key needs a kid so keys can be rotated and Companies can pick the right one.",
    fix: "Add a unique kid to each key.",
    ref: guides("Rotating keys", "both-key-rotation")
  },
  "jwks-kid-duplicate": {
    severity: "error",
    title: "Two keys share a kid",
    explain: "A kid must identify one key, or verifiers may pick the wrong one.",
    fix: "Give each key a unique kid.",
    ref: guides("Rotating keys", "both-key-rotation")
  },
  "jwks-use": {
    severity: "warning",
    title: "Key isn't for signing",
    explain: 'The key\'s use isn\'t "sig", so verifiers may refuse to check signatures with it.',
    fix: 'Set use to "sig" or leave it out.',
    ref: rfc(7517, "4.2")
  }
});

export type MessageId = keyof typeof MESSAGES;
