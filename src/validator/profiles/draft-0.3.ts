/**
 * Draft 0.3 overlays 0.2 (spec/draft-0.3-retrieved-2026-10-28). What
 * changed for discovery: the issuer comes from the domain's protected
 * resource metadata (3.2), and `auth.issuer` only chooses among several;
 * the issuer's metadata lists the domain in `protected_resources` and the
 * sign-in types in `grant_types_supported`; `auth` describes scopes and
 * hints at them instead of listing sign-in types; Operations is version 2,
 * with no endpoint, and Mediated Sign-In is an extension.
 */
import { pointer } from "../json.ts";
import { mediatedExt, rfc, spec } from "../messages.ts";
import {
  httpsMember,
  httpsUrl,
  isObject,
  isScopeToken,
  label,
  member,
  stringList,
  unknownMembers,
  type Checker,
  type Obj
} from "../primitives.ts";
import { checkAgent, checkApis, checkJwks, checkMediatedFields, checkOrganization, checkScopes, checkWeb, checkClientMetadata } from "./draft-0.ts";
import { draft02 } from "./draft-0.2.ts";
import type { PoppyFacts, Profile } from "./profile.ts";

const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export const MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in";
/** Extensions defined with the protocol at 0.3, and the versions this validator knows. */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = { operations: ["2"], "mediated-sign-in": ["1"] };
/** Names a Mediated Sign-In field can't take (Mediated Sign-In 2). */
const RESERVED_FIELDS = ["grant_type", "scope", "resource", "client_id", "client_assertion", "client_assertion_type", "sign_in_id", "one_time_code"];
const CHANGES = ["none", "reversible", "irreversible"];

/** `auth` (3.1, 4.7): an optional issuer, scope descriptions and hints. */
function checkAuth(c: Checker, auth: Obj): { issuer?: string; described: string[] } {
  const issuerUrl = httpsMember(c, auth, "/auth", "issuer", false, spec("3.1", "fields"));
  if (issuerUrl?.search) c.report("issuer-query", "/auth/issuer", `auth.issuer can't have a query: ${issuerUrl.href}.`);
  const described = new Set<string>();
  const scopes = member<Obj>(c, auth, "/auth", "scopes", "object", false, spec("4.7", "scopes"));
  for (const [scope, description] of Object.entries(scopes ?? {})) {
    const at = pointer("/auth/scopes", scope);
    if (!isScopeToken(scope)) c.report("scope-syntax", at, `${JSON.stringify(scope)} isn't a valid OAuth scope.`);
    if (typeof description !== "string") c.report("wrong-type", at, `The description of ${scope} must be a string.`, spec("3.1", "fields"));
    described.add(scope);
  }
  const hints = member<Obj>(c, auth, "/auth", "scope_hints", "object", false, spec("4.7", "scopes"));
  for (const [scope, hint] of Object.entries(hints ?? {})) {
    const at = pointer("/auth/scope_hints", scope);
    if (!isScopeToken(scope)) c.report("scope-syntax", at, `${JSON.stringify(scope)} isn't a valid OAuth scope.`);
    described.add(scope);
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
  return { ...(typeof auth.issuer === "string" && issuerUrl ? { issuer: auth.issuer } : {}), described: [...described] };
}

/** `extensions` (3.3) with 0.3's: Operations 2 and Mediated Sign-In 1. Returns Mediated Sign-In's scopes when listed. */
function checkExtensions(c: Checker, extensions: Obj): readonly string[] | undefined {
  let mediated: readonly string[] | undefined;
  for (const [name, entry] of Object.entries(extensions)) {
    const at = pointer("/extensions", name);
    const slash = name.indexOf("/");
    if (slash === -1 && !(name in EXTENSIONS)) c.report("extension-plain-unknown", at, `${name} has a plain name, but the protocol defines no such extension.`);
    else if (slash !== -1 && (slash === 0 || slash === name.length - 1)) c.report("extension-name", at, `${JSON.stringify(name)} must start with a domain, such as example.com/gift-wrap.`);
    if (!isObject(entry)) {
      c.report("wrong-type", at, `The ${name} extension's entry must be an object with a version.`, spec("3.3", "extensions"));
      continue;
    }
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
    if (name === "operations") unknownMembers(c, entry, at, ["version"]);
    if (name === "mediated-sign-in") {
      const scopes = member<unknown[]>(c, entry, at, "scopes", "array", true, mediatedExt("2", "advertising-support"));
      mediated = scopes ? checkScopes(c, scopes, `${at}/scopes`) : [];
      checkMediatedFields(c, entry, at);
      const fields = Array.isArray(entry.fields) ? entry.fields : [];
      fields.forEach((field, index) => {
        if (isObject(field) && typeof field.name === "string" && RESERVED_FIELDS.includes(field.name)) {
          c.report("mediated-field-reserved", `${at}/fields/${index}/name`, `A Mediated Sign-In field can't be named ${field.name}: the grant uses that parameter.`);
        }
      });
      unknownMembers(c, entry, at, ["version", "fields", "scopes"]);
    }
  }
  return mediated;
}

function checkPoppy(c: Checker, doc: unknown, context: { requestedDomain?: string }): PoppyFacts {
  c.protocolVersion = "0.3";
  const facts: PoppyFacts = { signIn: { direct: false, device: false, mediated: false } };
  if (!isObject(doc)) {
    c.report("wrong-type", "", "poppy.json must be a JSON object.", spec("3.1", "fields"));
    return facts;
  }
  facts.domain = checkOrganization(c, doc, undefined);
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
    httpsMember(c, feedback, "/feedback", "endpoint", true);
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
  facts.describedScopes = checkedAuth?.described ?? [];
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
function checkProtectedResource(c: Checker, doc: unknown, poppy: PoppyFacts): string | undefined {
  c.protocolVersion = "0.3";
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
  list.forEach((server, index) => httpsUrl(c, server, `/authorization_servers/${index}`, ref));
  if (list.length === 0) {
    c.report("prm-no-issuer", "/authorization_servers", "authorization_servers is empty, so there is no issuer.");
    return undefined;
  }
  if (poppy.issuer !== undefined) {
    if (!list.includes(poppy.issuer)) {
      c.report("issuer-not-listed", "/authorization_servers", `auth.issuer ${poppy.issuer} isn't in authorization_servers.`);
      return undefined;
    }
    return poppy.issuer;
  }
  if (list.length > 1) {
    c.report("issuer-ambiguous", "/authorization_servers", `authorization_servers lists ${list.length} servers, and poppy.json has no auth.issuer to say which one agents use.`);
    return undefined;
  }
  return list[0];
}

/** The issuer's metadata (3.2): `protected_resources`, `grant_types_supported`, and the endpoints and scopes the sign-in types need. */
function checkOAuthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void {
  c.protocolVersion = "0.3";
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
  const dpop = member<unknown[]>(c, doc, "", "dpop_signing_alg_values_supported", "array", false, rfc(9449, "5.1"));
  if (dpop && (!dpop.includes("ES256") || dpop.some((alg) => typeof alg !== "string"))) c.report("metadata-dpop-alg", "/dpop_signing_alg_values_supported", "DPoP algorithms must be strings and include ES256.");
  if (direct) {
    const pkce = member<unknown[]>(c, doc, "", "code_challenge_methods_supported", "array", false, rfc(8414, "2"));
    if (pkce && !pkce.includes("S256")) c.report("metadata-pkce", "/code_challenge_methods_supported", "code_challenge_methods_supported doesn't include S256.");
    if (doc.authorization_response_iss_parameter_supported !== true) {
      c.report("metadata-iss-parameter", "/authorization_response_iss_parameter_supported", "authorization_response_iss_parameter_supported isn't true.");
    }
  }
  if ("poppy_domains" in doc) c.report("unknown-member", "/poppy_domains", `${label("/poppy_domains")} is 0.2's; 0.3 uses protected_resources, and agents ignore it.`);
}

export const draft03: Profile = {
  ...draft02,
  version: "0.3",
  name: "Draft 0.3",
  poppy: checkPoppy,
  protectedResource: checkProtectedResource,
  oauthMetadata: checkOAuthMetadata,
  clientMetadata(c, doc, context) { c.protocolVersion = "0.3"; return checkClientMetadata(c, doc, context); },
  jwks(c, doc) { c.protocolVersion = "0.3"; checkJwks(c, doc); }
};
