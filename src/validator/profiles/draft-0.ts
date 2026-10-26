/**
 * Rules for Draft 0.1 of the protocol (Draft 0.1, updated 12 Oct 2026; its rules are those of 9 Oct).
 *
 * Each rule is its own exported function, so the profile for a later
 * version can reuse the ones that still apply, replace the ones that
 * changed, and leave this profile untouched for documents that still
 * declare 0.x.
 */
import { pointer } from "../json.ts";
import { operationsExt, rfc, spec } from "../messages.ts";
import {
  bareHost,
  Checker,
  httpsMember,
  httpsUrl,
  isHostname,
  isObject,
  isScopeToken,
  label,
  member,
  resourceIndicator,
  sameDomain,
  stringList,
  unknownMembers,
  type Obj,
  type UrlRules
} from "../primitives.ts";
import type { ClientFacts, Profile, PoppyFacts } from "./profile.ts";

const PROTOCOL_SCOPES = ["poppy:read", "poppy:write"];
const SIGN_IN_TYPES = ["direct", "device", "mediated"] as const;
const API_TYPES = ["openapi", "mcp"];
/** URLs the draft doesn't require to be HTTPS or fragment-free (spec-issues N9): we do, as a reading. */
const OURS: UrlRules = { https: "unstated", fragment: "unstated" };
/** Extensions defined with the protocol, and the versions this validator knows. */
const PROTOCOL_EXTENSIONS: Readonly<Record<string, readonly string[]>> = { operations: ["1"] };
const LOOKS_SECRET = /pass(word|code|phrase)?|\bpin\b|otp|one.?time|secret|security.?(code|answer)|cvv|cvc/i;

// poppy.json

export function checkOrganization(c: Checker, doc: Obj, requestedDomain: string | undefined): string | undefined {
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
  if (requestedDomain !== undefined && bareHost(domain) !== bareHost(requestedDomain)) {
    c.report(
      "organization-domain-mismatch",
      "/organization/domain",
      `organization.domain is ${JSON.stringify(domain)}, but the document was requested for ${requestedDomain}.`
    );
  }
  return domain;
}

/** One sign-in type's scopes list; returns the valid scopes. */
export function checkScopes(c: Checker, value: unknown[], at: string): string[] {
  const scopes = stringList(c, value, at);
  const seen = new Set<string>();
  scopes.forEach((scope, index) => {
    const here = pointer(at, index);
    if (!isScopeToken(scope)) c.report("scope-syntax", here, `${JSON.stringify(scope)} isn't a valid OAuth scope.`);
    else if (scope.startsWith("poppy:") && !PROTOCOL_SCOPES.includes(scope)) {
      c.report("scope-reserved", here, `${scope} starts with poppy:, which is reserved; the protocol defines only poppy:read and poppy:write.`);
    }
    if (seen.has(scope)) c.report("scope-duplicate", here, `${scope} is listed twice in ${label(at)}.`);
    seen.add(scope);
  });
  if (value.length === 0) c.report("scopes-empty", at, `${label(at)} is empty, so this sign-in type can't grant anything.`);
  return scopes;
}

export function checkMediatedFields(c: Checker, mediated: Obj): void {
  const at = "/auth/mediated";
  const fields = member<unknown[]>(c, mediated, at, "fields", "array", true, spec("4.7", "mediated-sign-in"));
  if (!fields) return;
  if (fields.length === 0) c.report("mediated-fields-empty", `${at}/fields`, "auth.mediated.fields is empty.");
  const names = new Set<string>();
  fields.forEach((field, index) => {
    const fieldAt = `${at}/fields/${index}`;
    if (!isObject(field)) {
      c.report("wrong-type", fieldAt, `${label(fieldAt)} must be an object with name, label and secret.`, spec("4.7", "mediated-sign-in"));
      return;
    }
    const name = member<string>(c, field, fieldAt, "name", "string", true, spec("4.7", "mediated-sign-in"));
    const fieldLabel = member<string>(c, field, fieldAt, "label", "string", true, spec("4.7", "mediated-sign-in"));
    const secret = member<boolean>(c, field, fieldAt, "secret", "boolean", false, spec("4.7", "mediated-sign-in"));
    if (!("secret" in field)) c.report("mediated-secret-missing", `${fieldAt}/secret`, `${label(fieldAt)} doesn't say whether ${name ?? "it"} is secret.`);
    if (secret === false && LOOKS_SECRET.test(`${name ?? ""} ${fieldLabel ?? ""}`)) {
      c.report("mediated-looks-secret", `${fieldAt}/secret`, `${name ?? label(fieldAt)} looks like a secret but has secret: false.`);
    }
    if (name !== undefined) {
      if (names.has(name)) c.report("mediated-field-duplicate", `${fieldAt}/name`, `Two fields are named ${JSON.stringify(name)}.`);
      names.add(name);
    }
    unknownMembers(c, field, fieldAt, ["name", "label", "secret"]);
  });
}

export function checkAuth(c: Checker, auth: Obj): Pick<PoppyFacts, "issuer" | "signIn"> {
  const signIn = { direct: false, device: false, mediated: false };
  const issuerUrl = httpsMember(c, auth, "/auth", "issuer", true, spec("3.1", "fields"));
  if (issuerUrl?.search) c.report("issuer-query", "/auth/issuer", `auth.issuer can't have a query: ${issuerUrl.href}.`);
  const offered = new Set<string>();
  for (const type of SIGN_IN_TYPES) {
    const entry = member<Obj>(c, auth, "/auth", type, "object", false);
    if (!entry) continue;
    signIn[type] = true;
    const at = `/auth/${type}`;
    const scopes = member<unknown[]>(c, entry, at, "scopes", "array", true, spec("4.4", "sign-in"));
    if (scopes) for (const scope of checkScopes(c, scopes, `${at}/scopes`)) offered.add(scope);
    if (type === "mediated") {
      httpsMember(c, entry, at, "endpoint", true, spec("4.7", "mediated-sign-in"), OURS);
      checkMediatedFields(c, entry);
      unknownMembers(c, entry, at, ["endpoint", "fields", "scopes"]);
    } else {
      unknownMembers(c, entry, at, ["scopes"]);
    }
  }
  if (!signIn.direct && !signIn.device && !signIn.mediated) {
    c.report("signed-out-only", "/auth", "auth lists no sign-in types, so Sessions can only be signed out.");
  }
  const custom = member<Obj>(c, auth, "/auth", "custom_scopes", "object", false);
  const described = new Set<string>();
  if (custom) {
    for (const [scope, description] of Object.entries(custom)) {
      const at = pointer("/auth/custom_scopes", scope);
      if (!isScopeToken(scope)) c.report("scope-syntax", at, `${JSON.stringify(scope)} isn't a valid OAuth scope.`);
      else if (scope.startsWith("poppy:")) c.report("scope-reserved", at, `custom_scopes can't define ${scope}: names starting with poppy: are reserved.`);
      if (typeof description !== "string") c.report("wrong-type", at, `The description of ${scope} must be a string.`, spec("3.1", "fields"));
      described.add(scope);
      if (!offered.has(scope)) c.report("scope-unoffered", at, `${scope} is described but no sign-in type offers it.`);
    }
  }
  for (const scope of offered) {
    if (!PROTOCOL_SCOPES.includes(scope) && !scope.startsWith("poppy:") && !described.has(scope)) {
      c.report("scope-undescribed", "/auth/custom_scopes", `${scope} is offered but auth.custom_scopes doesn't describe it.`);
    }
  }
  unknownMembers(c, auth, "/auth", ["issuer", ...SIGN_IN_TYPES, "custom_scopes"]);
  return { issuer: typeof auth.issuer === "string" && issuerUrl ? auth.issuer : undefined, signIn };
}

export function checkAgent(c: Checker, agent: Obj): void {
  const protocols = member<unknown[]>(c, agent, "/agent", "protocols", "array", true, spec("7.1", "conversation-protocols"));
  unknownMembers(c, agent, "/agent", ["protocols"]);
  if (!protocols) return;
  let poppy = false;
  protocols.forEach((entry, index) => {
    const at = `/agent/protocols/${index}`;
    if (!isObject(entry)) {
      c.report("wrong-type", at, `${label(at)} must be an object with type and endpoint.`, spec("7.1", "conversation-protocols"));
      return;
    }
    const type = member<string>(c, entry, at, "type", "string", true, spec("7.1", "conversation-protocols"));
    httpsMember(c, entry, at, "endpoint", true, spec("7.1", "conversation-protocols"), { fragment: "unstated" });
    if ("resource" in entry) resourceIndicator(c, entry.resource, `${at}/resource`);
    if (type === "poppy") poppy = true;
    else if (type !== undefined) c.report("protocol-type-unknown", `${at}/type`, `Agents that don't know ${JSON.stringify(type)} skip this entry.`);
    unknownMembers(c, entry, at, ["type", "endpoint", "resource"]);
  });
  if (!poppy) c.report("no-poppy-protocol", "/agent/protocols", "agent.protocols has no entry of type poppy.");
}

export function checkApis(c: Checker, apis: unknown[]): void {
  apis.forEach((entry, index) => {
    const at = `/apis/${index}`;
    if (!isObject(entry)) {
      c.report("wrong-type", at, `${label(at)} must be an object with type, url and description.`, spec("6", "apis"));
      return;
    }
    const type = member<string>(c, entry, at, "type", "string", true, spec("6", "apis"));
    if (type !== undefined && !API_TYPES.includes(type)) {
      c.report("api-type-unknown", `${at}/type`, `${JSON.stringify(type)} isn't an API type of this version (openapi or mcp); agents skip it.`);
    }
    const url = httpsMember(c, entry, at, "url", true, spec("6", "apis"), OURS);
    const description = member<string>(c, entry, at, "description", "string", false, spec("6", "apis"));
    if (!("description" in entry) || description === "") {
      c.report("api-description-missing", `${at}/description`, `${label(at)} has no description to help agents choose it.`);
    }
    if ("resource" in entry) {
      resourceIndicator(c, entry.resource, `${at}/resource`);
      if (type === "mcp" && url && typeof entry.resource === "string" && entry.resource !== url.href && entry.resource !== entry.url) {
        c.report("mcp-resource-mismatch", `${at}/resource`, `The MCP server's resource ${entry.resource} isn't its url ${String(entry.url)}.`);
      }
    }
    unknownMembers(c, entry, at, ["type", "url", "description", "resource"]);
  });
}

export function checkWeb(c: Checker, web: Obj): boolean {
  const endpoint = httpsMember(c, web, "/web", "browser_session_endpoint", false, spec("5", "web-browsing"), OURS);
  unknownMembers(c, web, "/web", ["browser_session_endpoint"]);
  return endpoint !== undefined || "browser_session_endpoint" in web;
}

export function checkExtensions(c: Checker, extensions: Obj): void {
  for (const [name, entry] of Object.entries(extensions)) {
    const at = pointer("/extensions", name);
    const slash = name.indexOf("/");
    if (slash === -1) {
      if (!(name in PROTOCOL_EXTENSIONS)) c.report("extension-plain-unknown", at, `${name} has a plain name, but the protocol defines no such extension.`);
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
    if (name === "operations") {
      if (version !== undefined && !PROTOCOL_EXTENSIONS.operations!.includes(version)) {
        c.report("extension-version-unknown", `${at}/version`, `operations version ${version} isn't one this validator knows (1).`);
      } else if (version !== undefined) {
        httpsMember(c, entry, at, "endpoint", true, operationsExt("2", "support"), OURS);
        if ("resource" in entry) resourceIndicator(c, entry.resource, `${at}/resource`);
        unknownMembers(c, entry, at, ["version", "endpoint", "resource"]);
      }
    }
  }
}

export function checkPoppy(c: Checker, doc: unknown, context: { requestedDomain?: string }): PoppyFacts {
  const facts: PoppyFacts = { signIn: { direct: false, device: false, mediated: false } };
  if (!isObject(doc)) {
    c.report("wrong-type", "", "poppy.json must be a JSON object.", spec("3.1", "fields"));
    return facts;
  }
  facts.domain = checkOrganization(c, doc, context.requestedDomain);

  const agent = member<Obj>(c, doc, "", "agent", "object", false);
  const apis = member<unknown[]>(c, doc, "", "apis", "array", false);
  const web = member<Obj>(c, doc, "", "web", "object", false);
  if (agent) checkAgent(c, agent);
  if (apis) checkApis(c, apis);
  const browserSession = web ? checkWeb(c, web) : false;
  if (!("agent" in doc) && !("apis" in doc) && !("web" in doc)) {
    c.report("nothing-offered", "", "poppy.json has none of agent, apis or web.");
  }

  const auth = member<Obj>(c, doc, "", "auth", "object", false);
  if (auth) Object.assign(facts, checkAuth(c, auth));
  else if (!("auth" in doc)) {
    const needs = [agent && "agent", apis && "apis", browserSession && "web.browser_session_endpoint"].filter(Boolean);
    if (needs.length > 0) c.report("auth-required", "/auth", `auth is required because ${needs.join(", ")} ${needs.length > 1 ? "are" : "is"} present.`);
    else c.report("website-only", "", "No auth: agents can only browse this Company's website, signed out.");
  }

  const extensions = member<Obj>(c, doc, "", "extensions", "object", false);
  if (extensions) checkExtensions(c, extensions);
  unknownMembers(c, doc, "", ["protocol_version", "organization", "auth", "agent", "apis", "web", "extensions", ...(c.protocolVersion === "0.2" ? ["feedback"] : [])]);
  return facts;
}

// OAuth Authorization Server Metadata (RFC 8414) as the protocol profiles it (3.2)

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";

export function checkOAuthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void {
  if (!isObject(doc)) {
    c.report("wrong-type", "", "The OAuth server metadata must be a JSON object.", spec("3.2", "oauth-server"));
    return;
  }
  const ref = spec("3.2", "oauth-server");
  const issuer = member<string>(c, doc, "", "issuer", "string", true, ref);
  if (issuer !== undefined && poppy?.issuer !== undefined && issuer !== poppy.issuer) {
    c.report("metadata-issuer-mismatch", "/issuer", `The metadata's issuer ${JSON.stringify(issuer)} isn't exactly auth.issuer ${JSON.stringify(poppy.issuer)}.`);
  }
  httpsMember(c, doc, "", "token_endpoint", true, ref);
  httpsMember(c, doc, "", "revocation_endpoint", true, ref);
  httpsMember(c, doc, "", "authorization_endpoint", poppy?.signIn.direct ? "because poppy.json offers Direct Sign-In (auth.direct)" : false, ref);
  httpsMember(c, doc, "", "device_authorization_endpoint", poppy?.signIn.device ? "because poppy.json offers Device Sign-In (auth.device)" : false, ref);

  const domains = member<unknown[]>(c, doc, "", "poppy_domains", "array", true, ref);
  if (domains) {
    const list = stringList(c, domains, "/poppy_domains", ref);
    list.forEach((domain, index) => {
      if (!isHostname(domain)) c.report("domain-invalid", `/poppy_domains/${index}`, `poppy_domains entries are host names, not ${JSON.stringify(domain)}.`, ref);
    });
    // "Includes organization.domain": exact, ignoring only case (3.2).
    if (poppy?.domain !== undefined && !list.map((d) => d.toLowerCase()).includes(poppy.domain.toLowerCase())) {
      c.report("metadata-domain-missing", "/poppy_domains", `poppy_domains doesn't include ${poppy.domain}.`);
    }
  }

  // Advertised capabilities: optional in RFC 8414, but a list that leaves out what agents use is a problem.
  const methods = member<unknown[]>(c, doc, "", "token_endpoint_auth_methods_supported", "array", false, rfc(8414, "2"));
  if (methods && !methods.includes("private_key_jwt")) {
    c.report("metadata-auth-method", "/token_endpoint_auth_methods_supported", "token_endpoint_auth_methods_supported doesn't include private_key_jwt.");
  }
  const signingAlgs = member<unknown[]>(c, doc, "", "token_endpoint_auth_signing_alg_values_supported", "array", false, rfc(8414, "2"));
  if (signingAlgs && !signingAlgs.includes("ES256") && !signingAlgs.includes("RS256")) {
    c.report("metadata-signing-alg", "/token_endpoint_auth_signing_alg_values_supported", "token_endpoint_auth_signing_alg_values_supported lists neither ES256 nor RS256.");
  }
  const grants = member<unknown[]>(c, doc, "", "grant_types_supported", "array", false, rfc(8414, "2"));
  if (grants) {
    const needed = [JWT_BEARER, ...(poppy && (poppy.signIn.direct || poppy.signIn.device || poppy.signIn.mediated) ? ["refresh_token"] : [])];
    if (poppy?.signIn.direct) needed.push("authorization_code");
    if (poppy?.signIn.device) needed.push(DEVICE_CODE);
    for (const grant of needed) {
      if (!grants.includes(grant)) c.report("metadata-grant-type", "/grant_types_supported", `grant_types_supported doesn't include ${grant}.`);
    }
  }
  const dpop = member<unknown[]>(c, doc, "", "dpop_signing_alg_values_supported", "array", false, rfc(9449, "5.1"));
  if (dpop && !dpop.includes("ES256")) c.report("metadata-dpop-alg", "/dpop_signing_alg_values_supported", "dpop_signing_alg_values_supported doesn't include ES256.");
  if (poppy?.signIn.direct) {
    const pkce = member<unknown[]>(c, doc, "", "code_challenge_methods_supported", "array", false, rfc(8414, "2"));
    if (pkce && !pkce.includes("S256")) c.report("metadata-pkce", "/code_challenge_methods_supported", "code_challenge_methods_supported doesn't include S256.");
    if (doc.authorization_response_iss_parameter_supported !== true) {
      c.report("metadata-iss-parameter", "/authorization_response_iss_parameter_supported", "authorization_response_iss_parameter_supported isn't true.");
    }
  }
  // Other members are standard RFC 8414 fields or the Company's own; agents ignore them (3.2).
}

// Client metadata (4.1) and its key set

export function checkClientMetadata(c: Checker, doc: unknown, context: { fetchedFrom?: string }): ClientFacts {
  const facts: ClientFacts = {};
  const ref = spec("4.1", "agent-identity");
  if (!isObject(doc)) {
    c.report("wrong-type", "", "Client metadata must be a JSON object.", ref);
    return facts;
  }
  const clientId = httpsMember(c, doc, "", "client_id", true, ref, { fragment: "unstated" });
  if (clientId && context.fetchedFrom !== undefined && doc.client_id !== context.fetchedFrom) {
    c.report("client-id-mismatch", "/client_id", `client_id is ${String(doc.client_id)}, but the document was fetched from ${context.fetchedFrom}.`);
  }
  member<string>(c, doc, "", "client_name", "string", false, ref);
  if ("logo_uri" in doc) httpsMember(c, doc, "", "logo_uri", false, ref, OURS);
  const jwksUri = httpsMember(c, doc, "", "jwks_uri", true, ref, { fragment: "unstated" });
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
    if ("alg" in key && key.alg !== "ES256" && key.alg !== "RS256") c.report("jwks-alg", `${at}/alg`, `Key ${index} has alg ${JSON.stringify(key.alg)}.`);
    if ("use" in key && key.use !== "sig") c.report("jwks-use", `${at}/use`, `Key ${index} has use ${JSON.stringify(key.use)}.`);
    if (typeof key.kid !== "string" || key.kid === "") c.report("jwks-no-kid", at, `Key ${index} has no kid.`);
    else {
      if (kids.has(key.kid)) c.report("jwks-kid-duplicate", `${at}/kid`, `Two keys have kid ${JSON.stringify(key.kid)}.`);
      kids.add(key.kid);
    }
  });
}

export const draft0: Profile = {
  version: "0.1",
  name: "Draft 0.1",
  poppy: checkPoppy,
  oauthMetadata: checkOAuthMetadata,
  clientMetadata: checkClientMetadata,
  jwks: checkJwks
};
