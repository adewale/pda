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
 * (the Guides' fetch limits, duplicate member names, a fragment where no rule
 * forbids one, spec-issues N9). A few errors it tolerates, because the RFC
 * tells a reader to (a byte order mark) or it has a safe fallback (an API
 * without a description). Each says so in `explain`, so a report never
 * presents our policy as the draft's requirement.
 *
 * The draft is 0.3 (spec/draft-0.3-retrieved-2026-10-29), and the links go
 * to its pages. Where 0.3 changed a rule a Company may still follow, the
 * explanation says what replaced it.
 */
import { levelOf, severityOf, type Basis, type Severity } from "./levels.ts";

export type { Basis, Severity };

export type Ref = { readonly label: string; readonly url: string };

/** The pages of the version this validator checks, 0.3. */
const SITE = "https://personalagentprotocol.org/docs/0.3";

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
export const mediatedExt = (section: string, anchor: string): Ref => ({
  label: `Mediated Sign-In ${section}`,
  url: `${SITE}/extensions/mediated-sign-in#${anchor}`
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
  "version-unsupported": {
    basis: "MUST", title: "Unsupported protocol version",
    explain: "Before 1.0, every major.minor version can break compatibility. An agent must explicitly support the declared version.",
    fix: "Use a supported protocol version or upgrade the agent.", ref: spec("3.1", "fields")
  },
  // Fetching
  "http-not-https": {
    basis: "MUST",
    title: "Not an HTTPS URL",
    explain: "Discovery documents, metadata and key sets are fetched only over HTTPS.",
    fix: "Serve the document over HTTPS and link to it with an https:// URL.",
    ref: spec("3", "discovery")
  },
  "http-non-public-host": {
    basis: "MUST",
    title: "Not a public host",
    explain:
      "Personal Agents and Companies MUST NOT connect to a loopback, private or link-local address for a URL the other party gave them, unless they were configured to on purpose (3). By name alone, this validator, like our client, never fetches IP literals, single-label hosts, or special-use and private-use names such as localhost, .local, .internal and .home.arpa, so it can't check a document there. A name can still resolve to a private address: on Cloudflare Workers the platform refuses those connections, and the command-line validator checks each address a name resolves to (http-non-public-address). Used as a library elsewhere, it checks names only, so the caller must supply a fetcher that checks addresses.",
    fix: "Publish the document on a public DNS name.",
    ref: spec("3", "discovery")
  },
  "http-non-public-address": {
    basis: "MUST",
    title: "Resolves to a private address",
    explain:
      "Personal Agents and Companies MUST NOT connect to a loopback, private or link-local address for a URL the other party gave them (3), and the Guides say to judge by the address actually connected to. The host name is public, but it resolves to such an address (loopback, RFC 1918, link-local, carrier-grade NAT, unique local, unspecified, multicast or another range that isn't globally reachable), so nothing was checked there. The command-line validator resolves each name itself, refuses these, and connects only to the address it checked.",
    fix: "Point the name at a public address.",
    ref: spec("3", "discovery")
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
    basis: "Rule",
    title: "Client metadata is served by a redirect",
    explain:
      "A Company fetches the client metadata at client_id without following redirects, as the CIMD draft (§5) requires (5.3), and client_id MUST equal the URL the document was fetched from (4.1). A redirect there fails verification at every Company, so this validator doesn't follow it either.",
    fix: "Serve the client metadata document directly at its client_id URL.",
    ref: spec("5.3", "session-verification")
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
    explain: "The request failed before a response arrived: DNS, TLS, the connection, or the timeout (10 seconds, the top of the Guides' \"few seconds\", so a serverless Company's cold start fits). Nothing was checked, and our client can't use a document it couldn't fetch.",
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
  "json-resource-limit": {
    basis: "Guides",
    refuses: true,
    title: "JSON location metadata exceeds the validator's resource allowance",
    explain: "Our client limits cumulative escaped JSON-pointer strings to one million UTF-16 code units, before constructing them. A long member name repeated in every child's location can otherwise use far more memory than the document's byte size. This is an implementation policy for safely processing untrusted documents, not a JSON syntax error or a protocol requirement. Nothing was checked beyond this limit.",
    fix: "Shorten long nested member names or reduce the number of values beneath them.",
    ref: guides("Fetching metadata safely", "both-fetching")
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
      "Every URL the protocol defines or exchanges MUST be an HTTPS URL (3): in poppy.json, in authorization server and protected resource metadata, in client metadata and in extensions. The one exception is a loopback redirect URI in a Personal Agent's redirect_uris (4.1), such as http://127.0.0.1/callback.",
    fix: "Use an https:// URL.",
    ref: spec("3", "discovery")
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
    explain: 'protocol_version is a string of two numbers, such as "0.3".',
    fix: 'Set protocol_version to "0.3".',
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
    title: "Historical newer-minor diagnostic",
    explain:
      "Retained for older saved reports. Current validation uses explicit supported versions and refuses unknown 0.x drafts; this diagnostic is no longer emitted.",
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
      "organization.domain MUST be the host that serves the document, after any redirects, compared ignoring case and nothing else, so www.example.com and example.com differ. Otherwise a document copied to another domain could speak for the Company.",
    fix: "Set organization.domain to the host whose /.well-known/poppy.json serves this document.",
    ref: spec("3.1", "fields")
  },
  "organization-name-missing": {
    basis: "Rule",
    title: "No display name",
    explain:
      "organization is required and is the Company's \"Display name and domain\" (3.1): a normative statement without a key word, so a missing or blank name is an error. Personal Agents show organization.name to the User, such as next to a Device Sign-In link (4.3), so our client refuses a Company without one.",
    fix: "Add organization.name, such as \"Example Company\".",
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
    explain: "poppy.json lists nothing that needs an issuer (agent, apis, feedback, web.browser_session_endpoint or an extension that uses one), so agents browse the site as ordinary signed-out visitors (3.2).",
    fix: "To offer Sessions, APIs or conversations, list them and publish the domain's protected resource metadata naming an issuer.",
    ref: spec("3.2", "oauth-server")
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
  "scope-undescribed": {
    basis: "MUST",
    title: "Supported scope has no description",
    explain:
      "The Company MUST describe each scope in scopes_supported, so agents can choose the ones a task needs and explain them to the User: in an OAuth security scheme of an OpenAPI description poppy.json lists, or otherwise in auth.scopes (4.7). poppy.json lists no OpenAPI description, so auth.scopes has to describe every one. (0.3 replaced 0.2's auth.custom_scopes with auth.scopes.)",
    fix: "Add the scope to auth.scopes with a short description, or leave it out of scopes_supported.",
    ref: spec("4.7", "scopes")
  },
  "scopes-empty": {
    basis: "Reading",
    title: "Mediated Sign-In grants no scopes",
    explain: "The Mediated Sign-In extension's scopes list is empty, so it can't grant anything and agents can't usefully use it.",
    fix: "List the scopes Mediated Sign-In can grant.",
    ref: mediatedExt("2", "support")
  },
  "scope-duplicate": {
    basis: "Reading",
    title: "Scope listed twice",
    explain: "The same scope appears twice in one list.",
    fix: "Remove the duplicate.",
    ref: mediatedExt("2", "support")
  },
  "mediated-fields-empty": {
    basis: "Reading",
    refuses: true,
    title: "Mediated Sign-In lists no fields",
    explain:
      "The Mediated Sign-In extension's fields list the credentials the agent sends. The extension doesn't say the list can't be empty, but without any, agents have nothing to send and can't sign in. Our reading, so a warning; our client refuses it.",
    fix: "List each credential with name, label and secret.",
    ref: mediatedExt("2", "support")
  },
  "mediated-field-duplicate": {
    basis: "Rule",
    title: "Credential field named twice",
    explain: "Each field's name is the parameter the agent sends it in, so names must be unique.",
    fix: "Give each field a different name.",
    ref: mediatedExt("2", "support")
  },
  "mediated-secret-missing": {
    basis: "Reading",
    title: "Field doesn't say whether it's secret",
    explain:
      "secret marks a value the agent must protect: never shown back, logged, or sent elsewhere. Without it, agents treat the value as not secret.",
    fix: "Add secret: true or secret: false.",
    ref: mediatedExt("2", "support")
  },
  "mediated-looks-secret": {
    basis: "Reading",
    title: "Credential looks secret but isn't marked",
    explain: "The field's name or label looks like a password, PIN or code, but secret is false, so agents may show or log it.",
    fix: "Set secret: true.",
    ref: mediatedExt("2", "support")
  },
  "no-poppy-protocol": {
    basis: "Reading",
    title: "No poppy conversation protocol",
    explain:
      "agent.protocols has no entry of type poppy, the only conversation protocol the draft defines, so most agents can't talk to the Company Agent.",
    fix: 'Add { "type": "poppy", "endpoint": "https://…" }.',
    ref: spec("8.1", "conversation-protocols")
  },
  "protocol-type-unknown": {
    basis: "Rule",
    note: true,
    title: "Conversation protocol agents may not know",
    explain: "Agents skip conversation protocol types they don't support.",
    fix: "Nothing to do, as long as a poppy entry is listed too.",
    ref: spec("8.1", "conversation-protocols")
  },
  "api-type-unknown": {
    basis: "SHOULD",
    note: true,
    title: "API type not defined in this version",
    explain:
      "This version defines the API types openapi and mcp (7). A Company may list others, and Personal Agents SHOULD skip types they don't recognize, as ours does: it skips the API and still uses the Company. (Before 0.3 another type broke a MUST.)",
    fix: "Nothing to do, unless agents should use this API: then also list it as openapi or mcp.",
    ref: spec("7", "apis")
  },
  "api-type-newer": {
    basis: "MUST",
    note: true,
    title: "Historical unknown-API-type diagnostic",
    explain:
      "Retained for older saved reports. It was information for a document from a version newer than this validator knew; the 0.2 profile kept it for 0.2 documents until 26 October 2026. 0.3 lets a Company list other API types, which api-type-unknown notes, so this diagnostic is no longer emitted.",
    fix: "Nothing to do, unless agents should use this API.",
    ref: spec("7", "apis")
  },
  "api-description-missing": {
    basis: "Rule",
    refuses: false,
    title: "API has no description",
    explain:
      "\"Each has a type …, a url, and a short description that helps the Personal Agent pick the right one\" (3.1): a normative statement without a key word, so this is an error. Our client still uses the API.",
    fix: "Add a description, such as \"Orders, returns, and exchanges\".",
    ref: spec("3.1", "fields")
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
      "\"Each entry has a version, the extension's major version\" (3.3), but the draft doesn't give its JSON type (spec-issues N22); every example is a string, such as \"1\". Our reading is a string, so a number is a warning. Agents that compare it as a string, ours included, don't recognise the version and ignore the extension.",
    fix: "Write the version as a string, such as \"1\".",
    ref: spec("3.3", "extensions")
  },

  // OAuth authorization server metadata
  "metadata-issuer-mismatch": {
    basis: "MUST",
    title: "Metadata issuer doesn't match the Company's issuer",
    explain:
      "The metadata's issuer must exactly equal the issuer the domain's protected resource metadata names (and auth.issuer, when poppy.json chooses one), character for character. Otherwise any domain could claim another Company's issuer and receive its tokens.",
    fix: "Make the two strings identical, including any trailing slash.",
    ref: spec("3.2", "oauth-server")
  },
  "metadata-dpop-alg": {
    basis: "Rule",
    note: true,
    title: "ES256 not advertised for DPoP",
    explain:
      "Binding access tokens with DPoP is the Company's choice, and the protocol names no algorithm for DPoP proofs (4.5). A Personal Agent sends a proof when it shares an algorithm in dpop_signing_alg_values_supported; ours signs proofs with ES256 only, so here it sends none, and a Company that requires DPoP refuses its token requests.",
    fix: "Add ES256, if the Company binds tokens with DPoP.",
    ref: spec("4.5", "access-tokens")
  },
  "metadata-pkce": {
    basis: "Guides",
    title: "S256 not advertised for PKCE",
    explain: "Direct Sign-In uses PKCE with S256, and code_challenge_methods_supported doesn't list it.",
    fix: "Add S256.",
    ref: spec("4.2", "direct-sign-in")
  },
  // 0.3 (spec/draft-0.3-retrieved-2026-10-29)
  "poppy-redirect-path": {
    basis: "MUST",
    title: "Redirected away from the well-known path",
    explain: "A redirect may move poppy.json to another host, but agents use it only when the last URL's path is exactly /.well-known/poppy.json, with no query. Otherwise anyone who can serve a file from some path on a domain could have it speak for that domain.",
    fix: "Redirect to /.well-known/poppy.json on the other host, without a query.",
    ref: spec("3", "discovery")
  },
  "prm-resource-mismatch": {
    basis: "MUST",
    title: "Protected resource metadata names another resource",
    explain: "The domain's protected resource metadata is how agents find the issuer. Its resource must be exactly https:// and the domain.",
    fix: "Set resource to https://{organization.domain}.",
    ref: spec("3.2", "oauth-server")
  },
  "prm-no-issuer": {
    basis: "MUST",
    title: "No authorization server",
    explain: "authorization_servers in the domain's protected resource metadata names the Company's issuer. Empty, there is none, and agents can only browse the website.",
    fix: "List the Company's issuer in authorization_servers.",
    ref: spec("3.2", "oauth-server")
  },
  "issuer-not-listed": {
    basis: "MUST",
    title: "auth.issuer isn't an authorization server of the domain",
    explain: "auth.issuer only chooses among the domain's authorization_servers, so it must be one of them.",
    fix: "Make auth.issuer one of the domain's authorization_servers, or leave it out when there is one.",
    ref: spec("3.1", "fields")
  },
  "issuer-ambiguous": {
    basis: "MUST",
    title: "Several authorization servers and no auth.issuer",
    explain: "User IDs and refresh tokens belong to one issuer, so every agent has to choose the same one. With more than one authorization server, auth.issuer says which.",
    fix: "Add auth.issuer, naming the server agents use.",
    ref: spec("3.1", "fields")
  },
  "metadata-protected-resources": {
    basis: "MUST",
    title: "protected_resources doesn't include the domain",
    explain: "The issuer confirms the domain from its side by listing https://{domain} in protected_resources. Agents refuse a domain it doesn't list, so a domain can't claim another Company's issuer.",
    fix: "Add https:// and organization.domain to protected_resources, with no path, port or trailing slash.",
    ref: spec("3.2", "oauth-server")
  },
  "metadata-refresh-grant": {
    basis: "MUST",
    title: "No refresh_token grant",
    explain: "grant_types_supported must include refresh_token: every sign-in returns a refresh token, which agents use to get access tokens later.",
    fix: "Add refresh_token to grant_types_supported.",
    ref: spec("3.2", "oauth-server")
  },
  "scope-hint-invalid": {
    basis: "MUST",
    title: "Scope hint without changes and personal_data",
    explain: "Each entry in auth.scope_hints must have both fields: changes, a string, and personal_data, a boolean.",
    fix: "Give the scope's hint both fields, or leave the scope out of scope_hints.",
    ref: spec("4.7", "scopes")
  },
  "scope-hint-changes-unknown": {
    basis: "MUST",
    note: true,
    title: "changes value this version doesn't define",
    explain: "This version defines none, reversible and irreversible. Agents treat any other value as irreversible, so later versions can add values.",
    fix: "Use none, reversible or irreversible, unless a later version defines the value.",
    ref: spec("4.7", "scopes")
  },
  "mediated-field-reserved": {
    basis: "MUST",
    title: "Mediated Sign-In field with a reserved name",
    explain: "A field's name is a parameter of the token request, so it can't be grant_type, scope, resource, a client authentication parameter, or one the extension defines.",
    fix: "Rename the field.",
    ref: mediatedExt("2", "support")
  },
  "mediated-grant-missing": {
    basis: "MUST",
    title: "Mediated Sign-In's grant isn't advertised",
    explain: "A Company that offers Mediated Sign-In lists its grant type in the issuer's grant_types_supported.",
    fix: "Add https://personalagentprotocol.org/grant/mediated-sign-in to grant_types_supported.",
    ref: mediatedExt("2", "support")
  },
  "mediated-scope-unsupported": {
    basis: "MUST",
    title: "Mediated Sign-In offers a scope the issuer doesn't support",
    explain: "Every scope the extension lists must be in the issuer's scopes_supported.",
    fix: "Add the scope to scopes_supported, or remove it from the extension's scopes.",
    ref: mediatedExt("2", "support")
  },
  "metadata-iss-parameter": {
    basis: "Rule",
    note: true,
    title: "Authorization responses may not carry iss",
    explain:
      "authorization_response_iss_parameter_supported isn't true. The redirect back from Direct Sign-In carries the issuer in iss (4.2, RFC 9207), and agents check it, as ours does; the metadata doesn't say this issuer sends it.",
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
    explain: "jwks_uri, and every redirect URI that isn't a loopback redirect URI (RFC 8252 §7.3), must be an HTTPS URL on the same domain as client_id.",
    fix: "Host them on client_id's domain.",
    ref: spec("4.1", "agent-identity")
  },
  "client-auth-method": {
    basis: "Rule",
    title: "Token endpoint auth method isn't private_key_jwt",
    explain:
      "Personal Agents authenticate with private_key_jwt (4.1, 4.8), and the draft's example declares it. The draft has no MUST for the member, but without it OAuth's default (client_secret_basic, RFC 7591 §2) applies, which doesn't fit.",
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
      "Companies MUST accept client assertions and delegations signed with ES256 and with PS384 (4.1, 5.2), and the Guides say to sign with one of them, so Companies may accept only EC P-256 and RSA keys. The draft doesn't restrict key types, so this is a warning.",
    fix: "Use an EC P-256 key, or an RSA key of at least 2048 bits for PS384.",
    ref: guides("Signing and verifying JWTs", "both-signing")
  },
  "jwks-rsa-small": {
    basis: "RFC",
    title: "RSA key too small",
    explain: "RSA signatures, PS384 included, MUST use a key of 2048 bits or larger (RFC 7518 §3.3, §3.5); the Guides say the same.",
    fix: "Generate a 2048-bit or larger key, or use EC P-256.",
    ref: rfc(7518, "3.3")
  },
  "jwks-alg": {
    basis: "Guides",
    title: "Key algorithm isn't ES256 or PS384",
    explain:
      "The keys in jwks_uri sign client assertions and delegations. Companies MUST accept both signed with ES256 and with PS384 (4.1), a delegation's alg is one of the two (5.2), and the Guides say to sign with ES256, or PS384 when signing blindly. A key marked with another alg may be ignored. One marked RS256 can sign client assertions only, which the Guides ask Companies to accept too, and never delegations, so it can't make Session JWTs.",
    fix: "Use ES256, or PS384 for blind signing.",
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
