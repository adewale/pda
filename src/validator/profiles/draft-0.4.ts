/**
 * Rules for 0.4, the 1.0 release candidate (spec/draft-0.4-retrieved-2026-11-11),
 * the only version this validator checks. For discovery: the issuer comes
 * from the domain's protected resource metadata (3.2), and `auth.issuer`
 * only chooses among several; a 404 there, or no authorization server, means
 * the Company has no issuer and offers signed-out Sessions only; the issuer's
 * metadata lists the domain in `protected_resources` and the sign-in types in
 * `grant_types_supported`, and a Company that offers sign-in SHOULD offer
 * Direct Sign-In (4); `auth` describes scopes and hints at them instead of
 * listing sign-in types, and the protected resource metadata may list
 * scopes too (3.2, 4.7); `extensions` lists an entry for each major version
 * (3.3); `supported_versions` links the documents for other versions (3.4,
 * read by validate.ts); `web.disabled` and `web.unscoped` (6);
 * `tasks.endpoint` serves excluded tasks, the skill index and feedback (9);
 * Operations is version 3, whose entry may name an `endpoint` for website
 * operations, and Mediated Sign-In and Browser Control are extensions; every
 * URL is HTTPS (3), but for a Personal Agent's loopback redirect URIs (4.1).
 *
 * Each rule is its own exported function, so the profile for a later
 * version can import the ones that still apply and replace the ones that
 * changed.
 */
import { departure, ours, show, shown, type Shown } from "../../diagnostic.ts";
import { pointer } from "../json.ts";
import { base64url, fromBase64url } from "../../base64url.ts";
import { extension, mediatedExt, rfc, spec, type Ref } from "../messages.ts";
import {
  httpsMember,
  httpsUrl,
  isHostname,
  isObject,
  isScopeToken,
  member,
  sameDomain,
  stringList,
  subject,
  unknownMembers,
  type Checker,
  type Obj,
  type UrlRules
} from "../primitives.ts";
import type { ClientFacts, PoppyFacts, Profile } from "./profile.ts";

const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export const MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in";
const BROWSER_SIGN_IN = "poppy:browser-sign-in";
const API_TYPES = ["openapi", "mcp"];
/** Extensions defined with the protocol at 0.4, and the versions this validator knows. */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  operations: ["3"],
  "mediated-sign-in": ["1"],
  links: ["1"],
  disclosures: ["1"],
  ucp: ["1"],
  "browser-control": ["1"]
};
/** `access` values a `poppy` conversation entry may declare (3.2). */
const ACCESS = ["session", "signed_in"];
/** Names a Mediated Sign-In field can't take (Mediated Sign-In 2). */
const RESERVED_FIELDS = ["grant_type", "scope", "resource", "client_id", "client_assertion", "client_assertion_type", "sign_in_id", "one_time_code"];
const LOOKS_SECRET = /pass(word|code|phrase)?|\bpin\b|otp|one.?time|secret|security.?(code|answer)|cvv|cvc/i;
const CHANGES = ["none", "reversible", "irreversible"];
/** URLs no rule keeps free of a fragment (spec-issues N9): we do, as a reading. */
const OURS: UrlRules = { fragment: "unstated" };

// poppy.json

/** `organization` (3.1): its name and domain. Returns the domain when it is a host name, with a port where `rules` allow one. */
export function checkOrganization(c: Checker, doc: Obj, rules: PoppyRules = {}): string | undefined {
  const organization = member<Obj>(c, doc, "", "organization", "object", true);
  if (!organization) return undefined;
  const name = member<string>(c, organization, "/organization", "name", "string", false);
  if (!("name" in organization)) {
    c.report("organization-name-missing", "/organization/name", departure(ours("organization.name"), ours("the Company's display name"), ours("none")));
  } else if (name !== undefined && name.trim() === "") {
    c.report("organization-name-missing", "/organization/name", departure(ours("organization.name"), ours("the Company's display name"), ours("a blank one")));
  }
  const domain = member<string>(c, organization, "/organization", "domain", "string", true);
  httpsMember(c, organization, "/organization", "logo_uri", false, spec("3.1", "fields"));
  unknownMembers(c, organization, "/organization", ["name", "domain", "logo_uri"]);
  if (domain === undefined) return undefined;
  // 1.0 (3.1): "with its port when that isn't 443".
  const port = rules.domainPort ? /^(.+):([1-9][0-9]{0,4})$/.exec(domain) : null;
  const host = port ? port[1]! : domain;
  if (!isHostname(host) || (port && (Number(port[2]) > 65535 || port[2] === "443"))) {
    const what = rules.domainPort ? ours("a host name, with a port only when it isn't 443") : ours("a bare host name");
    c.report("domain-invalid", "/organization/domain", departure(ours("organization.domain"), what, show.value(domain)));
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
    if (!isScopeToken(scope)) c.report("scope-syntax", here, departure(subject(here), ours("an OAuth scope token (RFC 6749 §3.3)"), show.value(scope)));
    if (seen.has(scope)) c.report("scope-duplicate", here, departure(subject(at), ours("each scope once"), shown`${show.value(scope)} twice`));
    seen.add(scope);
  });
  if (value.length === 0) c.report("scopes-empty", at, departure(subject(at), ours("at least one scope"), ours("none"), ours("Mediated Sign-In can't grant anything")));
  return scopes;
}

/** The Mediated Sign-In extension's `fields` (Mediated Sign-In 2), in its entry at `at`. */
export function checkMediatedFields(c: Checker, mediated: Obj, at: string): void {
  const ref = mediatedExt("2", "support");
  const fields = member<unknown[]>(c, mediated, at, "fields", "array", true, ref);
  if (!fields) return;
  if (fields.length === 0) c.report("mediated-fields-empty", `${at}/fields`, departure(subject(`${at}/fields`), ours("at least one field"), ours("none")));
  const names = new Set<string>();
  fields.forEach((field, index) => {
    const fieldAt = `${at}/fields/${index}`;
    if (!isObject(field)) {
      c.report("wrong-type", fieldAt, departure(subject(fieldAt), ours("an object with name, label and secret"), show.kind(field)), ref);
      return;
    }
    const name = member<string>(c, field, fieldAt, "name", "string", true, ref);
    const fieldLabel = member<string>(c, field, fieldAt, "label", "string", true, ref);
    const secret = member<boolean>(c, field, fieldAt, "secret", "boolean", false, ref);
    if (!("secret" in field)) c.report("mediated-secret-missing", `${fieldAt}/secret`, departure(subject(`${fieldAt}/secret`), ours("true or false, saying whether the field is secret"), ours("none")));
    if (secret === false && LOOKS_SECRET.test(`${name ?? ""} ${fieldLabel ?? ""}`)) {
      c.report("mediated-looks-secret", `${fieldAt}/secret`, departure(shown`${name === undefined ? subject(fieldAt) : show.value(name)}'s secret`, ours("true, for a field whose name or label looks like a secret"), ours("false")));
    }
    if (name !== undefined) {
      if (RESERVED_FIELDS.includes(name)) c.report("mediated-field-reserved", `${fieldAt}/name`, departure(subject(`${fieldAt}/name`), ours("a name the grant doesn't use as a parameter"), show.value(name)));
      if (names.has(name)) c.report("mediated-field-duplicate", `${fieldAt}/name`, departure(ours("the fields' names"), ours("each name once"), shown`${show.value(name)} twice`));
      names.add(name);
    }
    unknownMembers(c, field, fieldAt, ["name", "label", "secret"]);
  });
}

/** Where a later version's poppy.json rules differ from 0.4's, which it otherwise reuses. */
export type PoppyRules = {
  /** 1.0: every `agent.protocols` entry has a `description` (8.1). */
  readonly protocolDescriptions?: { readonly ref: Ref };
  /** 1.0: `organization.domain` carries its port when that isn't 443 (3.1). */
  readonly domainPort?: true;
};

/** Where a later version's OAuth server metadata rules differ from 0.4's. */
export type OAuthRules = {
  /** 1.0: Companies MUST accept client assertions signed with ES256 and with PS384 (4.1). */
  readonly assertionAlgs?: { readonly ref: Ref };
};

/** `agent` (3.1, 8.1): its conversation protocols, one of them poppy. Returns whether a poppy entry declares `signed_in` access (3.2). */
export function checkAgent(c: Checker, agent: Obj, rules: PoppyRules = {}): boolean {
  const ref = spec("8.1", "conversation-protocols");
  const protocols = member<unknown[]>(c, agent, "/agent", "protocols", "array", true, ref);
  unknownMembers(c, agent, "/agent", ["protocols"]);
  if (!protocols) return false;
  let poppy = false;
  let signedIn = false;
  protocols.forEach((entry, index) => {
    const at = `/agent/protocols/${index}`;
    if (!isObject(entry)) {
      c.report("wrong-type", at, departure(subject(at), ours("an object with type and endpoint"), show.kind(entry)), ref);
      return;
    }
    const type = member<string>(c, entry, at, "type", "string", true, ref);
    httpsMember(c, entry, at, "endpoint", true, ref, OURS);
    const described = rules.protocolDescriptions;
    if (described) {
      const description = member<string>(c, entry, at, "description", "string", true, described.ref);
      if (description !== undefined && description.trim() === "") c.report("protocol-description-empty", `${at}/description`, departure(subject(`${at}/description`), ours("a description"), ours("an empty one")));
    }
    if (type === "poppy") {
      poppy = true;
      // 3.2: an advance hint, session (the default) or signed_in; agents ignore other values.
      const access = member<string>(c, entry, at, "access", "string", false, spec("3.2", "oauth-server"));
      if (access === "signed_in") signedIn = true;
      else if (access !== undefined && !ACCESS.includes(access)) c.report("access-unknown", `${at}/access`, shown`access is ${show.value(access)}, which agents ignore, as if there were no hint`);
    } else if (type !== undefined) c.report("protocol-type-unknown", `${at}/type`, shown`Agents that don't know ${show.value(type)} skip this entry`);
    // No `resource` since 0.3 (4.5): a service that takes only its own tokens says so in its protected resource metadata.
    unknownMembers(c, entry, at, [...(type === "poppy" ? ["type", "endpoint", "access"] : ["type", "endpoint"]), ...(described ? ["description"] : [])]);
  });
  if (!poppy) c.report("no-poppy-protocol", "/agent/protocols", departure(ours("agent.protocols"), ours("an entry of type poppy"), ours("none")));
  return signedIn;
}

/** `apis` (3.1, 7): each with a type, an HTTPS url and a description. */
export function checkApis(c: Checker, apis: unknown[]): void {
  const ref = spec("7", "apis");
  apis.forEach((entry, index) => {
    const at = `/apis/${index}`;
    if (!isObject(entry)) {
      c.report("wrong-type", at, departure(subject(at), ours("an object with type, url and description"), show.kind(entry)), ref);
      return;
    }
    const type = member<string>(c, entry, at, "type", "string", true, ref);
    if (type !== undefined && !API_TYPES.includes(type)) {
      c.report("api-type-unknown", `${at}/type`, shown`${show.value(type)} isn't an API type this version defines (openapi or mcp); agents that don't know it skip it`);
    }
    httpsMember(c, entry, at, "url", true, ref, OURS);
    const description = member<string>(c, entry, at, "description", "string", false, spec("3.1", "fields"));
    if (!("description" in entry) || description === "") {
      c.report("api-description-missing", `${at}/description`, departure(subject(`${at}/description`), ours("a description to help agents choose the API"), "description" in entry ? ours("an empty one") : ours("none")));
    }
    // No `resource` since 0.3 (4.5), as for agent.protocols.
    unknownMembers(c, entry, at, ["type", "url", "description"]);
  });
}

/** `web` (3.1, 6): the browser-session endpoint, `disabled` and `unscoped`. */
export function checkWeb(c: Checker, web: Obj): { browserSession: boolean; disabled: boolean; unscoped: boolean } {
  const ref = spec("6", "web-browsing");
  const endpoint = httpsMember(c, web, "/web", "browser_session_endpoint", false, ref, OURS);
  const disabled = member<boolean>(c, web, "/web", "disabled", "boolean", false, spec("3.1", "fields")) === true;
  const unscoped = member<boolean>(c, web, "/web", "unscoped", "boolean", false, spec("3.1", "fields")) === true;
  unknownMembers(c, web, "/web", ["browser_session_endpoint", "disabled", "unscoped"]);
  return { browserSession: endpoint !== undefined || "browser_session_endpoint" in web, disabled, unscoped };
}

/** `auth` (3.1, 4.7): an optional issuer, `disabled`, scope descriptions and hints. Returns the issuer, `disabled` and the scopes `auth.scopes` describes. */
export function checkAuth(c: Checker, auth: Obj): { issuer?: string; disabled: boolean; described: string[] } {
  const issuerUrl = httpsMember(c, auth, "/auth", "issuer", false, spec("3.1", "fields"));
  const disabled = member<boolean>(c, auth, "/auth", "disabled", "boolean", false, spec("3.2", "oauth-server")) === true;
  if (issuerUrl?.search) c.report("issuer-query", "/auth/issuer", departure(ours("auth.issuer"), ours("an issuer URL without a query"), ours("one with a query")));
  const described: string[] = [];
  const scopes = member<Obj>(c, auth, "/auth", "scopes", "object", false, spec("4.7", "scopes"));
  for (const [scope, description] of Object.entries(scopes ?? {})) {
    const at = pointer("/auth/scopes", scope);
    if (!isScopeToken(scope)) c.report("scope-syntax", at, departure(ours("a scope in auth.scopes"), ours("an OAuth scope token (RFC 6749 §3.3)"), show.value(scope)));
    if (typeof description !== "string") c.report("wrong-type", at, departure(subject(at), ours("a description, as a string"), show.kind(description)), spec("3.1", "fields"));
    described.push(scope);
  }
  const hints = member<Obj>(c, auth, "/auth", "scope_hints", "object", false, spec("4.7", "scopes"));
  for (const [scope, hint] of Object.entries(hints ?? {})) {
    const at = pointer("/auth/scope_hints", scope);
    if (!isScopeToken(scope)) c.report("scope-syntax", at, departure(ours("a scope in auth.scope_hints"), ours("an OAuth scope token (RFC 6749 §3.3)"), show.value(scope)));
    if (!isObject(hint)) {
      c.report("scope-hint-invalid", at, departure(subject(at), ours("an object with changes and personal_data"), show.kind(hint)));
      continue;
    }
    if (typeof hint.changes !== "string" || typeof hint.personal_data !== "boolean") {
      c.report("scope-hint-invalid", at, departure(subject(at), ours("changes, a string, and personal_data, a boolean"), shown`changes as ${show.kind(hint.changes)} and personal_data as ${show.kind(hint.personal_data)}`));
    } else if (!CHANGES.includes(hint.changes)) {
      c.report("scope-hint-changes-unknown", pointer(at, "changes"), shown`changes is ${show.value(hint.changes)}, which agents read as irreversible`);
    }
    unknownMembers(c, hint, at, ["changes", "personal_data"]);
  }
  unknownMembers(c, auth, "/auth", ["issuer", "disabled", "scopes", "scope_hints"]);
  return { ...(typeof auth.issuer === "string" && issuerUrl ? { issuer: auth.issuer } : {}), disabled, described };
}

type Extensions = { mediated?: readonly string[]; operationsEndpoint?: boolean; browserControl?: boolean };

/** `extensions` (3.3): each a list of version entries. Returns what discovery needs from the ones it knows. */
export function checkExtensions(c: Checker, extensions: Obj): Extensions {
  const found: Extensions = {};
  const ref = spec("3.3", "extensions");
  for (const [name, entries] of Object.entries(extensions)) {
    const at = pointer("/extensions", name);
    const slash = name.indexOf("/");
    if (slash === -1) {
      if (!(name in EXTENSIONS)) c.report("extension-plain-unknown", at, departure(ours("an extension with a plain name"), shown`one the protocol defines (${show.list(Object.keys(EXTENSIONS).map((known) => show.code(known)))})`, show.value(name)));
    } else if (!isHostname(name.slice(0, slash)) || slash === name.length - 1) {
      c.report("extension-name", at, departure(ours("an extension's name"), ours("a domain, then a name, such as example.com/gift-wrap"), show.value(name)));
    }
    if (!Array.isArray(entries)) {
      c.report("extension-entries", at, departure(shown`the ${show.value(name)} extension`, ours('a list of version entries, such as [{ "version": "1" }]'), isObject(entries) ? ours("a single object, as in 0.3") : show.value(entries)));
      continue;
    }
    entries.forEach((entry, index) => {
      const entryAt = `${at}/${index}`;
      if (!isObject(entry)) {
        c.report("wrong-type", entryAt, departure(subject(entryAt), ours("an object with a version"), show.kind(entry)), ref);
        return;
      }
      if (typeof entry.version === "number") {
        c.report("extension-version-number", `${entryAt}/version`, departure(subject(`${entryAt}/version`), shown`a string, such as ${show.value(String(entry.version))}`, shown`the number ${entry.version}`));
        return;
      }
      const version = member<string>(c, entry, entryAt, "version", "string", true, ref);
      if (version === undefined) return;
      const known = EXTENSIONS[name];
      if (!known) return;
      if (!known.includes(version)) {
        c.report("extension-version-unknown", `${entryAt}/version`, shown`${show.value(name)} version ${show.value(version)} isn't one this validator knows (${show.list(known.map((v) => show.value(v)), "or")})`);
        return;
      }
      if (name === "operations") {
        const endpoint = httpsMember(c, entry, entryAt, "endpoint", false, extension("operations", "Operations", "2", "support"), OURS);
        if (endpoint !== undefined || "endpoint" in entry) found.operationsEndpoint = true;
        unknownMembers(c, entry, entryAt, ["version", "endpoint"]);
      } else if (name === "mediated-sign-in") {
        const scopes = member<unknown[]>(c, entry, entryAt, "scopes", "array", true, mediatedExt("2", "support"));
        found.mediated = scopes ? checkScopes(c, scopes, `${entryAt}/scopes`) : [];
        checkMediatedFields(c, entry, entryAt);
        unknownMembers(c, entry, entryAt, ["version", "fields", "scopes"]);
      } else if (name === "browser-control") {
        found.browserControl = true;
        unknownMembers(c, entry, entryAt, ["version"]);
      }
    });
  }
  return found;
}

export function checkPoppy(c: Checker, doc: unknown, context: { requestedDomain?: string }, rules: PoppyRules = {}): PoppyFacts {
  const facts: PoppyFacts = { signIn: { direct: false, device: false, mediated: false } };
  if (!isObject(doc)) {
    c.report("wrong-type", "", departure(ours("poppy.json"), ours("a JSON object"), show.kind(doc)), spec("3.1", "fields"));
    return facts;
  }
  facts.domain = checkOrganization(c, doc, rules);
  // The host that served the document, after redirects, ignoring case only (3.1).
  if (facts.domain && context.requestedDomain && facts.domain.toLowerCase() !== context.requestedDomain.toLowerCase()) {
    c.report("organization-domain-mismatch", "/organization/domain", departure(ours("organization.domain"), shown`${show.value(context.requestedDomain)}, the host that served the document`, show.value(facts.domain)));
  }
  const agent = member<Obj>(c, doc, "", "agent", "object", false);
  const apis = member<unknown[]>(c, doc, "", "apis", "array", false);
  const web = member<Obj>(c, doc, "", "web", "object", false);
  const signedInAccess = agent ? checkAgent(c, agent, rules) : false;
  if (apis) checkApis(c, apis);
  const checkedWeb = web ? checkWeb(c, web) : { browserSession: false, disabled: false, unscoped: false };
  if (!("agent" in doc) && !("apis" in doc) && !("web" in doc)) c.report("nothing-offered", "", departure(ours("poppy.json"), ours("at least one of agent, apis or web"), ours("none")));
  if (checkedWeb.browserSession) facts.browserSession = true;
  if (checkedWeb.unscoped && !checkedWeb.browserSession) c.report("web-unscoped-without-join", "/web/unscoped", departure(ours("web.browser_session_endpoint, with web.unscoped true"), ours("an endpoint"), ours("none")));
  if (checkedWeb.disabled) {
    if (checkedWeb.browserSession) c.report("web-disabled-browser-session", "/web/browser_session_endpoint", departure(ours("web.browser_session_endpoint, with web.disabled true"), ours("none"), ours("an endpoint")));
    if (!("agent" in doc) && !("apis" in doc)) c.report("web-disabled-no-alternative", "/web/disabled", departure(ours("poppy.json, with web.disabled true"), ours("agent or apis, for agents to use instead"), ours("neither")));
  }
  const tasks = member<Obj>(c, doc, "", "tasks", "object", false, spec("9", "task-coverage"));
  if (tasks) {
    httpsMember(c, tasks, "/tasks", "endpoint", true, spec("9", "task-coverage"), OURS);
    unknownMembers(c, tasks, "/tasks", ["endpoint"]);
  }
  // 0.3's places for these; a Company moving to 0.4 may still list them.
  for (const moved of ["feedback", "excluded_tasks", "skill_index"]) {
    if (moved in doc) c.report("member-moved-to-tasks", `/${moved}`, shown`${show.path(`/${moved}`)} is 0.3's; 0.4 agents read it from the response at tasks.endpoint, and ignore it here`);
  }
  const auth = member<Obj>(c, doc, "", "auth", "object", false);
  const checkedAuth = auth ? checkAuth(c, auth) : undefined;
  if (checkedAuth?.issuer) facts.issuer = checkedAuth.issuer;
  if (checkedAuth?.disabled) facts.disabled = true;
  // An OpenAPI description may describe scopes too (4.7); the validator doesn't read one, so it can't tell which.
  const openapi = apis?.some((entry) => isObject(entry) && entry.type === "openapi") ?? false;
  if (!openapi) facts.describedScopes = checkedAuth?.described ?? [];
  const extensions = member<Obj>(c, doc, "", "extensions", "object", false);
  const found = extensions ? checkExtensions(c, extensions) : {};
  if (found.mediated) {
    facts.mediatedScopes = found.mediated;
    facts.signIn.mediated = true;
  }
  if (found.operationsEndpoint && !checkedWeb.browserSession) {
    c.report("operations-endpoint-without-join", "/extensions/operations", departure(ours("web.browser_session_endpoint, with an operations endpoint for website operations"), ours("an endpoint"), ours("none")));
  }
  if (found.browserControl && !checkedWeb.browserSession) {
    c.report("browser-control-without-join", "/extensions/browser-control", departure(ours("web.browser_session_endpoint, with browser-control listed"), ours("an endpoint"), ours("none")));
  }
  // 3.2: these use Sessions, so the Company's identifier matters: its issuer, or its domain when it has none.
  facts.usesSessions = !!(agent || apis || tasks || checkedWeb.browserSession || found.mediated || (extensions && Object.keys(extensions).length > 0));
  // 3.2: a Company that offers sign-in MUST have an issuer.
  const needsIssuer: Shown[] = [
    ...(checkedAuth?.issuer ? [ours("auth.issuer")] : []),
    ...(found.mediated ? [ours("the Mediated Sign-In extension")] : []),
    ...(signedInAccess ? [ours("signed_in access")] : [])
  ];
  if (needsIssuer.length) facts.needsIssuer = needsIssuer;
  // 3.2: auth.disabled offers no sign-in, so nothing may promise one.
  if (checkedAuth?.disabled) {
    if (found.mediated) c.report("auth-disabled-sign-in", "/extensions/mediated-sign-in", departure(ours("poppy.json, with auth.disabled true"), ours("nothing that offers sign-in"), ours("the Mediated Sign-In extension")));
    if (signedInAccess) c.report("auth-disabled-sign-in", "/agent/protocols", departure(ours("poppy.json, with auth.disabled true"), ours("nothing that offers sign-in"), ours("a poppy conversation entry with signed_in access")));
  }
  if (!facts.usesSessions && !auth) c.report("website-only", "", ours("Nothing here uses Sessions: agents can only browse this Company's website, signed out"));
  unknownMembers(c, doc, "", ["protocol_version", "supported_versions", "organization", "auth", "agent", "apis", "web", "tasks", "extensions", "feedback", "excluded_tasks", "skill_index"]);
  return facts;
}

/** The domain's protected resource metadata (3.2, RFC 9728): `resource` is the domain; `authorization_servers` names the issuer. */
export function checkProtectedResource(c: Checker, doc: unknown, poppy: PoppyFacts): string | null | undefined {
  const ref = spec("3.2", "oauth-server");
  if (!isObject(doc)) {
    c.report("wrong-type", "", departure(ours("the protected resource metadata"), ours("a JSON object"), show.kind(doc)), ref);
    return undefined;
  }
  const resource = member<string>(c, doc, "", "resource", "string", true, ref);
  if (resource !== undefined && poppy.domain !== undefined && resource !== `https://${poppy.domain}` && resource.toLowerCase() !== `https://${poppy.domain.toLowerCase()}`) {
    c.report("prm-resource-mismatch", "/resource", departure(ours("resource"), show.value(`https://${poppy.domain}`), show.value(resource)));
  }
  if (Array.isArray(doc.scopes_supported)) undescribedScopes(c, doc.scopes_supported, poppy.describedScopes);
  // 3.2: absent or empty, the Company has no issuer; a value of the wrong type settles nothing.
  if (!("authorization_servers" in doc)) {
    noIssuer(c, poppy, "empty");
    return resource === undefined ? undefined : null;
  }
  const servers = member<unknown[]>(c, doc, "", "authorization_servers", "array", false, ref);
  if (!servers) return undefined;
  const list = stringList(c, servers, "/authorization_servers", ref);
  // A diagnostic does not make a malformed issuer usable for metadata discovery.
  const usable = new Set(list.filter((server, index) => httpsUrl(c, server, `/authorization_servers/${index}`, ref) !== undefined));
  if (servers.length === 0) {
    noIssuer(c, poppy, "empty");
    return resource === undefined ? undefined : null;
  }
  if (poppy.issuer !== undefined) {
    if (!list.includes(poppy.issuer)) {
      c.report("issuer-not-listed", "/authorization_servers", departure(ours("authorization_servers"), shown`a list including ${show.value(poppy.issuer)}, poppy.json's auth.issuer`, show.count(list.length, ours("server without it"), ours("servers without it"))));
      return undefined;
    }
    return usable.has(poppy.issuer) ? poppy.issuer : undefined;
  }
  if (list.length > 1) {
    c.report("issuer-ambiguous", "/authorization_servers", departure(ours("the issuer"), ours("one authorization server, or auth.issuer in poppy.json to say which one agents use"), shown`${show.count(list.length, ours("server"), ours("servers"))} and no auth.issuer`));
    return undefined;
  }
  return usable.has(list[0]!) ? list[0] : undefined;
}

/**
 * 4.7: the Company SHOULD describe each scope it offers Personal Agents, in
 * an OpenAPI description or otherwise in auth.scopes. `described` is unset
 * when poppy.json lists an OpenAPI description, which may describe the rest.
 */
function undescribedScopes(c: Checker, scopes: unknown[] | undefined, described: readonly string[] | undefined): void {
  if (!scopes || !described) return;
  scopes.forEach((scope, index) => {
    if (typeof scope === "string" && !described.includes(scope)) {
      c.report("scope-undescribed", `/scopes_supported/${index}`, departure(shown`the description of ${show.value(scope)}`, ours("one in poppy.json's auth.scopes, or an OpenAPI description that could have one"), ours("neither")));
    }
  });
}

/**
 * No issuer (3.2): the protected resource metadata is a 404, or names no
 * authorization server. The Company offers signed-out Sessions only, and
 * its identifier is `https://{organization.domain}`. Valid only when
 * nothing in poppy.json offers sign-in.
 */
export function noIssuer(c: Checker, poppy: PoppyFacts, how: "not-found" | "empty"): void {
  const where = how === "not-found" ? ours("The domain publishes no protected resource metadata (HTTP 404)") : ours("The domain's protected resource metadata lists no authorization server");
  const said = how === "not-found" ? ours("no protected resource metadata (HTTP 404)") : ours("protected resource metadata that lists no authorization server");
  const at = how === "not-found" ? "" : "/authorization_servers";
  const identifier = poppy.domain === undefined ? ours("https://{organization.domain}") : show.url(`https://${poppy.domain.toLowerCase()}`, `https://${poppy.domain.toLowerCase()}`);
  c.report("prm-no-issuer", at, shown`${where}, so the Company has no issuer: it offers signed-out Sessions only, and its identifier is ${identifier}`);
  if (poppy.needsIssuer?.length) {
    c.report("issuer-required", at, departure(shown`the issuer, for sign-in through ${show.list(poppy.needsIssuer)}`, ours("protected resource metadata that names one"), said));
  }
}

/**
 * The issuer's metadata (3.2, RFC 8414): `protected_resources`,
 * `grant_types_supported`, and the endpoints and scopes the sign-in types
 * need, with the scopes the domain's protected resource metadata lists
 * counted as listed (3.2, 4.7), `poppy:browser-sign-in` with browser join
 * (6), and Direct Sign-In preferred (4).
 */
export function checkOAuthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined, rules: OAuthRules = {}): void {
  const ref = spec("3.2", "oauth-server");
  const resourceScopes = poppy?.resourceScopes;
  if (!isObject(doc)) {
    c.report("wrong-type", "", departure(ours("the OAuth server metadata"), ours("a JSON object"), show.kind(doc)), ref);
    return;
  }
  const issuer = member<string>(c, doc, "", "issuer", "string", true, ref);
  if (issuer !== undefined && poppy?.issuer !== undefined && issuer !== poppy.issuer) {
    c.report("metadata-issuer-mismatch", "/issuer", departure(ours("issuer"), shown`exactly ${show.value(poppy.issuer)}, the issuer the domain names`, show.value(issuer)));
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
        // `host` keeps a port other than 443, which only 1.0's organization.domain can have (3.1).
        return `${url.protocol}//${url.host}` === wanted && entry.length === wanted.length;
      } catch {
        return false;
      }
    };
    if (wanted !== undefined && !list.some(matches)) {
      c.report("metadata-protected-resources", "/protected_resources", departure(ours("protected_resources"), shown`a list including ${show.value(`https://${poppy!.domain}`)}`, show.count(list.length, ours("entry without it"), ours("entries without it"))));
    }
  }
  const grants = member<unknown[]>(c, doc, "", "grant_types_supported", "array", true, ref);
  const list = grants ? stringList(c, grants, "/grant_types_supported", ref) : [];
  if (grants && !list.includes("refresh_token")) c.report("metadata-refresh-grant", "/grant_types_supported", departure(ours("grant_types_supported"), ours("a list including refresh_token"), shown`${show.list(list.map((grant) => show.value(grant)))}`));
  const direct = list.includes("authorization_code");
  const device = list.includes(DEVICE_CODE);
  httpsMember(c, doc, "", "authorization_endpoint", direct ? ours("since grant_types_supported includes authorization_code") : false, ref);
  httpsMember(c, doc, "", "device_authorization_endpoint", device ? ours("since grant_types_supported includes the device code grant") : false, ref);
  // RFC 9126 §5: Pushed Authorization Requests, which a Personal Agent then uses for Direct Sign-In (1.0: 4.2).
  const par = rfc(9126, "5");
  httpsMember(c, doc, "", "pushed_authorization_request_endpoint", false, par);
  const requirePushed = member<boolean>(c, doc, "", "require_pushed_authorization_requests", "boolean", false, par);
  if (requirePushed === true && !("pushed_authorization_request_endpoint" in doc)) {
    c.report("par-endpoint-missing", "/require_pushed_authorization_requests", departure(ours("pushed_authorization_request_endpoint, with require_pushed_authorization_requests true"), ours("an endpoint"), ours("none"), ours("No Personal Agent can sign in directly")));
  }
  if (poppy?.signIn.mediated && grants && !list.includes(MEDIATED_GRANT)) {
    c.report("mediated-grant-missing", "/grant_types_supported", departure(ours("grant_types_supported, with Mediated Sign-In in poppy.json"), shown`a list including ${show.value(MEDIATED_GRANT)}`, ours("a list without it")));
  }
  const signsIn = (direct || device || !!poppy?.signIn.mediated) && !poppy?.disabled;
  // 3.2: a Company that offers sign-in SHOULD publish scopes_supported (RFC 8414 §2 makes it optional).
  const scopes = member<unknown[]>(c, doc, "", "scopes_supported", "array", false, ref);
  if (signsIn && !("scopes_supported" in doc) && resourceScopes === undefined) {
    c.report("scopes-supported-missing", "/scopes_supported", departure(ours("scopes_supported, in the issuer's or the protected resource metadata"), ours("a list of the scopes agents can request"), ours("none"), ours("Agents learn the scopes only from the Company's API descriptions and auth.scopes")));
  }
  const supported = scopes ? stringList(c, scopes, "/scopes_supported", ref) : [];
  const listed = [...new Set([...supported, ...(resourceScopes ?? [])])];
  for (const scope of poppy?.mediatedScopes ?? []) {
    if ((scopes || resourceScopes) && !listed.includes(scope)) c.report("mediated-scope-unsupported", "/scopes_supported", departure(ours("scopes_supported"), shown`a list including ${show.value(scope)}, which Mediated Sign-In offers`, ours("a list without it")));
  }
  // The domain's own list, when it has one, names the scopes it offers Personal Agents (docs/readings.md#v04-scope-descriptions).
  if (!resourceScopes?.length) undescribedScopes(c, scopes, poppy?.describedScopes);
  if (rules.assertionAlgs) {
    const algs = member<unknown[]>(c, doc, "", "token_endpoint_auth_signing_alg_values_supported", "array", false, rules.assertionAlgs.ref);
    const listed = algs ? stringList(c, algs, "/token_endpoint_auth_signing_alg_values_supported", rules.assertionAlgs.ref) : null;
    const missing = listed ? ["ES256", "PS384"].filter((alg) => !listed.includes(alg)) : [];
    if (missing.length > 0) {
      c.report("metadata-assertion-algs", "/token_endpoint_auth_signing_alg_values_supported", departure(ours("token_endpoint_auth_signing_alg_values_supported"), ours("a list including ES256 and PS384, which 1.0 Companies must accept for client assertions"), shown`a list without ${show.list(missing.map((alg) => show.code(alg)))}`));
    }
  }
  const dpop = member<unknown[]>(c, doc, "", "dpop_signing_alg_values_supported", "array", false, rfc(9449, "5.1"));
  if (dpop && !stringList(c, dpop, "/dpop_signing_alg_values_supported", rfc(9449, "5.1")).includes("ES256")) {
    c.report("metadata-dpop-alg", "/dpop_signing_alg_values_supported", ours("dpop_signing_alg_values_supported doesn't include ES256, so agents that sign proofs only with ES256 send none"));
  }
  if (direct) {
    const pkce = member<unknown[]>(c, doc, "", "code_challenge_methods_supported", "array", false, rfc(8414, "2"));
    if (pkce && !pkce.includes("S256")) c.report("metadata-pkce", "/code_challenge_methods_supported", departure(ours("code_challenge_methods_supported"), ours("a list including S256"), ours("a list without it")));
    if (doc.authorization_response_iss_parameter_supported !== true) {
      c.report("metadata-iss-parameter", "/authorization_response_iss_parameter_supported", ours("authorization_response_iss_parameter_supported isn't true"));
    }
  }
  if ("poppy_domains" in doc) c.report("unknown-member", "/poppy_domains", ours("poppy_domains is 0.2's; protected_resources replaced it, and agents ignore it"));
  // Other members are standard RFC 8414 fields or the Company's own; agents ignore them (3.2).
  if (poppy?.disabled) return;
  // 6: browser join with sign-in needs poppy:browser-sign-in, in either list of scopes.
  const lists = [doc.scopes_supported, resourceScopes].filter(Array.isArray);
  if (poppy?.browserSession && lists.length && !lists.some((scopeList) => scopeList.includes(BROWSER_SIGN_IN))) {
    c.report("browser-sign-in-unsupported", "/scopes_supported", departure(ours("scopes_supported, with web.browser_session_endpoint in poppy.json"), shown`a list including ${show.code(BROWSER_SIGN_IN)}, in the issuer's or the protected resource metadata`, ours("lists without it")));
  }
  // 4: Direct Sign-In is the preferred type.
  if (device && !direct) {
    c.report("direct-sign-in-preferred", "/grant_types_supported", departure(ours("the sign-in types the issuer offers"), ours("Direct Sign-In (authorization_code), the preferred type"), ours("Device Sign-In alone")));
  }
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
    c.report("wrong-type", "", departure(ours("the client metadata"), ours("a JSON object"), show.kind(doc)), ref);
    return facts;
  }
  const clientId = httpsMember(c, doc, "", "client_id", true, ref, OURS);
  if (clientId && context.fetchedFrom !== undefined && doc.client_id !== context.fetchedFrom) {
    c.report("client-id-mismatch", "/client_id", departure(ours("client_id"), shown`${show.value(context.fetchedFrom)}, the URL the document was fetched from`, show.value(doc.client_id)));
  }
  member<string>(c, doc, "", "client_name", "string", false, ref);
  if ("logo_uri" in doc) httpsMember(c, doc, "", "logo_uri", false, ref, OURS);
  const jwksUri = httpsMember(c, doc, "", "jwks_uri", true, ref, OURS);
  if (jwksUri && clientId && !sameDomain(jwksUri.hostname, clientId.hostname)) {
    c.report("client-other-domain", "/jwks_uri", departure(ours("jwks_uri"), shown`a URL on ${show.name(clientId.hostname)}, client_id's domain`, shown`one on ${show.name(jwksUri.hostname)}`));
  }
  if (jwksUri) facts.jwksUri = jwksUri.href;
  const redirects = member<unknown[]>(c, doc, "", "redirect_uris", "array", false, ref);
  if (!("redirect_uris" in doc) || redirects?.length === 0) {
    c.report("client-no-redirects", "/redirect_uris", ours("No redirect_uris, so this agent can't use Direct Sign-In"));
  }
  redirects?.forEach((value, index) => {
    const at = `/redirect_uris/${index}`;
    // An app on the User's computer may use a loopback redirect URI, the one exception to HTTPS (3, 4.1).
    if (isLoopbackRedirect(value)) {
      if (value.includes("#")) c.report("url-has-fragment", at, departure(subject(at), ours("a URL without a #fragment"), ours("a URL with one")), rfc(6749, "3.1.2"));
      return;
    }
    const url = httpsUrl(c, value, at, ref);
    if (url && clientId && !sameDomain(url.hostname, clientId.hostname)) {
      c.report("client-other-domain", at, departure(subject(at), shown`a URL on ${show.name(clientId.hostname)}, client_id's domain`, shown`one on ${show.name(url.hostname)}`));
    }
  });
  if (doc.token_endpoint_auth_method !== "private_key_jwt") {
    c.report(
      "client-auth-method",
      "/token_endpoint_auth_method",
      departure(ours("token_endpoint_auth_method"), ours('"private_key_jwt"'), "token_endpoint_auth_method" in doc ? show.value(doc.token_endpoint_auth_method) : ours("none"))
    );
  }
  // Client metadata is an OAuth dynamic registration document (RFC 7591), so other members are normal.
  // That includes `extensions`, which 0.4 moved to the Poppy-Extensions header (3.4).
  return facts;
}

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
/** What Companies MUST (ES256) and SHOULD (PS384) accept for client assertions and delegations (4.1, 5.2). RS256 can't sign a delegation, so it's left out. */
const KEY_ALGS = ["ES256", "PS384"];

/** JOSE key members use unpadded base64url, with no alternative spelling of their bytes. */
function keyBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return;
  const bytes = fromBase64url(value);
  return base64url(bytes) === value ? bytes : undefined;
}

const P256_FIELD = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
function coordinate(bytes: Uint8Array): bigint {
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

/** RFC 7518 6.2.1: both coordinates identify a point on the named curve. */
function p256Point(xBytes: Uint8Array, yBytes: Uint8Array): boolean {
  const x = coordinate(xBytes), y = coordinate(yBytes);
  return x < P256_FIELD && y < P256_FIELD
    && (y * y - x * x * x + 3n * x - P256_B) % P256_FIELD === 0n;
}

/** Base64urlUInt omits leading zero octets (RFC 7518 2). RSA n and e are positive and odd. */
function rsaInteger(value: unknown): Uint8Array | undefined {
  const bytes = keyBytes(value);
  return bytes && bytes[0] !== 0 && (bytes.at(-1)! & 1) === 1 ? bytes : undefined;
}

export function checkJwks(c: Checker, doc: unknown): void {
  const ref = spec("4.1", "agent-identity");
  if (!isObject(doc)) {
    c.report("wrong-type", "", departure(ours("the key set"), ours("a JSON object with keys"), show.kind(doc)), ref);
    return;
  }
  const keys = member<unknown[]>(c, doc, "", "keys", "array", true, rfc(7517, "5"));
  if (!keys) return;
  if (keys.length === 0) c.report("jwks-empty", "/keys", departure(ours("keys"), ours("at least one key"), ours("none")));
  const kids = new Set<string>();
  keys.forEach((key, index) => {
    const at = `/keys/${index}`;
    if (!isObject(key)) {
      c.report("wrong-type", at, departure(subject(at), ours("a JWK object"), show.kind(key)), rfc(7517, "4"));
      return;
    }
    const leaked = PRIVATE_MEMBERS.filter((name) => name in key);
    const name = shown`key ${index}`;
    // Never a private member's value: their names are enough.
    if (leaked.length > 0) c.report("jwks-private-key", at, departure(shown`${name}'s members`, ours("public members only"), shown`private ones too: ${show.list(leaked.map((member) => show.code(member)))}`));
    if (key.kty === "EC") {
      if (key.crv !== "P-256") c.report("jwks-key-type", at, departure(shown`${name}'s curve`, ours("P-256 (ES256)"), show.value(key.crv)));
      else {
        const x = keyBytes(key.x), y = keyBytes(key.y);
        const length = (bytes: Uint8Array | undefined) => (bytes ? shown`${bytes.length} bytes` : ours("no unpadded base64url value"));
        if (x?.length !== 32) c.report("jwks-key-material", `${at}/x`, departure(shown`${name}'s x coordinate`, ours("exactly 32 bytes, as unpadded base64url"), length(x)), rfc(7518, "6.2.1.2"));
        if (y?.length !== 32) c.report("jwks-key-material", `${at}/y`, departure(shown`${name}'s y coordinate`, ours("exactly 32 bytes, as unpadded base64url"), length(y)), rfc(7518, "6.2.1.3"));
        if (x?.length === 32 && y?.length === 32 && !p256Point(x, y)) c.report("jwks-key-material", at, departure(shown`${name}'s coordinates`, ours("a point on P-256"), ours("coordinates off the curve")), rfc(7518, "6.2.1"));
      }
    } else if (key.kty === "RSA") {
      const n = rsaInteger(key.n), e = rsaInteger(key.e);
      if (!n) c.report("jwks-key-material", `${at}/n`, departure(shown`${name}'s modulus`, ours("a positive odd integer, as Base64urlUInt without leading zero bytes"), ours("something else")), rfc(7518, "6.3.1.1"));
      else {
        const bits = (n.length - 1) * 8 + 32 - Math.clz32(n[0]!);
        if (bits < 2048) c.report("jwks-rsa-small", at, departure(shown`${name}'s modulus`, ours("at least 2048 bits"), shown`${bits} bits`));
      }
      if (!e || (e.length === 1 && e[0]! < 3)) c.report("jwks-key-material", `${at}/e`, departure(shown`${name}'s exponent`, ours("an odd integer of at least 3, as Base64urlUInt without leading zero bytes"), ours("something else")), rfc(7518, "6.3.1.2"));
    } else {
      c.report("jwks-key-type", at, departure(shown`${name}'s kty`, ours("EC (P-256) or RSA"), show.value(key.kty)));
    }
    if ("alg" in key && (typeof key.alg !== "string" || !KEY_ALGS.includes(key.alg))) c.report("jwks-alg", `${at}/alg`, departure(shown`${name}'s alg`, ours("ES256 or PS384"), show.value(key.alg)));
    if ((key.alg === "ES256" && (key.kty !== "EC" || key.crv !== "P-256")) || (key.alg === "PS384" && key.kty !== "RSA")) {
      c.report("jwks-key-material", `${at}/alg`, departure(shown`${name}'s alg`, key.alg === "ES256" ? ours("ES256 with an EC key on P-256") : ours("PS384 with an RSA key"), shown`${show.value(key.alg)} with kty ${show.value(key.kty)}`), rfc(7518, key.alg === "ES256" ? "3.4" : "3.5"));
    }
    if ("use" in key && key.use !== "sig") c.report("jwks-use", `${at}/use`, departure(shown`${name}'s use`, ours('"sig", or no use'), show.value(key.use)));
    if (typeof key.kid !== "string" || key.kid === "") c.report("jwks-no-kid", at, departure(shown`${name}'s kid`, ours("a key ID"), "kid" in key ? show.value(key.kid) : ours("none")));
    else {
      if (kids.has(key.kid)) c.report("jwks-kid-duplicate", `${at}/kid`, departure(ours("the keys' kids"), ours("each kid once"), shown`${show.value(key.kid)} twice`));
      kids.add(key.kid);
    }
  });
}

export const draft04: Profile = {
  version: "0.4",
  name: "Draft 0.4",
  poppy: checkPoppy,
  protectedResource: checkProtectedResource,
  noIssuer,
  oauthMetadata: checkOAuthMetadata,
  clientMetadata: checkClientMetadata,
  jwks: checkJwks
};
