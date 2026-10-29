/**
 * Rules for Draft 0.3 (spec/draft-0.3-retrieved-2026-10-28), the only
 * version this validator checks. For discovery: the issuer comes from the
 * domain's protected resource metadata (3.2), and `auth.issuer` only chooses
 * among several; the issuer's metadata lists the domain in
 * `protected_resources` and the sign-in types in `grant_types_supported`;
 * `auth` describes scopes and hints at them instead of listing sign-in types;
 * Operations is version 2, with no endpoint, and Mediated Sign-In is an
 * extension; every URL is HTTPS (3), but for a Personal Agent's loopback
 * redirect URIs (4.1).
 *
 * Each rule is its own exported function, so the profile for a later
 * version can reuse the ones that still apply and replace the ones that
 * changed.
 */
import { pointer } from "../json.ts";
import { mediatedExt, rfc, spec } from "../messages.ts";
import {
  httpsMember,
  httpsUrl,
  isHostname,
  isObject,
  isScopeToken,
  label,
  member,
  sameDomain,
  stringList,
  unknownMembers,
  type Checker,
  type Obj,
  type UrlRules
} from "../primitives.ts";
import type { ClientFacts, PoppyFacts, Profile } from "./profile.ts";

const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export const MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in";
const API_TYPES = ["openapi", "mcp"];
/** Extensions defined with the protocol at 0.3, and the versions this validator knows. */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = { operations: ["2"], "mediated-sign-in": ["1"] };
/** Names a Mediated Sign-In field can't take (Mediated Sign-In 2). */
const RESERVED_FIELDS = ["grant_type", "scope", "resource", "client_id", "client_assertion", "client_assertion_type", "sign_in_id", "one_time_code"];
const LOOKS_SECRET = /pass(word|code|phrase)?|\bpin\b|otp|one.?time|secret|security.?(code|answer)|cvv|cvc/i;
const CHANGES = ["none", "reversible", "irreversible"];
/** URLs no rule keeps free of a fragment (spec-issues N9): we do, as a reading. */
const OURS: UrlRules = { fragment: "unstated" };

// poppy.json

/** `organization` (3.1): its name and domain. Returns the domain when it is a host name. */
export function checkOrganization(c: Checker, doc: Obj): string | undefined {
  const organization = member<Obj>(c, doc, "", "organization", "object", true);
  if (!organization) return undefined;
  const name = member<string>(c, organization, "/organization", "name", "string", false);
  if (!("name" in organization)) {
    c.report("organization-name-missing", "/organization/name", "organization.name, the Company's display name, is missing.");
  } else if (name !== undefined && name.trim() === "") {
    c.report("organization-name-missing", "/organization/name", "organization.name is blank, so there is no display name to show.");
  }
  const domain = member<string>(c, organization, "/organization", "domain", "string", true);
  unknownMembers(c, organization, "/organization", ["name", "domain"]);
  if (domain === undefined) return undefined;
  if (!isHostname(domain)) {
    c.report("domain-invalid", "/organization/domain", `organization.domain must be a bare host name, not ${JSON.stringify(domain)}.`);
    return undefined;
  }
  return domain;
}

/** A list of scopes, such as Mediated Sign-In's; returns the valid ones. */
export function checkScopes(c: Checker, value: unknown[], at: string): string[] {
  const scopes = stringList(c, value, at);
  const seen = new Set<string>();
  scopes.forEach((scope, index) => {
    const here = pointer(at, index);
    if (!isScopeToken(scope)) c.report("scope-syntax", here, `${JSON.stringify(scope)} isn't a valid OAuth scope.`);
    if (seen.has(scope)) c.report("scope-duplicate", here, `${scope} is listed twice in ${label(at)}.`);
    seen.add(scope);
  });
  if (value.length === 0) c.report("scopes-empty", at, `${label(at)} is empty, so Mediated Sign-In can't grant anything.`);
  return scopes;
}

/** The Mediated Sign-In extension's `fields` (Mediated Sign-In 2), in its entry at `at`. */
export function checkMediatedFields(c: Checker, mediated: Obj, at: string): void {
  const ref = mediatedExt("2", "support");
  const fields = member<unknown[]>(c, mediated, at, "fields", "array", true, ref);
  if (!fields) return;
  if (fields.length === 0) c.report("mediated-fields-empty", `${at}/fields`, `${label(`${at}/fields`)} is empty.`);
  const names = new Set<string>();
  fields.forEach((field, index) => {
    const fieldAt = `${at}/fields/${index}`;
    if (!isObject(field)) {
      c.report("wrong-type", fieldAt, `${label(fieldAt)} must be an object with name, label and secret.`, ref);
      return;
    }
    const name = member<string>(c, field, fieldAt, "name", "string", true, ref);
    const fieldLabel = member<string>(c, field, fieldAt, "label", "string", true, ref);
    const secret = member<boolean>(c, field, fieldAt, "secret", "boolean", false, ref);
    if (!("secret" in field)) c.report("mediated-secret-missing", `${fieldAt}/secret`, `${label(fieldAt)} doesn't say whether ${name ?? "it"} is secret.`);
    if (secret === false && LOOKS_SECRET.test(`${name ?? ""} ${fieldLabel ?? ""}`)) {
      c.report("mediated-looks-secret", `${fieldAt}/secret`, `${name ?? label(fieldAt)} looks like a secret but has secret: false.`);
    }
    if (name !== undefined) {
      if (RESERVED_FIELDS.includes(name)) c.report("mediated-field-reserved", `${fieldAt}/name`, `A Mediated Sign-In field can't be named ${name}: the grant uses that parameter.`);
      if (names.has(name)) c.report("mediated-field-duplicate", `${fieldAt}/name`, `Two fields are named ${JSON.stringify(name)}.`);
      names.add(name);
    }
    unknownMembers(c, field, fieldAt, ["name", "label", "secret"]);
  });
}

/** `agent` (3.1, 8.1): its conversation protocols, one of them poppy. */
export function checkAgent(c: Checker, agent: Obj): void {
  const ref = spec("8.1", "conversation-protocols");
  const protocols = member<unknown[]>(c, agent, "/agent", "protocols", "array", true, ref);
  unknownMembers(c, agent, "/agent", ["protocols"]);
  if (!protocols) return;
  let poppy = false;
  protocols.forEach((entry, index) => {
    const at = `/agent/protocols/${index}`;
    if (!isObject(entry)) {
      c.report("wrong-type", at, `${label(at)} must be an object with type and endpoint.`, ref);
      return;
    }
    const type = member<string>(c, entry, at, "type", "string", true, ref);
    httpsMember(c, entry, at, "endpoint", true, ref, OURS);
    if (type === "poppy") poppy = true;
    else if (type !== undefined) c.report("protocol-type-unknown", `${at}/type`, `Agents that don't know ${JSON.stringify(type)} skip this entry.`);
    // 0.3 removed `resource` (4.5): a service that takes only its own tokens says so in its protected resource metadata.
    unknownMembers(c, entry, at, ["type", "endpoint"]);
  });
  if (!poppy) c.report("no-poppy-protocol", "/agent/protocols", "agent.protocols has no entry of type poppy.");
}

/** `apis` (3.1, 7): each with a type, an HTTPS url and a description. */
export function checkApis(c: Checker, apis: unknown[]): void {
  const ref = spec("7", "apis");
  apis.forEach((entry, index) => {
    const at = `/apis/${index}`;
    if (!isObject(entry)) {
      c.report("wrong-type", at, `${label(at)} must be an object with type, url and description.`, ref);
      return;
    }
    const type = member<string>(c, entry, at, "type", "string", true, ref);
    if (type !== undefined && !API_TYPES.includes(type)) {
      c.report("api-type-unknown", `${at}/type`, `${JSON.stringify(type)} isn't an API type this version defines (openapi or mcp); agents that don't know it skip it.`);
    }
    httpsMember(c, entry, at, "url", true, ref, OURS);
    const description = member<string>(c, entry, at, "description", "string", false, spec("3.1", "fields"));
    if (!("description" in entry) || description === "") {
      c.report("api-description-missing", `${at}/description`, `${label(at)} has no description to help agents choose it.`);
    }
    // 0.3 removed `resource` (4.5), as for agent.protocols.
    unknownMembers(c, entry, at, ["type", "url", "description"]);
  });
}

/** `web` (3.1, 6). Returns whether it lists a browser-session endpoint, which needs an issuer (3.2). */
export function checkWeb(c: Checker, web: Obj): boolean {
  const endpoint = httpsMember(c, web, "/web", "browser_session_endpoint", false, spec("6", "web-browsing"), OURS);
  unknownMembers(c, web, "/web", ["browser_session_endpoint"]);
  return endpoint !== undefined || "browser_session_endpoint" in web;
}

/** `auth` (3.1, 4.7): an optional issuer, scope descriptions and hints. Returns the issuer and the scopes `auth.scopes` describes. */
export function checkAuth(c: Checker, auth: Obj): { issuer?: string; described: string[] } {
  const issuerUrl = httpsMember(c, auth, "/auth", "issuer", false, spec("3.1", "fields"));
  if (issuerUrl?.search) c.report("issuer-query", "/auth/issuer", `auth.issuer can't have a query: ${issuerUrl.href}.`);
  const described: string[] = [];
  const scopes = member<Obj>(c, auth, "/auth", "scopes", "object", false, spec("4.7", "scopes"));
  for (const [scope, description] of Object.entries(scopes ?? {})) {
    const at = pointer("/auth/scopes", scope);
    if (!isScopeToken(scope)) c.report("scope-syntax", at, `${JSON.stringify(scope)} isn't a valid OAuth scope.`);
    if (typeof description !== "string") c.report("wrong-type", at, `The description of ${scope} must be a string.`, spec("3.1", "fields"));
    described.push(scope);
  }
  const hints = member<Obj>(c, auth, "/auth", "scope_hints", "object", false, spec("4.7", "scopes"));
  for (const [scope, hint] of Object.entries(hints ?? {})) {
    const at = pointer("/auth/scope_hints", scope);
    if (!isScopeToken(scope)) c.report("scope-syntax", at, `${JSON.stringify(scope)} isn't a valid OAuth scope.`);
    if (!isObject(hint)) {
      c.report("scope-hint-invalid", at, `The hint for ${scope} must be an object with changes and personal_data.`);
      continue;
    }
    if (typeof hint.changes !== "string" || typeof hint.personal_data !== "boolean") {
      c.report("scope-hint-invalid", at, `The hint for ${scope} needs both changes, a string, and personal_data, a boolean.`);
    } else if (!CHANGES.includes(hint.changes)) {
      c.report("scope-hint-changes-unknown", pointer(at, "changes"), `changes is ${JSON.stringify(hint.changes)}, which agents read as irreversible.`);
    }
    unknownMembers(c, hint, at, ["changes", "personal_data"]);
  }
  unknownMembers(c, auth, "/auth", ["issuer", "scopes", "scope_hints"]);
  return { ...(typeof auth.issuer === "string" && issuerUrl ? { issuer: auth.issuer } : {}), described };
}

/** `extensions` (3.3) with 0.3's: Operations 2 and Mediated Sign-In 1. Returns Mediated Sign-In's scopes when listed. */
export function checkExtensions(c: Checker, extensions: Obj): readonly string[] | undefined {
  let mediated: readonly string[] | undefined;
  for (const [name, entry] of Object.entries(extensions)) {
    const at = pointer("/extensions", name);
    const slash = name.indexOf("/");
    if (slash === -1) {
      if (!(name in EXTENSIONS)) c.report("extension-plain-unknown", at, `${name} has a plain name, but the protocol defines no such extension.`);
    } else if (!isHostname(name.slice(0, slash)) || slash === name.length - 1) {
      c.report("extension-name", at, `${JSON.stringify(name)} must start with a domain, such as example.com/gift-wrap.`);
    }
    if (!isObject(entry)) {
      c.report("wrong-type", at, `The ${name} extension's entry must be an object with a version.`, spec("3.3", "extensions"));
      continue;
    }
    // 3.3 gives no JSON type for version (N22); a number is our reading's warning, not wrong-type.
    if (typeof entry.version === "number") {
      c.report("extension-version-number", `${at}/version`, `The ${name} extension's version is the number ${entry.version}; write it as a string, such as "${entry.version}".`);
      continue;
    }
    const version = member<string>(c, entry, at, "version", "string", true, spec("3.3", "extensions"));
    const known = EXTENSIONS[name];
    if (!known || version === undefined) continue;
    if (!known.includes(version)) {
      c.report("extension-version-unknown", `${at}/version`, `${name} version ${version} isn't one this validator knows (${known.join(", ")}).`);
      continue;
    }
    // Operations 2 has no endpoint or resource (0.3 removed both).
    if (name === "operations") unknownMembers(c, entry, at, ["version"]);
    if (name === "mediated-sign-in") {
      const scopes = member<unknown[]>(c, entry, at, "scopes", "array", true, mediatedExt("2", "support"));
      mediated = scopes ? checkScopes(c, scopes, `${at}/scopes`) : [];
      checkMediatedFields(c, entry, at);
      unknownMembers(c, entry, at, ["version", "fields", "scopes"]);
    }
  }
  return mediated;
}

export function checkPoppy(c: Checker, doc: unknown, context: { requestedDomain?: string }): PoppyFacts {
  const facts: PoppyFacts = { signIn: { direct: false, device: false, mediated: false } };
  if (!isObject(doc)) {
    c.report("wrong-type", "", "poppy.json must be a JSON object.", spec("3.1", "fields"));
    return facts;
  }
  facts.domain = checkOrganization(c, doc);
  // The host that served the document, after redirects, ignoring case only (3.1).
  if (facts.domain && context.requestedDomain && facts.domain.toLowerCase() !== context.requestedDomain.toLowerCase()) {
    c.report("organization-domain-mismatch", "/organization/domain", `organization.domain is ${facts.domain}, but the document was served by ${context.requestedDomain}.`);
  }
  const agent = member<Obj>(c, doc, "", "agent", "object", false);
  const apis = member<unknown[]>(c, doc, "", "apis", "array", false);
  const web = member<Obj>(c, doc, "", "web", "object", false);
  if (agent) checkAgent(c, agent);
  if (apis) checkApis(c, apis);
  const browserSession = web ? checkWeb(c, web) : false;
  if (!("agent" in doc) && !("apis" in doc) && !("web" in doc)) c.report("nothing-offered", "", "poppy.json has none of agent, apis or web.");
  const feedback = member<Obj>(c, doc, "", "feedback", "object", false);
  if (feedback) {
    httpsMember(c, feedback, "/feedback", "endpoint", true, spec("9.3", "feedback"));
    unknownMembers(c, feedback, "/feedback", ["endpoint"]);
  }
  const excluded = member<Obj>(c, doc, "", "excluded_tasks", "object", false);
  if (excluded) {
    httpsMember(c, excluded, "/excluded_tasks", "url", true, spec("9.1", "excluded-tasks"));
    unknownMembers(c, excluded, "/excluded_tasks", ["url"]);
  }
  const auth = member<Obj>(c, doc, "", "auth", "object", false);
  const checkedAuth = auth ? checkAuth(c, auth) : undefined;
  if (checkedAuth?.issuer) facts.issuer = checkedAuth.issuer;
  // An OpenAPI description may describe scopes too (4.7); the validator doesn't read one, so it can't tell which.
  const openapi = apis?.some((entry) => isObject(entry) && entry.type === "openapi") ?? false;
  if (!openapi) facts.describedScopes = checkedAuth?.described ?? [];
  const extensions = member<Obj>(c, doc, "", "extensions", "object", false);
  const mediated = extensions ? checkExtensions(c, extensions) : undefined;
  if (mediated) {
    facts.mediatedScopes = mediated;
    facts.signIn.mediated = true;
  }
  // 3.2: a Company that lists any of these MUST have an issuer, found from its domain.
  facts.needsIssuer = !!(agent || apis || feedback || browserSession || mediated || (extensions && "operations" in extensions));
  if (!facts.needsIssuer && !auth) c.report("website-only", "", "Nothing here needs an issuer: agents can only browse this Company's website, signed out.");
  unknownMembers(c, doc, "", ["protocol_version", "organization", "auth", "agent", "apis", "web", "feedback", "excluded_tasks", "extensions"]);
  return facts;
}

/** The domain's protected resource metadata (3.2, RFC 9728): `resource` is the domain; `authorization_servers` names the issuer. */
export function checkProtectedResource(c: Checker, doc: unknown, poppy: PoppyFacts): string | undefined {
  const ref = spec("3.2", "oauth-server");
  if (!isObject(doc)) {
    c.report("wrong-type", "", "The protected resource metadata must be a JSON object.", ref);
    return undefined;
  }
  const resource = member<string>(c, doc, "", "resource", "string", true, ref);
  if (resource !== undefined && poppy.domain !== undefined && resource !== `https://${poppy.domain}` && resource.toLowerCase() !== `https://${poppy.domain.toLowerCase()}`) {
    c.report("prm-resource-mismatch", "/resource", `resource is ${JSON.stringify(resource)}, not https://${poppy.domain}.`);
  }
  const servers = member<unknown[]>(c, doc, "", "authorization_servers", "array", true, ref);
  if (!servers) return undefined;
  const list = stringList(c, servers, "/authorization_servers", ref);
  // A diagnostic does not make a malformed issuer usable for metadata discovery.
  const usable = new Set(list.filter((server, index) => httpsUrl(c, server, `/authorization_servers/${index}`, ref) !== undefined));
  if (list.length === 0) {
    c.report("prm-no-issuer", "/authorization_servers", "authorization_servers is empty, so there is no issuer.");
    return undefined;
  }
  if (poppy.issuer !== undefined) {
    if (!list.includes(poppy.issuer)) {
      c.report("issuer-not-listed", "/authorization_servers", `auth.issuer ${poppy.issuer} isn't in authorization_servers.`);
      return undefined;
    }
    return usable.has(poppy.issuer) ? poppy.issuer : undefined;
  }
  if (list.length > 1) {
    c.report("issuer-ambiguous", "/authorization_servers", `authorization_servers lists ${list.length} servers, and poppy.json has no auth.issuer to say which one agents use.`);
    return undefined;
  }
  return usable.has(list[0]!) ? list[0] : undefined;
}

/** The issuer's metadata (3.2, RFC 8414): `protected_resources`, `grant_types_supported`, and the endpoints and scopes the sign-in types need. */
export function checkOAuthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void {
  const ref = spec("3.2", "oauth-server");
  if (!isObject(doc)) {
    c.report("wrong-type", "", "The OAuth server metadata must be a JSON object.", ref);
    return;
  }
  const issuer = member<string>(c, doc, "", "issuer", "string", true, ref);
  if (issuer !== undefined && poppy?.issuer !== undefined && issuer !== poppy.issuer) {
    c.report("metadata-issuer-mismatch", "/issuer", `The metadata's issuer ${JSON.stringify(issuer)} isn't exactly ${JSON.stringify(poppy.issuer)}, the issuer the domain names.`);
  }
  httpsMember(c, doc, "", "token_endpoint", true, ref);
  httpsMember(c, doc, "", "revocation_endpoint", true, ref);
  const resources = member<unknown[]>(c, doc, "", "protected_resources", "array", true, ref);
  if (resources) {
    const list = stringList(c, resources, "/protected_resources", ref);
    list.forEach((entry, index) => httpsUrl(c, entry, `/protected_resources/${index}`, ref));
    // RFC 9728 3.3's comparison, with the host ignoring case (3.2).
    const wanted = poppy?.domain === undefined ? undefined : `https://${poppy.domain.toLowerCase()}`;
    const matches = (entry: string) => {
      try {
        const url = new URL(entry);
        return `${url.protocol}//${url.hostname}` === wanted && entry.length === wanted.length;
      } catch {
        return false;
      }
    };
    if (wanted !== undefined && !list.some(matches)) {
      c.report("metadata-protected-resources", "/protected_resources", `protected_resources doesn't include https://${poppy!.domain}.`);
    }
  }
  const grants = member<unknown[]>(c, doc, "", "grant_types_supported", "array", true, ref);
  const list = grants ? stringList(c, grants, "/grant_types_supported", ref) : [];
  if (grants && !list.includes("refresh_token")) c.report("metadata-refresh-grant", "/grant_types_supported", "grant_types_supported doesn't include refresh_token.");
  const direct = list.includes("authorization_code");
  const device = list.includes(DEVICE_CODE);
  httpsMember(c, doc, "", "authorization_endpoint", direct ? "because grant_types_supported includes authorization_code" : false, ref);
  httpsMember(c, doc, "", "device_authorization_endpoint", device ? `because grant_types_supported includes ${DEVICE_CODE}` : false, ref);
  if (poppy?.signIn.mediated && grants && !list.includes(MEDIATED_GRANT)) {
    c.report("mediated-grant-missing", "/grant_types_supported", `poppy.json lists Mediated Sign-In, but grant_types_supported doesn't include ${MEDIATED_GRANT}.`);
  }
  const signsIn = direct || device || !!poppy?.signIn.mediated;
  const scopes = member<unknown[]>(c, doc, "", "scopes_supported", "array", signsIn ? "because the Company offers sign-in" : false, ref);
  const supported = scopes ? stringList(c, scopes, "/scopes_supported", ref) : [];
  for (const scope of poppy?.mediatedScopes ?? []) {
    if (scopes && !supported.includes(scope)) c.report("mediated-scope-unsupported", "/scopes_supported", `Mediated Sign-In offers ${scope}, which isn't in scopes_supported.`);
  }
  // 4.7: auth.scopes describes each supported scope, unless an OpenAPI description might.
  const described = poppy?.describedScopes;
  if (described) {
    supported.forEach((scope, index) => {
      if (!described.includes(scope)) c.report("scope-undescribed", `/scopes_supported/${index}`, `${scope} is in scopes_supported, but poppy.json's auth.scopes doesn't describe it, and poppy.json lists no OpenAPI description that could.`);
    });
  }
  const dpop = member<unknown[]>(c, doc, "", "dpop_signing_alg_values_supported", "array", false, rfc(9449, "5.1"));
  if (dpop && !stringList(c, dpop, "/dpop_signing_alg_values_supported", rfc(9449, "5.1")).includes("ES256")) {
    c.report("metadata-dpop-alg", "/dpop_signing_alg_values_supported", "dpop_signing_alg_values_supported doesn't include ES256, so agents that sign proofs only with ES256 send none.");
  }
  if (direct) {
    const pkce = member<unknown[]>(c, doc, "", "code_challenge_methods_supported", "array", false, rfc(8414, "2"));
    if (pkce && !pkce.includes("S256")) c.report("metadata-pkce", "/code_challenge_methods_supported", "code_challenge_methods_supported doesn't include S256.");
    if (doc.authorization_response_iss_parameter_supported !== true) {
      c.report("metadata-iss-parameter", "/authorization_response_iss_parameter_supported", "authorization_response_iss_parameter_supported isn't true.");
    }
  }
  if ("poppy_domains" in doc) c.report("unknown-member", "/poppy_domains", `${label("/poppy_domains")} is 0.2's; 0.3 uses protected_resources, and agents ignore it.`);
  // Other members are standard RFC 8414 fields or the Company's own; agents ignore them (3.2).
}

// Client metadata (4.1) and its key set

/** A loopback redirect URI, as RFC 8252 §7.3 defines it: http, to the IP literal 127.0.0.1 or [::1], on any port. */
function isLoopbackRedirect(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function checkClientMetadata(c: Checker, doc: unknown, context: { fetchedFrom?: string }): ClientFacts {
  const facts: ClientFacts = {};
  const ref = spec("4.1", "agent-identity");
  if (!isObject(doc)) {
    c.report("wrong-type", "", "Client metadata must be a JSON object.", ref);
    return facts;
  }
  const clientId = httpsMember(c, doc, "", "client_id", true, ref, OURS);
  if (clientId && context.fetchedFrom !== undefined && doc.client_id !== context.fetchedFrom) {
    c.report("client-id-mismatch", "/client_id", `client_id is ${String(doc.client_id)}, but the document was fetched from ${context.fetchedFrom}.`);
  }
  member<string>(c, doc, "", "client_name", "string", false, ref);
  if ("logo_uri" in doc) httpsMember(c, doc, "", "logo_uri", false, ref, OURS);
  const jwksUri = httpsMember(c, doc, "", "jwks_uri", true, ref, OURS);
  if (jwksUri && clientId && !sameDomain(jwksUri.hostname, clientId.hostname)) {
    c.report("client-other-domain", "/jwks_uri", `jwks_uri is on ${jwksUri.hostname}, not client_id's domain ${clientId.hostname}.`);
  }
  if (jwksUri) facts.jwksUri = jwksUri.href;
  const redirects = member<unknown[]>(c, doc, "", "redirect_uris", "array", false, ref);
  if (!("redirect_uris" in doc) || redirects?.length === 0) {
    c.report("client-no-redirects", "/redirect_uris", "No redirect_uris, so this agent can't use Direct Sign-In.");
  }
  redirects?.forEach((value, index) => {
    const at = `/redirect_uris/${index}`;
    // An app on the User's computer may use a loopback redirect URI, the one exception to HTTPS (3, 4.1).
    if (isLoopbackRedirect(value)) {
      if (value.includes("#")) c.report("url-has-fragment", at, `${label(at)} can't contain a #fragment: ${value}.`, rfc(6749, "3.1.2"));
      return;
    }
    const url = httpsUrl(c, value, at, ref);
    if (url && clientId && !sameDomain(url.hostname, clientId.hostname)) {
      c.report("client-other-domain", at, `Redirect URI ${url.href} isn't on client_id's domain ${clientId.hostname}.`);
    }
  });
  if (doc.token_endpoint_auth_method !== "private_key_jwt") {
    c.report(
      "client-auth-method",
      "/token_endpoint_auth_method",
      "token_endpoint_auth_method" in doc
        ? `token_endpoint_auth_method is ${JSON.stringify(doc.token_endpoint_auth_method)}, not "private_key_jwt".`
        : 'token_endpoint_auth_method is missing; it must be "private_key_jwt".'
    );
  }
  const extensions = member<Obj>(c, doc, "", "extensions", "object", false, ref);
  if (extensions) {
    for (const [name, entry] of Object.entries(extensions)) {
      const at = pointer("/extensions", name);
      if (!isObject(entry)) c.report("wrong-type", at, `The ${name} extension's entry must be an object with a version.`, spec("3.3", "extensions"));
      else member<string>(c, entry, at, "version", "string", true, spec("3.3", "extensions"));
    }
  }
  // Client metadata is an OAuth dynamic registration document (RFC 7591), so other members are normal.
  return facts;
}

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
/** What Companies MUST accept for client assertions and delegations (4.1, 5.2). RS256 can't sign a delegation, so it's left out. */
const KEY_ALGS = ["ES256", "PS384"];

function base64urlBytes(value: unknown): number {
  return typeof value === "string" ? Math.floor((value.replace(/=+$/, "").length * 3) / 4) : 0;
}

export function checkJwks(c: Checker, doc: unknown): void {
  const ref = spec("4.1", "agent-identity");
  if (!isObject(doc)) {
    c.report("wrong-type", "", "The key set must be a JSON object with keys.", ref);
    return;
  }
  const keys = member<unknown[]>(c, doc, "", "keys", "array", true, rfc(7517, "5"));
  if (!keys) return;
  if (keys.length === 0) c.report("jwks-empty", "/keys", "The key set has no keys.");
  const kids = new Set<string>();
  keys.forEach((key, index) => {
    const at = `/keys/${index}`;
    if (!isObject(key)) {
      c.report("wrong-type", at, `${label(at)} must be a JWK object.`, rfc(7517, "4"));
      return;
    }
    const leaked = PRIVATE_MEMBERS.filter((name) => name in key);
    if (leaked.length > 0) c.report("jwks-private-key", at, `Key ${index} publishes private members: ${leaked.join(", ")}.`);
    if (key.kty === "EC") {
      if (key.crv !== "P-256") c.report("jwks-key-type", at, `Key ${index} is EC on ${String(key.crv)}; only P-256 (ES256) is supported.`);
    } else if (key.kty === "RSA") {
      const bits = base64urlBytes(key.n) * 8;
      if (bits < 2048) c.report("jwks-rsa-small", at, `Key ${index} is a ${bits}-bit RSA key.`);
    } else {
      c.report("jwks-key-type", at, `Key ${index} has kty ${JSON.stringify(key.kty)}; use EC (P-256) or RSA.`);
    }
    if ("alg" in key && (typeof key.alg !== "string" || !KEY_ALGS.includes(key.alg))) c.report("jwks-alg", `${at}/alg`, `Key ${index} has alg ${JSON.stringify(key.alg)}, not ES256 or PS384.`);
    if ("use" in key && key.use !== "sig") c.report("jwks-use", `${at}/use`, `Key ${index} has use ${JSON.stringify(key.use)}.`);
    if (typeof key.kid !== "string" || key.kid === "") c.report("jwks-no-kid", at, `Key ${index} has no kid.`);
    else {
      if (kids.has(key.kid)) c.report("jwks-kid-duplicate", `${at}/kid`, `Two keys have kid ${JSON.stringify(key.kid)}.`);
      kids.add(key.kid);
    }
  });
}

export const draft03: Profile = {
  version: "0.3",
  name: "Draft 0.3",
  poppy: checkPoppy,
  protectedResource: checkProtectedResource,
  oauthMetadata: checkOAuthMetadata,
  clientMetadata: checkClientMetadata,
  jwks: checkJwks
};
