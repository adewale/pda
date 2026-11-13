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
 * The messages check 0.4 (spec/draft-0.4-retrieved-2026-11-11) and the 1.0
 * draft (spec/draft-1.0-retrieved-2026-11-13). The links go to 0.4's pages,
 * or 1.0's (`spec10`) for a rule 0.4 doesn't have. Where 0.3, 0.4 or 1.0
 * changed a rule a Company may still follow, the explanation says what
 * replaced it.
 *
 * A MUST, SHOULD or Rule message quotes the sentence it enforces in
 * `requires`, verbatim in every runtime pin and with its key word, so that
 * `npm run check:spec` fails when the text changes upstream
 * (scripts/check-requirements.mjs). A message whose ref is an RFC rests on
 * that RFC instead.
 */
import { levelOf, severityOf, type Basis, type Severity } from "./levels.ts";

export type { Basis, Severity };

export type Ref = { readonly label: string; readonly url: string };

/** The pages of the version this validator checks, 0.4. */
const SITE = "https://personalagentprotocol.org/docs/0.4";

export const spec = (section: string, anchor: string): Ref => ({
  label: `Spec ${section}`,
  url: `${SITE}/spec#${anchor}`
});
/** A section of the 1.0 draft's specification, for a rule 0.4 doesn't have. */
export const spec10 = (section: string, anchor: string): Ref => ({
  label: `Spec ${section} (1.0)`,
  url: `https://personalagentprotocol.org/docs/1.0/spec#${anchor}`
});
export const guides = (title: string, anchor: string): Ref => ({
  label: `Guides: ${title}`,
  url: `${SITE}/guides#${anchor}`
});
/** A section of an extension's page, such as ("operations", "Operations", "2", "support"). */
export const extension = (name: string, title: string, section: string, anchor: string): Ref => ({
  label: `${title} ${section}`,
  url: `${SITE}/extensions/${name}#${anchor}`
});
export const mediatedExt = (section: string, anchor: string): Ref => extension("mediated-sign-in", "Mediated Sign-In", section, anchor);
export const rfc = (number: number, section?: string): Ref => ({
  label: `RFC ${number}${section ? ` §${section}` : ""}`,
  url: `https://www.rfc-editor.org/rfc/rfc${number}${section ? `#section-${section}` : ""}`
});

type Definition = {
  /** What the message rests on; its severity follows. */
  readonly basis: Basis;
  /**
   * For a MUST, SHOULD or Rule: the sentence it enforces, verbatim from every
   * runtime pin, with its key word (scripts/check-requirements.mjs).
   */
  readonly requires?: string;
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
    basis: "MUST",
    requires: "The Personal Agent chooses the newest version … compatible with one it implements … If none is, it MUST NOT use any of them",
    title: "Unsupported protocol version",
    explain: "Before 1.0, every major.minor version can break compatibility. An agent must explicitly support the declared version.",
    fix: "Use a supported protocol version or upgrade the agent.", ref: spec("3.1", "fields")
  },
  // Fetching
  "http-not-https": {
    basis: "MUST",
    requires: "Every URL this protocol defines or exchanges MUST be an HTTPS URL",
    title: "Not an HTTPS URL",
    explain: "Discovery documents, metadata and key sets are fetched only over HTTPS.",
    fix: "Serve the document over HTTPS and link to it with an https:// URL.",
    ref: spec("3", "discovery")
  },
  "http-non-public-host": {
    basis: "MUST",
    requires: "Personal Agents and Companies MUST NOT connect to a loopback, private, or link-local address for a URL the other party gave them, unless they were configured to on purpose",
    title: "Not a public host",
    explain:
      "Personal Agents and Companies MUST NOT connect to a loopback, private or link-local address for a URL the other party gave them, unless they were configured to on purpose (3). By name alone, this validator, like our client, never fetches IP literals, single-label hosts, or special-use and private-use names such as localhost, .local, .internal and .home.arpa, so it can't check a document there. A name can still resolve to a private address: on Cloudflare Workers the platform refuses those connections, and the command-line validator checks each address a name resolves to (http-non-public-address). Used as a library elsewhere, it checks names only, so the caller must supply a fetcher that checks addresses.",
    fix: "Publish the document on a public DNS name.",
    ref: spec("3", "discovery")
  },
  "http-non-public-address": {
    basis: "MUST",
    requires: "Personal Agents and Companies MUST NOT connect to a loopback, private, or link-local address for a URL the other party gave them, unless they were configured to on purpose",
    title: "Resolves to a private address",
    explain:
      "Personal Agents and Companies MUST NOT connect to a loopback, private or link-local address for a URL the other party gave them (3), and the Guides say to judge by the address actually connected to. The host name is public, but it resolves to such an address (loopback, RFC 1918, link-local, carrier-grade NAT, unique local, unspecified, multicast or another range that isn't globally reachable), so nothing was checked there. The command-line validator resolves each name itself, refuses these, and connects only to the address it checked.",
    fix: "Point the name at a public address.",
    ref: spec("3", "discovery")
  },
  "http-redirect-not-https": {
    basis: "MUST",
    requires: "Personal Agents MUST follow redirects, and every redirect MUST be to an HTTPS URL",
    title: "Redirect to a non-HTTPS URL",
    explain: "Every redirect from the well-known URL must be to an HTTPS URL. Agents stop at the first one that isn't.",
    fix: "Make each Location header an https:// URL.",
    ref: spec("3", "discovery")
  },
  "http-too-many-redirects": {
    basis: "Guides",
    requires: "Set limits: a few redirects at most",
    refuses: true,
    title: "Too many redirects",
    explain:
      "The draft says agents MUST follow redirects but sets no limit; the Guides recommend a few at most. This validator, like our client, follows 3.",
    fix: "Redirect straight to where the document lives.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-redirect-not-allowed": {
    basis: "Rule",
    requires: "Fetches the client metadata from iss without following redirects, as the CIMD draft (§5) requires",
    title: "Client metadata is served by a redirect",
    explain:
      "A Company fetches the client metadata at client_id without following redirects, as the CIMD draft (§5) requires (5.3), and client_id MUST equal the URL the document was fetched from (4.1). A redirect there fails verification at every Company, so this validator doesn't follow it either.",
    fix: "Serve the client metadata document directly at its client_id URL.",
    ref: spec("5.3", "session-verification")
  },
  "http-status": {
    basis: "MUST",
    requires: "A Company MUST publish its poppy.json document at https://{domain}/.well-known/poppy.json over HTTPS",
    title: "Not served with HTTP 200",
    explain: "The document must be served successfully for anyone to use it.",
    fix: "Serve the document with status 200.",
    ref: spec("3", "discovery")
  },
  "http-failed": {
    basis: "Guides",
    requires: "Set limits: … a timeout of a few seconds",
    refuses: true,
    title: "Couldn't fetch the document",
    explain: "The request failed before a response arrived: DNS, TLS, the connection, or the timeout (10 seconds, the top of the Guides' \"few seconds\", so a serverless Company's cold start fits). Nothing was checked, and our client can't use a document it couldn't fetch.",
    fix: "Check that the URL is reachable from the public internet and answers within a few seconds.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "http-too-large": {
    basis: "Guides",
    requires: "Set limits: … a response size such as 100 KB",
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
    requires: "Set limits: a few redirects at most, a response size such as 100 KB, and a timeout of a few seconds",
    refuses: true,
    title: "JSON location metadata exceeds the validator's resource allowance",
    explain: "Our client limits cumulative escaped JSON-pointer strings to one million UTF-16 code units, before constructing them. A long member name repeated in every child's location can otherwise use far more memory than the document's byte size. This is an implementation policy for safely processing untrusted documents, not a JSON syntax error or a protocol requirement. Nothing was checked beyond this limit.",
    fix: "Shorten long nested member names or reduce the number of values beneath them.",
    ref: guides("Fetching metadata safely", "both-fetching")
  },
  "json-duplicate-member": {
    basis: "Guides",
    requires: "Encode JSON as UTF-8 and reject objects with duplicate member names",
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
    requires: "| protocol_version | Yes | The protocol version the document follows, as major.minor",
    title: "Required member missing",
    explain: "A member the specification requires isn't there.",
    fix: "Add the member described in the message.",
    ref: spec("3.1", "fields")
  },
  "wrong-type": {
    basis: "Rule",
    requires: "A list of APIs. Each has a type",
    title: "Wrong type",
    explain: "A member has the wrong JSON type, such as a string where an object is required.",
    fix: "Use the type given in the message.",
    ref: spec("3.1", "fields")
  },
  "not-a-url": {
    basis: "MUST",
    requires: "Every URL this protocol defines or exchanges MUST be an HTTPS URL",
    title: "Not an absolute URL",
    explain: "The value must be an absolute URL with a host name (or an IP address), such as https://api.example.com/.",
    fix: "Use a full URL, starting with https://.",
    ref: spec("3.1", "fields")
  },
  "not-https-url": {
    basis: "MUST",
    requires: "Every URL this protocol defines or exchanges MUST be an HTTPS URL",
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
    requires: "The protocol version the document follows, as major.minor",
    title: "protocol_version isn't major.minor",
    explain: 'protocol_version is a string of two numbers, such as "0.4".',
    fix: 'Set protocol_version to "0.4".',
    ref: spec("3.1", "fields")
  },
  "version-unsupported-major": {
    basis: "MUST",
    requires: "The Personal Agent chooses the newest version … compatible with one it implements … If none is, it MUST NOT use any of them",
    title: "Unsupported major version",
    explain: "A Personal Agent must not use a document whose major version it doesn't support. This validator knows the versions listed on the validator page.",
    fix: "Publish a document for a supported major version, or check a newer validator.",
    ref: spec("3.1", "fields")
  },
  "version-newer-minor": {
    basis: "Rule",
    note: true,
    title: "Checked with an older minor version's rules",
    explain:
      "From 1.0, a newer minor version doesn't break older Personal Agents, which use the document and ignore what it adds (3.1, 3.4). This validator checks it with the rules of the newest version it knows with the same major version, so members only the newer version defines are reported as unknown. Before 1.0 every 0.x version is its own, and an unknown one is refused.",
    fix: "Nothing to do.",
    ref: spec10("3.4", "versions")
  },
  "domain-invalid": {
    basis: "MUST",
    requires: "domain MUST be the host that serves the document, after any redirects",
    title: "Not a domain name",
    explain: "The value must be a DNS host name, such as example.com, with no scheme or path. From 1.0, organization.domain may carry its port when that isn't 443, such as shop.test:8443 for testing (3.1); 0.4 allows no port.",
    fix: "Use the bare host name, or under 1.0 the host name and a port other than 443.",
    ref: spec("3.1", "fields")
  },
  "organization-domain-mismatch": {
    basis: "MUST",
    requires: "domain MUST be the host that serves the document, after any redirects",
    title: "organization.domain doesn't match the requested domain",
    explain:
      "organization.domain MUST be the host that serves the document, after any redirects, compared ignoring case and nothing else, so www.example.com and example.com differ. Otherwise a document copied to another domain could speak for the Company.",
    fix: "Set organization.domain to the host whose /.well-known/poppy.json serves this document.",
    ref: spec("3.1", "fields")
  },
  "organization-name-missing": {
    basis: "Rule",
    requires: "The Company's display name, its domain, and an optional logo_uri",
    title: "No display name",
    explain:
      "organization is required and is the Company's \"Display name and domain\" (3.1): a normative statement without a key word, so a missing or blank name is an error. Personal Agents show organization.name to the User, such as next to a Device Sign-In link (4.3), so our client refuses a Company without one.",
    fix: "Add organization.name, such as \"Example Company\".",
    ref: spec("3.1", "fields")
  },
  "nothing-offered": {
    basis: "Rule",
    requires: "| agent | At least one of agent, apis, or web |",
    title: "No agent, apis or web",
    explain: "A poppy.json must offer at least one of agent, apis, or web.",
    fix: "Add the Company Agent, an API, or the website.",
    ref: spec("3.1", "fields")
  },
  "website-only": {
    basis: "Rule",
    note: true,
    title: "Website only",
    explain: "poppy.json lists nothing that uses Sessions (agent, apis, tasks, web.browser_session_endpoint or an extension), so agents browse the site as ordinary signed-out visitors (3.1, 6).",
    fix: "To offer Sessions, list the APIs, Company Agent or browser-session endpoint. Signed-out Sessions need no issuer (3.2); sign-in does.",
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
    basis: "SHOULD",
    requires: "The Company SHOULD describe each scope it offers Personal Agents, so the Personal Agent can choose the ones a task needs",
    title: "Supported scope has no description",
    explain:
      "The Company SHOULD describe each scope it offers Personal Agents, so the Personal Agent can choose the ones a task needs: in an OAuth security scheme of an OpenAPI description poppy.json lists, or otherwise in auth.scopes (4.7). poppy.json lists no OpenAPI description, so only auth.scopes can describe them. When the domain's protected resource metadata lists scopes_supported, those are the scopes checked: the issuer's own list may hold scopes for its other resources and clients (3.2). 0.3's text of 29 October made it a MUST for every scope in scopes_supported; by 3 November it was this SHOULD.",
    fix: "Add the scope to auth.scopes with a short description. A scope offered only to other clients can be left out of scopes_supported, or the domain's protected resource metadata can list the scopes it offers.",
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
    requires: "name is the parameter the Personal Agent sends",
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
  "protocol-description-empty": {
    basis: "MUST",
    requires: "The Company MUST include a description in every entry",
    title: "Empty conversation protocol description",
    explain:
      "From 1.0, every agent.protocols entry has a description of what the agent at that endpoint can help with, which a Personal Agent uses to decide whether a conversation serves the task and to choose between the entries and the Company's APIs (8.1). An empty one says nothing.",
    fix: 'Say what the agent there can help with, such as "Orders, returns and your account", or that it can help with anything.',
    ref: spec10("8.1", "conversation-protocols")
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
    requires: "Each has a type, such as those in section 7, a url, and a short description that helps the Personal Agent pick the right one",
    refuses: false,
    title: "API has no description",
    explain:
      "\"Each has a type …, a url, and a short description that helps the Personal Agent pick the right one\" (3.1): a normative statement without a key word, so this is an error. Our client still uses the API.",
    fix: "Add a description, such as \"Orders, returns, and exchanges\".",
    ref: spec("3.1", "fields")
  },
  "extension-name": {
    basis: "MUST",
    requires: "Anyone else MUST start an extension's name with a domain they control",
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
    requires: "the Personal Agent fetches the metadata and MUST check that its issuer exactly matches the issuer it found, character for character",
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
    requires: "Accept PKCE with S256 only, and reject plain",
    title: "S256 not advertised for PKCE",
    explain: "Direct Sign-In uses PKCE with S256, and code_challenge_methods_supported doesn't list it.",
    fix: "Add S256.",
    ref: spec("4.2", "direct-sign-in")
  },
  "poppy-redirect-path": {
    basis: "MUST",
    requires: "Personal Agents MUST use the document only when the last URL's path is exactly /.well-known/poppy.json and it has no query",
    title: "Redirected away from the well-known path",
    explain: "A redirect may move poppy.json to another host, but agents use it only when the last URL's path is exactly /.well-known/poppy.json, with no query. Otherwise anyone who can serve a file from some path on a domain could have it speak for that domain.",
    fix: "Redirect to /.well-known/poppy.json on the other host, without a query.",
    ref: spec("3", "discovery")
  },
  "prm-resource-mismatch": {
    basis: "MUST",
    requires: "its resource MUST be exactly https://{organization.domain}",
    title: "Protected resource metadata names another resource",
    explain: "The domain's protected resource metadata is how agents find the issuer. Its resource must be exactly https:// and the domain.",
    fix: "Set resource to https://{organization.domain}.",
    ref: spec("3.2", "oauth-server")
  },
  "prm-no-issuer": {
    basis: "Rule",
    note: true,
    title: "No OAuth issuer: signed-out Sessions only",
    explain: "A 404 for the domain's protected resource metadata, or metadata whose authorization_servers is absent or empty, means the Company has no OAuth issuer (3.2). That is valid for a Company that offers no sign-in: agents use its APIs, conversations, tasks endpoint and browser join signed out, and its identifier, the audience of Session JWTs and the scope of User IDs, is https:// and organization.domain. Agents don't fall back to this after a timeout, another error status or invalid metadata. Adding an issuer later changes the identifier when it differs from the domain, so agents then start new User IDs and Sessions.",
    fix: "Nothing to do for signed-out access. To offer sign-in, publish protected resource metadata whose authorization_servers names the issuer.",
    ref: spec("3.2", "oauth-server")
  },
  "issuer-required": {
    basis: "MUST",
    requires: "A Company that offers sign-in MUST have an OAuth issuer",
    title: "Sign-in offered without an issuer",
    explain: "A Company that offers sign-in MUST have an OAuth issuer (3.2). auth.issuer, the Mediated Sign-In extension and signed_in access each offer sign-in, but the domain's protected resource metadata says there is no issuer.",
    fix: "Publish protected resource metadata whose authorization_servers names the issuer, or remove what offers sign-in.",
    ref: spec("3.2", "oauth-server")
  },
  "auth-disabled-sign-in": {
    basis: "MUST",
    requires: "A Company that sets auth.disabled MUST NOT list the Mediated Sign-In extension or signed_in access",
    title: "auth.disabled, but sign-in is still offered",
    explain: "A Company that sets auth.disabled offers Personal Agents no sign-in, so it MUST NOT list the Mediated Sign-In extension or signed_in access (3.2).",
    fix: "Remove the Mediated Sign-In extension and signed_in access, or stop setting auth.disabled.",
    ref: spec("3.2", "oauth-server")
  },
  "access-unknown": {
    basis: "Rule",
    note: true,
    title: "Conversation access hint agents don't know",
    explain: "A poppy conversation entry's access is session (the default) or signed_in (3.2). Agents ignore any other value and treat the entry as if it had no hint.",
    fix: "Use session or signed_in, or leave access out.",
    ref: spec("3.2", "oauth-server")
  },
  "scopes-supported-missing": {
    basis: "SHOULD",
    requires: "A Company that offers sign-in SHOULD list every scope a Personal Agent can request here",
    title: "No scopes_supported",
    explain: "A Company that offers sign-in SHOULD publish scopes_supported in its OAuth metadata, or in its protected resource metadata, and include every scope a Personal Agent can request (3.2, 4.7). Without either, agents learn scopes only from the Company's OpenAPI descriptions and auth.scopes. (Earlier text of draft 0.3 required it in the OAuth metadata.)",
    fix: "Add scopes_supported, listing the scopes Personal Agents may request.",
    ref: spec("3.2", "oauth-server")
  },
  "skill-index-schema": {
    basis: "SHOULD",
    note: true,
    title: "Historical skill-index schema diagnostic",
    explain:
      "Retained for older saved reports. It warned of a skill_index in a 0.3 poppy.json whose $schema wasn't the Agent Skills discovery 0.2.0 identifier, which agents ignored. 0.4 moved the skill index to the response from tasks.endpoint (9), which this validator doesn't fetch, so this diagnostic is no longer emitted; member-moved-to-tasks notes a skill_index left in poppy.json.",
    fix: "Nothing to do.",
    ref: spec("9.4", "agent-context")
  },
  "skill-digest": {
    basis: "MUST",
    note: true,
    title: "Historical skill-digest diagnostic",
    explain:
      "Retained for older saved reports. It reported a skill entry in a 0.3 poppy.json's skill_index whose digest wasn't sha256: and 64 lowercase hex characters. 0.4 moved the skill index to the response from tasks.endpoint (9), which this validator doesn't fetch, so this diagnostic is no longer emitted.",
    fix: "Nothing to do.",
    ref: spec("9.4", "agent-context")
  },
  "issuer-not-listed": {
    basis: "MUST",
    requires: "naming the one Personal Agents use (3.2). It MUST be in that list.",
    title: "auth.issuer isn't an authorization server of the domain",
    explain: "auth.issuer only chooses among the domain's authorization_servers, so it must be one of them.",
    fix: "Make auth.issuer one of the domain's authorization_servers, or leave it out when there is one.",
    ref: spec("3.1", "fields")
  },
  "issuer-ambiguous": {
    basis: "Rule",
    requires: "If it lists more than one, such as one for the Company's employees, auth.issuer in poppy.json names the one Personal Agents use",
    title: "Several authorization servers and no auth.issuer",
    explain: "User IDs and refresh tokens belong to one issuer, so every agent has to choose the same one. With more than one authorization server, auth.issuer says which.",
    fix: "Add auth.issuer, naming the server agents use.",
    ref: spec("3.1", "fields")
  },
  "metadata-protected-resources": {
    basis: "MUST",
    requires: "Its protected_resources (RFC 9728 §4) MUST list https://{domain} for every domain whose issuer it is",
    title: "protected_resources doesn't include the domain",
    explain: "The issuer confirms the domain from its side by listing https://{domain} in protected_resources. Agents refuse a domain it doesn't list, so a domain can't claim another Company's issuer.",
    fix: "Add https:// and organization.domain to protected_resources, with no path, port or trailing slash.",
    ref: spec("3.2", "oauth-server")
  },
  "metadata-assertion-algs": {
    basis: "MUST",
    requires: "Companies MUST accept client assertions signed with ES256 and with PS384.",
    title: "Client assertion algorithms leave out ES256 or PS384",
    explain:
      "From 1.0, Companies MUST accept client assertions signed with ES256 and with PS384 (4.1), so a Personal Agent can have them signed blindly (10.7). A token_endpoint_auth_signing_alg_values_supported that leaves either out says the token endpoint refuses them.",
    fix: "Accept both, and list ES256 and PS384 in token_endpoint_auth_signing_alg_values_supported, or leave the member out.",
    ref: spec10("4.1", "agent-identity")
  },
  "par-endpoint-missing": {
    basis: "RFC",
    title: "Pushed Authorization Requests required without an endpoint",
    explain:
      "require_pushed_authorization_requests says the issuer accepts authorization requests only through Pushed Authorization Requests (RFC 9126 §5), but there's no pushed_authorization_request_endpoint to push them to, so a Personal Agent can't start Direct Sign-In (1.0: 4.2).",
    fix: "List pushed_authorization_request_endpoint, or set require_pushed_authorization_requests to false.",
    ref: rfc(9126, "5")
  },
  "metadata-refresh-grant": {
    basis: "MUST",
    requires: "grant_types_supported lists the grant types the token endpoint accepts. Required, and it MUST include refresh_token",
    title: "No refresh_token grant",
    explain: "grant_types_supported must include refresh_token: every sign-in returns a refresh token, which agents use to get access tokens later.",
    fix: "Add refresh_token to grant_types_supported.",
    ref: spec("3.2", "oauth-server")
  },
  "scope-hint-invalid": {
    basis: "MUST",
    requires: "A Company MUST include both fields in each entry.",
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
    requires: "It MUST NOT be grant_type, scope, resource, a client authentication parameter such as client_id or client_assertion, or a parameter this extension defines",
    title: "Mediated Sign-In field with a reserved name",
    explain: "A field's name is a parameter of the token request, so it can't be grant_type, scope, resource, a client authentication parameter, or one the extension defines.",
    fix: "Rename the field.",
    ref: mediatedExt("2", "support")
  },
  "mediated-grant-missing": {
    basis: "Rule",
    requires: "A Company that offers Mediated Sign-In lists it in extensions in its poppy.json (spec 3.3), and lists the grant type https://personalagentprotocol.org/grant/mediated-sign-in in its issuer's grant_types_supported",
    title: "Mediated Sign-In's grant isn't advertised",
    explain: "A Company that offers Mediated Sign-In lists its grant type in the issuer's grant_types_supported.",
    fix: "Add https://personalagentprotocol.org/grant/mediated-sign-in to grant_types_supported.",
    ref: mediatedExt("2", "support")
  },
  "mediated-scope-unsupported": {
    basis: "SHOULD",
    requires: "The Company SHOULD also include them in scopes_supported",
    title: "Mediated Sign-In offers a scope scopes_supported doesn't list",
    explain:
      "The Company SHOULD also include the scopes the extension lists in scopes_supported, in its OAuth server metadata or protected resource metadata (Mediated Sign-In 2). A Personal Agent may still request a scope a sign-in extension documents (4.7), so this is a warning. 0.3's text of 28 October listed all of them in scopes_supported; by 3 November this was a SHOULD.",
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
    requires: "client_id MUST equal the URL the document was fetched from.",
    title: "client_id isn't the URL it was fetched from",
    explain: "A Personal Agent's client_id must equal the URL its metadata document was fetched from.",
    fix: "Set client_id to the exact URL of this document.",
    ref: spec("4.1", "agent-identity")
  },
  "client-other-domain": {
    basis: "MUST",
    requires: "jwks_uri MUST be an HTTPS URL on the same domain as client_id. … Each entry MUST be an HTTPS URL on the same domain as client_id, or a loopback redirect URI",
    title: "URL on a different domain from client_id",
    explain: "jwks_uri, and every redirect URI that isn't a loopback redirect URI (RFC 8252 §7.3), must be an HTTPS URL on the same domain as client_id.",
    fix: "Host them on client_id's domain.",
    ref: spec("4.1", "agent-identity")
  },
  "client-auth-method": {
    basis: "Rule",
    requires: "The Personal Agent authenticates at the token endpoint with a client assertion signed by a key from jwks_uri (private_key_jwt, RFC 7523).",
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
    requires: "The Personal Agent authenticates at the token endpoint with a client assertion signed by a key from jwks_uri",
    title: "No keys",
    explain: "The key set has no keys, so nothing the agent signs can be verified.",
    fix: "Publish at least one public signing key.",
    ref: spec("4.1", "agent-identity")
  },
  "jwks-private-key": {
    basis: "Rule",
    requires: "The key set contains only public keys.",
    title: "Private key material published",
    explain: "The key set contains only public keys. This key has private members (d, p, q, dp, dq, qi or k), so the key is compromised.",
    fix: "Remove the key, generate a new one, and publish only its public part.",
    ref: spec("4.1", "agent-identity")
  },
  "jwks-key-type": {
    basis: "Guides",
    requires: "Sign client assertions and delegations with ES256, or with PS384 if you sign them blindly",
    title: "Unsupported key",
    explain:
      "Companies MUST accept client assertions and delegations signed with ES256, and SHOULD accept PS384 (4.1, 5.2; from 1.0 they MUST accept both), and the Guides say to sign with one of them, so Companies may accept only EC P-256 and RSA keys. The draft doesn't restrict key types, so this is a warning.",
    fix: "Use an EC P-256 key, or for PS384 an RSA key of at least 2048 bits (from 1.0, 2048 to 4096 bits).",
    ref: guides("Signing and verifying JWTs", "both-signing")
  },
  "jwks-rsa-small": {
    basis: "RFC",
    title: "RSA key too small",
    explain: "RSA signatures, PS384 included, MUST use a key of 2048 bits or larger (RFC 7518 §3.3, §3.5); the Guides say the same.",
    fix: "Generate a 2048-bit or larger key, or use EC P-256.",
    ref: rfc(7518, "3.3")
  },
  "jwks-key-material": {
    basis: "RFC",
    title: "Invalid public key",
    explain: "A public EC key needs coordinates of the curve's required size that identify a point on that curve. An RSA key needs a positive odd modulus and an odd public exponent of at least 3. JOSE key members use unpadded base64url, and RSA integers omit leading zero bytes. An alg member must agree with the key type and curve.",
    fix: "Export the complete public JWK from the signing key, keeping its required members and matching algorithm.",
    ref: rfc(7518, "6")
  },
  "jwks-alg": {
    basis: "Guides",
    requires: "Sign client assertions and delegations with ES256, or with PS384 if you sign them blindly",
    title: "Key algorithm isn't ES256 or PS384",
    explain:
      "The keys in jwks_uri sign client assertions and delegations. Companies MUST accept both signed with ES256, and SHOULD accept PS384 (4.1, 5.2; from 1.0 they MUST accept both), a delegation's alg is one of the two (5.2), and the Guides say to sign with ES256, or PS384 when signing blindly; a Company without PS384 can't verify a blind signature. A key marked with another alg may be ignored, and one marked RS256 can't sign delegations, so it can't make Session JWTs.",
    fix: "Use ES256, or PS384 for blind signing.",
    ref: guides("Signing and verifying JWTs", "both-signing")
  },
  "jwks-no-kid": {
    basis: "Guides",
    requires: "Give every key in jwks_uri a kid.",
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
    ref: rfc(7517, "4.5")
  },
  // Versions (3.4), and what 0.4 changed
  "supported-version-unusable": {
    basis: "MUST",
    requires: "Each URL in supported_versions MUST be an HTTPS URL on the host that served poppy.json, after any redirects.",
    refuses: false,
    title: "A supported_versions entry agents can't use",
    explain:
      "supported_versions maps each other protocol version the Company serves, as major.minor, to an HTTPS URL on the host that served poppy.json, after any redirects (3.4). An agent MUST NOT use a document on another host, because any domain's poppy.json could otherwise link to a file uploaded to a Company's domain. Our client skips this entry, as if the version weren't listed, and chooses among the others.",
    fix: "Key each entry by a version such as \"0.5\", other than the document's own, and give an https:// URL on the same host as poppy.json.",
    ref: spec("3.4", "versions")
  },
  "linked-document-version": {
    basis: "MUST",
    requires: "The Personal Agent MUST NOT use it if its protocol_version is another one.",
    title: "A linked document has another protocol version",
    explain: "The document a supported_versions entry links to has the protocol_version it is listed under, and an agent MUST NOT use it otherwise (3.4).",
    fix: "Serve the document for the version it is listed under, or fix the entry.",
    ref: spec("3.4", "versions")
  },
  "linked-document-supported-versions": {
    basis: "Rule",
    requires: "The document there has the protocol_version it is listed under, and no supported_versions.",
    refuses: false,
    title: "A linked document lists supported_versions",
    explain: "Only poppy.json lists the versions a Company serves; the document for another version has no supported_versions (3.4). Our client ignores the member there.",
    fix: "Remove supported_versions from the linked document.",
    ref: spec("3.4", "versions")
  },
  "linked-document-domain": {
    basis: "MUST",
    requires: "Every document a Company serves at the same time MUST have the same organization.domain",
    title: "Versions disagree on the Company's domain",
    explain: "Every document a Company serves at the same time MUST have the same organization.domain, so a new version doesn't change the Company's identifier, and with it User IDs and refresh tokens (3.4).",
    fix: "Give every version's document the same organization.domain.",
    ref: spec("3.4", "versions")
  },
  "extension-entries": {
    basis: "Rule",
    requires: "A Company lists the ones it supports in extensions, with an entry for each major version it supports",
    refuses: false,
    title: "An extension isn't a list of versions",
    explain:
      "From 0.4, extensions maps each extension's name to a list with an entry for each major version the Company supports, each with a version (3.3). 0.3 used a single object. Agents ignore what they don't recognize, so our client skips this extension.",
    fix: "Write the extension as a list, such as \"operations\": [{ \"version\": \"3\" }].",
    ref: spec("3.3", "extensions")
  },
  "member-moved-to-tasks": {
    basis: "MUST",
    note: true,
    title: "Moved to the tasks endpoint in 0.4",
    explain:
      "0.4 moved excluded tasks, the skill index and the feedback endpoint out of poppy.json, to the response from tasks.endpoint, which agents read for each Session (9). 0.4 agents ignore the member.",
    fix: "List tasks.endpoint, and serve excluded_tasks, skill_index and feedback.endpoint from it.",
    ref: spec("9", "task-coverage")
  },
  "web-disabled-browser-session": {
    basis: "MUST",
    requires: "A Company that sets web.disabled MUST NOT list browser_session_endpoint",
    title: "web.disabled with a browser-session endpoint",
    explain: "A Company that sets web.disabled asks agents not to use a browser on its website, so it MUST NOT list browser_session_endpoint (6).",
    fix: "Remove web.browser_session_endpoint, or web.disabled.",
    ref: spec("6", "web-browsing")
  },
  "web-disabled-no-alternative": {
    basis: "MUST",
    requires: "A Company that sets web.disabled MUST NOT list browser_session_endpoint, and MUST list agent or apis.",
    title: "web.disabled with nothing else to use",
    explain: "A Company that asks agents not to browse its website MUST list agent or apis, so they have something to use instead (6).",
    fix: "List the Company Agent or an API, or remove web.disabled.",
    ref: spec("6", "web-browsing")
  },
  "operations-endpoint-without-join": {
    basis: "MUST",
    requires: "It MUST list web.browser_session_endpoint with it",
    title: "Website operations without browser join",
    explain: "An operations entry's endpoint is for operations a website returns to a browser joined to a Session, so the Company MUST list web.browser_session_endpoint with it (Operations 2).",
    fix: "List web.browser_session_endpoint, or remove the endpoint.",
    ref: extension("operations", "Operations", "2", "support")
  },
  "browser-control-without-join": {
    basis: "Rule",
    requires: "A Company that supports this extension lists it in extensions in its poppy.json (spec 3.3), with web.browser_session_endpoint",
    title: "Browser Control without browser join",
    explain: "A Company that supports Browser Control lists it with web.browser_session_endpoint (Browser Control 3): marked steps are for a browser joined to a Session.",
    fix: "List web.browser_session_endpoint, or remove the extension.",
    ref: extension("browser-control", "Browser Control", "3", "support")
  },
  "web-unscoped-without-join": {
    basis: "MUST",
    requires: "A Company that sets web.unscoped MUST list browser_session_endpoint.",
    title: "web.unscoped without browser join",
    explain: "web.unscoped says that poppy:browser-sign-in gives a joined browser the account's full access on the website, so a Company that sets it MUST list web.browser_session_endpoint (6).",
    fix: "List web.browser_session_endpoint, or remove web.unscoped.",
    ref: spec("6", "web-browsing")
  },
  "browser-sign-in-unsupported": {
    basis: "MUST",
    requires: "A Company that lists browser_session_endpoint and offers sign-in MUST support poppy:browser-sign-in",
    title: "Browser join without poppy:browser-sign-in",
    explain: "A Company that lists browser_session_endpoint and offers sign-in MUST support poppy:browser-sign-in, the scope that signs a joined browser in (6), so its scopes_supported includes it (4.7). It MAY grant the scope to fewer clients or Users.",
    fix: "Add poppy:browser-sign-in to scopes_supported and describe it in auth.scopes, or remove web.browser_session_endpoint.",
    ref: spec("6", "web-browsing")
  },
  "direct-sign-in-preferred": {
    basis: "SHOULD",
    requires: "A Company that offers sign-in SHOULD offer Direct Sign-In.",
    title: "Device Sign-In without Direct Sign-In",
    explain: "Direct Sign-In is the preferred sign-in type, and a Company that offers sign-in SHOULD offer it (4). This issuer offers Device Sign-In, which is easier to use for phishing, but not Direct.",
    fix: "Add authorization_code to grant_types_supported, with an authorization_endpoint.",
    ref: spec("4", "oauth")
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
