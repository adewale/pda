/**
 * Every message the validator can give, with what it means and how to fix
 * it. The ids are stable: tools may key on them, and each one has an anchor
 * on the messages page (`/validator/messages#<id>`).
 *
 * Each message names its `basis` (src/validator/levels.ts), and its severity
 * follows from it (docs/conformance-levels.md): a MUST, an RFC's MUST or a
 * normative statement without a key word broken is an `error`; a SHOULD, the
 * Guides or our reading of an open question is a `warning`; a message that
 * reports a fact rather than a departure (`note`) is `info`. Only errors make
 * a document invalid.
 *
 * What our own client refuses is a separate decision, `refuses`: every error
 * by default, and also the warnings that guard against a hostile document
 * (the Guides' fetch limits, duplicate member names, HTTPS where the draft
 * doesn't ask for it, spec-issues N9). A few errors it tolerates, because the
 * draft or the RFC tells a reader to (a byte order mark, an API type it
 * doesn't know). Each says so in `explain`, so a report never presents our
 * policy as the draft's requirement.
 */
import { levelOf, severityOf, type Basis, type Severity } from "./levels.ts";

export type { Basis, Severity };

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
  /** What the message rests on; its severity follows. */
  readonly basis: Basis;
  /** It reports a fact, not a departure from anything: info, whatever its basis. */
  readonly note?: true;
  /** Whether our client refuses a Company over it, when that differs from "it's an error". */
  readonly refuses?: boolean;
  readonly title: string;
  readonly explain: string;
  readonly fix: string;
  readonly ref: Ref;
};

type Defined<D extends Definition> = D & { readonly severity: Severity; readonly refuses: boolean };

/** Each definition with its severity, from its basis, and whether our client refuses over it. */
const define = <T extends Record<string, Definition>>(catalog: T): { readonly [K in keyof T]: Defined<T[K]> } =>
  Object.fromEntries(
    Object.entries(catalog).map(([id, definition]) => {
      const severity: Severity = definition.note ? "info" : severityOf(levelOf(definition.basis));
      return [id, { ...definition, severity, refuses: definition.refuses ?? severity === "error" }];
    })
  ) as { readonly [K in keyof T]: Defined<T[K]> };

export const MESSAGES = define({
  // Fetching
  "http-not-https": {
    basis: "MUST",
    title: "Not an HTTPS URL",
    explain: "Discovery documents, metadata and key sets are fetched only over HTTPS.",
    fix: "Serve the document over HTTPS and link to it with an https:// URL.",
    ref: spec("3", "discovery")
  },
  "http-non-public-host": {
    basis: "Guides",
    refuses: true,
    title: "Not a public host",
    explain:
      "The Guides ask Personal Agents and Companies to refuse loopback, private and link-local addresses unless configured on purpose (a recommendation, not a requirement of the draft). By name alone, this validator, like our client, never fetches IP literals, single-label hosts, or special-use and private-use names such as localhost, .local, .internal and .home.arpa, so it can't check a document there. A name can still resolve to a private address: on Cloudflare Workers the platform refuses those connections, and the command-line validator checks each address a name resolves to (http-non-public-address). Used as a library elsewhere, it checks names only, so the caller must supply a fetcher that checks addresses.",
    fix: "Publish the document on a public DNS name.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-non-public-address": {
    basis: "Guides",
    refuses: true,
    title: "Resolves to a private address",
    explain:
      "The Guides ask Personal Agents and Companies to refuse loopback, private and link-local addresses, judged by the address actually connected to (a recommendation, not a requirement of the draft). The host name is public, but it resolves to such an address (loopback, RFC 1918, link-local, carrier-grade NAT, unique local, unspecified, multicast or another range that isn't globally reachable), so nothing was checked there. The command-line validator resolves each name itself, refuses these, and connects only to the address it checked.",
    fix: "Point the name at a public address.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-redirect-not-https": {
    basis: "MUST",
    title: "Redirect to a non-HTTPS URL",
    explain: "Every redirect from the well-known URL must be to an HTTPS URL. Agents stop at the first one that isn't.",
    fix: "Make each Location header an https:// URL.",
    ref: spec("3", "discovery")
  },
  "http-too-many-redirects": {
    basis: "Guides",
    refuses: true,
    title: "Too many redirects",
    explain:
      "The draft says agents MUST follow redirects but sets no limit; the Guides recommend a few at most. This validator, like our client, follows 3.",
    fix: "Redirect straight to where the document lives.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-redirect-not-allowed": {
    basis: "Guides",
    refuses: true,
    title: "Client metadata is served by a redirect",
    explain:
      "client_id MUST equal the URL the document was fetched from (4.1), and the Guides tell Companies to fetch it without following redirects, so a redirect there fails verification at Companies that do, and this validator, like our client with any document, doesn't follow it. Only the Guides say not to follow redirects here, and the Guides are recommendations, so this is a warning.",
    fix: "Serve the client metadata document directly at its client_id URL.",
    ref: guides("Verifying personal agents", "company-agents")
  },
  "http-status": {
    basis: "MUST",
    title: "Not served with HTTP 200",
    explain: "The document must be served successfully for anyone to use it.",
    fix: "Serve the document with status 200.",
    ref: spec("3", "discovery")
  },
  "http-failed": {
    basis: "Guides",
    refuses: true,
    title: "Couldn't fetch the document",
    explain: "The request failed before a response arrived: DNS, TLS, the connection, or the timeout (5 seconds, as the Guides suggest a few). Nothing was checked, and our client can't use a document it couldn't fetch.",
    fix: "Check that the URL is reachable from the public internet and answers within a few seconds.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-too-large": {
    basis: "Guides",
    refuses: true,
    title: "Document too large",
    explain:
      "The Guides recommend capping what is read from another party's URL, such as at 100 KB; the draft sets no size. Our client, and this validator, stop at 100 KB.",
    fix: "Keep the document under 100 KB.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-content-type": {
    basis: "Reading",
    title: "Not served as JSON",
    explain: "The response's Content-Type isn't application/json. Some agents and proxies won't treat it as JSON.",
    fix: "Serve it with Content-Type: application/json.",
    ref: rfc(8259, "11")
  },
  "http-no-cache-headers": {
    basis: "SHOULD",
    note: true,
    title: "No caching headers",
    explain:
      "Agents cache discovery documents according to HTTP caching headers. Without them each agent picks its own lifetime, typically the minimum (a minute).",
    fix: "Send Cache-Control with a max-age, such as max-age=3600.",
    ref: spec("3", "discovery")
  },
  "http-cache-bounded": {
    basis: "Guides",
    note: true,
    title: "Cache lifetime outside common bounds",
    explain:
      "Agents bound cache lifetimes, such as to between a minute and a day, so a removed key or endpoint stops being trusted. Values outside that are clamped.",
    fix: "Use a max-age between 60 and 86400 seconds.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },

  // Encoding and JSON
  "not-utf8": {
    basis: "RFC",
    title: "Not UTF-8",
    explain: "JSON exchanged between systems MUST be encoded as UTF-8 (RFC 8259 §8.1); the Guides say the same.",
    fix: "Save and serve the document as UTF-8.",
    ref: rfc(8259, "8.1")
  },
  "json-bom": {
    basis: "RFC",
    refuses: false,
    title: "Starts with a byte order mark",
    explain:
      "JSON sent over a network MUST NOT begin with a byte order mark (RFC 8259 §8.1), so this is an error. The same section lets parsers ignore one, and our client does; other parsers reject it.",
    fix: "Remove the BOM at the start of the file.",
    ref: rfc(8259, "8.1")
  },
  "json-syntax": {
    basis: "RFC",
    title: "Not valid JSON",
    explain: "The document isn't well-formed JSON, so nothing else can be checked.",
    fix: "Fix the syntax at the line and column given.",
    ref: rfc(8259)
  },
  "json-duplicate-member": {
    basis: "SHOULD",
    refuses: true,
    title: "Duplicate member name",
    explain:
      "An object has two members with the same name. Parsers disagree about which one wins. RFC 8259 §4 says names SHOULD be unique and the Guides recommend rejecting such objects; the draft has no MUST here, so this is a warning. Our client still refuses them: a document two parsers read differently can mean two things.",
    fix: "Remove one of the two members.",
    ref: guides("Transport and JSON", "both-transport")
  },

  // Generic structure
  "missing-member": {
    basis: "MUST",
    title: "Required member missing",
    explain: "A member the specification requires isn't there.",
    fix: "Add the member described in the message.",
    ref: spec("3.1", "fields")
  },
  "wrong-type": {
    basis: "Rule",
    title: "Wrong type",
    explain: "A member has the wrong JSON type, such as a string where an object is required.",
    fix: "Use the type given in the message.",
    ref: spec("3.1", "fields")
  },
  "not-a-url": {
    basis: "Rule",
    title: "Not an absolute URL",
    explain: "The value must be an absolute URL with a host name (or an IP address), such as https://api.example.com/.",
    fix: "Use a full URL, starting with https://.",
    ref: spec("3.1", "fields")
  },
  "not-https-url": {
    basis: "MUST",
    title: "URL isn't HTTPS",
    explain:
      "The draft requires HTTPS for auth.issuer, conversation endpoints, client_id, jwks_uri and redirect_uris, and OAuth requires it for the authorization server's endpoints.",
    fix: "Use an https:// URL.",
    ref: spec("3.1", "fields")
  },
  "not-https-url-unstated": {
    basis: "Reading",
    refuses: true,
    title: "URL isn't HTTPS (where the draft doesn't say)",
    explain:
      "The draft doesn't require HTTPS for apis[].url, auth.mediated.endpoint (which receives passwords), web.browser_session_endpoint, extension endpoints or logo_uri (spec-issues N9). Our reading is that it does, since each of them receives tokens or credentials or is shown to the User, so this is a warning, and our client refuses a poppy.json that doesn't use HTTPS there.",
    fix: "Use an https:// URL.",
    ref: spec("3.1", "fields")
  },
  "url-has-fragment": {
    basis: "RFC",
    title: "URL has a fragment",
    explain:
      "OAuth endpoints, issuers and redirect URIs can't contain a #fragment (RFC 6749 §3.1, §3.1.2, §3.2; RFC 8414 §2).",
    fix: "Remove the part after #.",
    ref: rfc(6749, "3.1")
  },
  "url-has-fragment-unstated": {
    basis: "Reading",
    refuses: true,
    title: "URL has a fragment (where no rule forbids one)",
    explain:
      "No rule forbids a #fragment in this URL, but a fragment is never sent to a server, so a URL that has one is a mistake or a trick. Our reading is that these URLs follow the OAuth rule too; this is a warning, and our client refuses the document.",
    fix: "Remove the part after #.",
    ref: rfc(6749, "3.1")
  },
  "unknown-member": {
    basis: "MUST",
    note: true,
    title: "Member not defined in this version",
    explain:
      "This version of the specification doesn't define the member, so agents ignore it. That is allowed: it lets later versions add fields. It may also be a typo.",
    fix: "Check the spelling. If it's deliberate, nothing to do.",
    ref: spec("3.3", "extensions")
  },

  // poppy.json
  "version-format": {
    basis: "Rule",
    title: "protocol_version isn't major.minor",
    explain: 'protocol_version is a string of two numbers, such as "0.1".',
    fix: 'Set protocol_version to "0.1".',
    ref: spec("3.1", "fields")
  },
  "version-unsupported-major": {
    basis: "MUST",
    title: "Unsupported major version",
    explain: "A Personal Agent must not use a document whose major version it doesn't support. This validator knows the versions listed on the validator page.",
    fix: "Publish a document for a supported major version, or check a newer validator.",
    ref: spec("3.1", "fields")
  },
  "version-newer-minor": {
    basis: "Rule",
    note: true,
    title: "Newer minor version",
    explain:
      "A newer minor version doesn't break older agents: they use the document and ignore fields they don't recognize. It was checked against the newest rules this validator knows.",
    fix: "Nothing to do.",
    ref: spec("3.1", "fields")
  },
  "domain-invalid": {
    basis: "Rule",
    title: "Not a domain name",
    explain: "The value must be a DNS host name, such as example.com, with no scheme, port or path.",
    fix: "Use the bare host name.",
    ref: spec("3.1", "fields")
  },
  "organization-domain-mismatch": {
    basis: "MUST",
    title: "organization.domain doesn't match the requested domain",
    explain:
      "organization.domain must match the host of the well-known URL the agent requested, ignoring a leading www. The host it was redirected to doesn't count. Otherwise one domain could speak for another.",
    fix: "Set organization.domain to the domain whose /.well-known/poppy.json serves this document.",
    ref: spec("3.1", "fields")
  },
  "organization-name-missing": {
    basis: "Rule",
    refuses: false,
    title: "No display name",
    explain:
      "organization is required and is the Company's \"Display name and domain\" (3.1): a normative statement without a key word, so this is an error. Our client tolerates it and shows the domain to the User instead (spec-issues S18).",
    fix: "Add organization.name, such as \"Example Company\".",
    ref: spec("3.1", "fields")
  },
  "auth-required": {
    basis: "MUST",
    title: "auth is required",
    explain: "auth is required when agent, apis, or web.browser_session_endpoint is present, because all of them need Sessions.",
    fix: "Add auth with the Company's issuer, or remove the members that need Sessions.",
    ref: spec("3.1", "fields")
  },
  "nothing-offered": {
    basis: "MUST",
    title: "No agent, apis or web",
    explain: "A poppy.json must offer at least one of agent, apis, or web.",
    fix: "Add the Company Agent, an API, or the website.",
    ref: spec("3.1", "fields")
  },
  "website-only": {
    basis: "Rule",
    note: true,
    title: "Website only",
    explain: "Without auth, agents can't start Sessions, so they browse the site as ordinary signed-out visitors.",
    fix: "Add auth to offer Sessions, APIs or conversations.",
    ref: spec("3.1", "fields")
  },
  "signed-out-only": {
    basis: "Rule",
    note: true,
    title: "No sign-in types",
    explain: "auth lists none of direct, device or mediated, so Sessions can only be signed out.",
    fix: "Add a sign-in type if agents should act on Users' accounts.",
    ref: spec("4.4", "sign-in")
  },
  "issuer-query": {
    basis: "RFC",
    title: "Issuer has a query",
    explain: "An OAuth issuer identifier is an HTTPS URL with no query or fragment.",
    fix: "Remove the ?query from the issuer.",
    ref: rfc(8414, "2")
  },
  "scope-syntax": {
    basis: "RFC",
    title: "Invalid scope",
    explain: "Scopes follow OAuth scope syntax: printable ASCII with no spaces, double quotes or backslashes.",
    fix: "Rename the scope.",
    ref: rfc(6749, "3.3")
  },
  "scope-reserved": {
    basis: "Rule",
    title: "Reserved scope name",
    explain: "Names starting with poppy: are reserved for the protocol, which defines only poppy:read and poppy:write.",
    fix: "Rename the scope so it doesn't start with poppy:.",
    ref: spec("4.4", "sign-in")
  },
  "scope-undescribed": {
    basis: "Reading",
    title: "Custom scope has no description",
    explain: "A Company describes each scope it defines in auth.custom_scopes, so agents can explain to the User what they're granting.",
    fix: "Add the scope to auth.custom_scopes with a short description.",
    ref: spec("4.4", "sign-in")
  },
  "scope-unoffered": {
    basis: "Reading",
    note: true,
    title: "Described scope isn't offered",
    explain: "auth.custom_scopes describes a scope that no sign-in type lists, so agents can never request it.",
    fix: "Add it to a sign-in type's scopes, or remove the description.",
    ref: spec("4.4", "sign-in")
  },
  "scopes-empty": {
    basis: "Reading",
    title: "Sign-in type grants no scopes",
    explain: "A sign-in type with an empty scopes list can't grant anything, so agents can't usefully use it.",
    fix: "List the scopes the type can grant.",
    ref: spec("4.4", "sign-in")
  },
  "scope-duplicate": {
    basis: "Reading",
    title: "Scope listed twice",
    explain: "The same scope appears twice in one list.",
    fix: "Remove the duplicate.",
    ref: spec("4.4", "sign-in")
  },
  "mediated-fields-empty": {
    basis: "Reading",
    refuses: true,
    title: "Mediated Sign-In lists no fields",
    explain:
      "auth.mediated.fields lists the credentials the agent sends. The draft doesn't say it can't be empty, but without any, agents have nothing to send and can't sign in. Our reading, so a warning; our client refuses it.",
    fix: "List each credential with name, label and secret.",
    ref: spec("4.7", "mediated-sign-in")
  },
  "mediated-field-duplicate": {
    basis: "Rule",
    title: "Credential field named twice",
    explain: "Each field's name is the key in credentials, so names must be unique.",
    fix: "Give each field a different name.",
    ref: spec("4.7", "mediated-sign-in")
  },
  "mediated-secret-missing": {
    basis: "Reading",
    title: "Field doesn't say whether it's secret",
    explain:
      "secret marks a value the agent must protect: never shown back, logged, or sent elsewhere. Without it, agents treat the value as not secret.",
    fix: "Add secret: true or secret: false.",
    ref: spec("4.7", "mediated-sign-in")
  },
  "mediated-looks-secret": {
    basis: "Reading",
    title: "Credential looks secret but isn't marked",
    explain: "The field's name or label looks like a password, PIN or code, but secret is false, so agents may show or log it.",
    fix: "Set secret: true.",
    ref: spec("4.7", "mediated-sign-in")
  },
  "resource-invalid": {
    basis: "RFC",
    title: "Invalid resource",
    explain: "resource is a resource indicator: an absolute URI with no fragment.",
    fix: "Use the URL of the service, without a #fragment.",
    ref: rfc(8707, "2")
  },
  "no-poppy-protocol": {
    basis: "Reading",
    title: "No poppy conversation protocol",
    explain:
      "agent.protocols has no entry of type poppy, the only conversation protocol the draft defines, so most agents can't talk to the Company Agent.",
    fix: 'Add { "type": "poppy", "endpoint": "https://…" }.',
    ref: spec("7.1", "conversation-protocols")
  },
  "protocol-type-unknown": {
    basis: "Rule",
    note: true,
    title: "Conversation protocol agents may not know",
    explain: "Agents skip conversation protocol types they don't support.",
    fix: "Nothing to do, as long as a poppy entry is listed too.",
    ref: spec("7.1", "conversation-protocols")
  },
  "api-type-unknown": {
    basis: "MUST",
    refuses: false,
    title: "API type not defined in this version",
    explain:
      "Draft 0.1 says each API's type MUST be openapi or mcp, so in a document that declares a version this validator knows, another type is an error. The draft also says agents SHOULD skip types they don't recognize, and ours does: it skips the API and still uses the Company.",
    fix: "Use openapi or mcp, or leave the API out until a version of the protocol defines its type.",
    ref: spec("6", "apis")
  },
  "api-type-newer": {
    basis: "MUST",
    note: true,
    title: "API type from a newer version",
    explain:
      "The document declares a newer minor version than this validator knows, which may define more API types (3.1: a newer minor version doesn't break older agents). Agents that don't know this type skip the API (6), so this is information.",
    fix: "Nothing to do, unless agents should use this API.",
    ref: spec("6", "apis")
  },
  "api-description-missing": {
    basis: "Rule",
    refuses: false,
    title: "API has no description",
    explain:
      "\"Each has a type …, a url, and a short description\" (3.1): a normative statement without a key word, so this is an error. Our client still uses the API.",
    fix: "Add a description, such as \"Orders, returns, and exchanges\".",
    ref: spec("6", "apis")
  },
  "mcp-resource-mismatch": {
    basis: "Reading",
    title: "MCP resource differs from its url",
    explain: "An MCP server accepts only tokens issued for its url, and agents request Bearer tokens with resource set to that url. A different resource here is ambiguous.",
    fix: "Leave out resource for MCP entries, or set it to the url.",
    ref: spec("4.3", "sending-tokens")
  },
  "extension-name": {
    basis: "MUST",
    title: "Invalid extension name",
    explain:
      "Extensions defined with the protocol have plain names. Anyone else must start the name with a domain they control, such as example.com/gift-wrap.",
    fix: "Prefix the name with your domain and a slash.",
    ref: spec("3.3", "extensions")
  },
  "extension-plain-unknown": {
    basis: "Reading",
    title: "Plain extension name the protocol doesn't define",
    explain:
      "Plain names are for extensions defined with the protocol; anyone else MUST use a name that starts with their domain (3.3). The Extensions page can define new plain-named extensions at any time, independently of the protocol version, so this validator can't tell a newly defined one from a misnamed one: our reading is a warning, not an error. Agents ignore extensions they don't support.",
    fix: "If it's your own extension, name it with your domain, such as example.com/gift-wrap.",
    ref: spec("3.3", "extensions")
  },
  "extension-version-unknown": {
    basis: "MUST",
    note: true,
    title: "Extension version this validator doesn't know",
    explain: "Agents that don't support this version of the extension ignore it.",
    fix: "Nothing to do.",
    ref: spec("3.3", "extensions")
  },
  "extension-version-number": {
    basis: "Reading",
    title: "Extension version is a number",
    explain:
      "\"Each entry has a version, the extension's major version\" (3.3), but the draft doesn't give its JSON type (spec-issues N22); every example is a string, such as \"1\". Our reading is a string, so a number is a warning. Agents that compare it as a string, ours included, don't recognize the version and ignore the extension.",
    fix: "Write the version as a string, such as \"1\".",
    ref: spec("3.3", "extensions")
  },

  // OAuth authorization server metadata
  "metadata-issuer-mismatch": {
    basis: "MUST",
    title: "Metadata issuer doesn't match auth.issuer",
    explain:
      "The metadata's issuer must exactly equal auth.issuer, character for character. Otherwise any domain could claim another Company's issuer and receive its tokens.",
    fix: "Make the two strings identical, including any trailing slash.",
    ref: spec("3.2", "oauth-server")
  },
  "metadata-domain-missing": {
    basis: "MUST",
    title: "poppy_domains doesn't include the domain",
    explain: "poppy_domains must list every domain whose poppy.json names the issuer. Agents refuse a domain that isn't listed.",
    fix: "Add organization.domain to poppy_domains.",
    ref: spec("3.2", "oauth-server")
  },
  "metadata-auth-method": {
    basis: "Reading",
    title: "private_key_jwt not advertised",
    explain: "Personal Agents authenticate at the token endpoint with private_key_jwt. The metadata lists other methods only.",
    fix: "Add private_key_jwt to token_endpoint_auth_methods_supported.",
    ref: spec("4.1", "agent-identity")
  },
  "metadata-signing-alg": {
    basis: "Guides",
    title: "No supported algorithm for client assertions",
    explain: "Agents sign client assertions with ES256, or RS256. token_endpoint_auth_signing_alg_values_supported lists neither.",
    fix: "Add ES256, and RS256 if you can.",
    ref: rfc(8414, "2")
  },
  "metadata-grant-type": {
    basis: "Reading",
    title: "Grant type not advertised",
    explain: "grant_types_supported leaves out a grant this Company needs for the sign-in types its poppy.json lists.",
    fix: "Add the grant type named in the message.",
    ref: spec("4.2", "starting-sessions")
  },
  "metadata-dpop-alg": {
    basis: "Guides",
    title: "ES256 not advertised for DPoP",
    explain: "Agents sign DPoP proofs with ES256 when they can, and dpop_signing_alg_values_supported doesn't list it.",
    fix: "Add ES256.",
    ref: rfc(9449, "5.1")
  },
  "metadata-pkce": {
    basis: "Guides",
    title: "S256 not advertised for PKCE",
    explain: "Direct Sign-In uses PKCE with S256, and code_challenge_methods_supported doesn't list it.",
    fix: "Add S256.",
    ref: spec("4.5", "direct-sign-in")
  },
  "metadata-iss-parameter": {
    basis: "Rule",
    note: true,
    title: "Authorization responses may not carry iss",
    explain:
      "authorization_response_iss_parameter_supported isn't true. Agents that check iss on the redirect (RFC 9207), as ours does, can then tell Companies apart only by state.",
    fix: "Return iss in authorization responses and set the flag to true.",
    ref: rfc(9207, "3")
  },

  // Client metadata and keys
  "client-id-mismatch": {
    basis: "MUST",
    title: "client_id isn't the URL it was fetched from",
    explain: "A Personal Agent's client_id must equal the URL its metadata document was fetched from.",
    fix: "Set client_id to the exact URL of this document.",
    ref: spec("4.1", "agent-identity")
  },
  "client-other-domain": {
    basis: "MUST",
    title: "URL on a different domain from client_id",
    explain: "jwks_uri and every redirect URI must be HTTPS URLs on the same domain as client_id.",
    fix: "Host them on client_id's domain.",
    ref: spec("4.1", "agent-identity")
  },
  "client-auth-method": {
    basis: "Rule",
    title: "Token endpoint auth method isn't private_key_jwt",
    explain:
      "Personal Agents authenticate with private_key_jwt (4.1), and the draft's example declares it. The draft has no MUST for the member, but without it OAuth's default (client_secret_basic, RFC 7591 §2) applies, which doesn't fit.",
    fix: 'Set "token_endpoint_auth_method": "private_key_jwt".',
    ref: spec("4.1", "agent-identity")
  },
  "client-no-redirects": {
    basis: "Rule",
    note: true,
    title: "No redirect URIs",
    explain: "Without redirect_uris the agent can't use Direct Sign-In; Device and Mediated Sign-In still work.",
    fix: "Add the agent's Direct Sign-In callback URL.",
    ref: spec("4.1", "agent-identity")
  },
  "jwks-empty": {
    basis: "Rule",
    title: "No keys",
    explain: "The key set has no keys, so nothing the agent signs can be verified.",
    fix: "Publish at least one public signing key.",
    ref: spec("4.1", "agent-identity")
  },
  "jwks-private-key": {
    basis: "Rule",
    title: "Private key material published",
    explain: "The key set contains only public keys. This key has private members (d, p, q, dp, dq, qi or k), so the key is compromised.",
    fix: "Remove the key, generate a new one, and publish only its public part.",
    ref: spec("4.1", "agent-identity")
  },
  "jwks-key-type": {
    basis: "Guides",
    title: "Unsupported key",
    explain:
      "The Guides say to support ES256 and RS256, so Companies may accept only EC P-256 and RSA keys. The draft doesn't restrict key types, so this is a warning.",
    fix: "Use an EC P-256 key, or an RSA key of at least 2048 bits.",
    ref: guides("Signing and verifying JWTs", "both-signing")
  },
  "jwks-rsa-small": {
    basis: "RFC",
    title: "RSA key too small",
    explain: "RS256 MUST use a key of 2048 bits or larger (RFC 7518 §3.3); the Guides say the same.",
    fix: "Generate a 2048-bit or larger key, or use EC P-256.",
    ref: rfc(7518, "3.3")
  },
  "jwks-alg": {
    basis: "Guides",
    title: "Key algorithm isn't ES256 or RS256",
    explain: "Companies support ES256 and RS256. A key marked with another alg may be ignored.",
    fix: "Use ES256 or RS256.",
    ref: guides("Signing and verifying JWTs", "both-signing")
  },
  "jwks-no-kid": {
    basis: "Guides",
    title: "Key has no kid",
    explain: "Every key needs a kid so keys can be rotated and Companies can pick the right one.",
    fix: "Add a unique kid to each key.",
    ref: guides("Rotating keys", "both-key-rotation")
  },
  "jwks-kid-duplicate": {
    basis: "SHOULD",
    title: "Two keys share a kid",
    explain:
      "Different keys in a key set SHOULD have different kids (RFC 7517 §4.5), and the Guides give every key one for rotation. Verifiers may pick the wrong key. A SHOULD, so this is a warning.",
    fix: "Give each key a unique kid.",
    ref: guides("Rotating keys", "both-key-rotation")
  },
  "jwks-use": {
    basis: "Reading",
    title: "Key isn't for signing",
    explain: 'The key\'s use isn\'t "sig", so verifiers may refuse to check signatures with it.',
    fix: 'Set use to "sig" or leave it out.',
    ref: rfc(7517, "4.2")
  }
});

export type MessageId = keyof typeof MESSAGES;
