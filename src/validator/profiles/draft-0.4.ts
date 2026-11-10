/**
 * Rules for the 0.4 draft (spec/draft-0.4-retrieved-2026-11-10), beside
 * 0.3's. What changed in discovery: `extensions` lists an entry for each
 * major version (3.3); `supported_versions` links the documents for other
 * versions (3.4, read by validate.ts for any version); `web.disabled` and
 * `web.unscoped` (6); `tasks.endpoint` replaces `feedback`,
 * `excluded_tasks` and `skill_index` (9); Operations is version 3, whose
 * entry may name an `endpoint` for website operations; Browser Control is
 * new; and a Company that offers sign-in SHOULD offer Direct Sign-In (4).
 * The rest is 0.3's, reused from its profile.
 */
import { pointer } from "../json.ts";
import { extension04, spec04 } from "../messages.ts";
import { httpsMember, isHostname, isObject, member, unknownMembers, type Checker, type Obj, type UrlRules } from "../primitives.ts";
import {
  checkAgent,
  checkApis,
  checkAuth,
  checkClientMetadata,
  checkJwks,
  checkMediatedFields,
  checkOAuthMetadata,
  checkOrganization,
  checkProtectedResource,
  checkScopes,
  noIssuer
} from "./draft-0.3.ts";
import type { PoppyFacts, Profile } from "./profile.ts";

const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
const BROWSER_SIGN_IN = "poppy:browser-sign-in";
/** Extensions defined with the protocol at 0.4, and the versions this validator knows. */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  operations: ["3"],
  "mediated-sign-in": ["1"],
  links: ["1"],
  disclosures: ["1"],
  ucp: ["1"],
  "browser-control": ["1"]
};
/** URLs no rule keeps free of a fragment (spec-issues N9): we do, as a reading. */
const OURS: UrlRules = { fragment: "unstated" };

/** `web` (3.1, 6): the browser-session endpoint, `disabled` and `unscoped`. */
export function checkWeb(c: Checker, web: Obj): { browserSession: boolean; disabled: boolean; unscoped: boolean } {
  const ref = spec04("6", "web-browsing");
  const endpoint = httpsMember(c, web, "/web", "browser_session_endpoint", false, ref, OURS);
  const disabled = member<boolean>(c, web, "/web", "disabled", "boolean", false, spec04("3.1", "fields")) === true;
  const unscoped = member<boolean>(c, web, "/web", "unscoped", "boolean", false, spec04("3.1", "fields")) === true;
  unknownMembers(c, web, "/web", ["browser_session_endpoint", "disabled", "unscoped"]);
  return { browserSession: endpoint !== undefined || "browser_session_endpoint" in web, disabled, unscoped };
}

type Extensions = { mediated?: readonly string[]; operationsEndpoint?: boolean; browserControl?: boolean };

/** `extensions` (3.3): each a list of version entries. Returns what discovery needs from the ones it knows. */
export function checkExtensions(c: Checker, extensions: Obj): Extensions {
  const found: Extensions = {};
  const ref = spec04("3.3", "extensions");
  for (const [name, entries] of Object.entries(extensions)) {
    const at = pointer("/extensions", name);
    const slash = name.indexOf("/");
    if (slash === -1) {
      if (!(name in EXTENSIONS)) c.report("extension-plain-unknown", at, `${name} has a plain name, but the protocol defines no such extension.`);
    } else if (!isHostname(name.slice(0, slash)) || slash === name.length - 1) {
      c.report("extension-name", at, `${JSON.stringify(name)} must start with a domain, such as example.com/gift-wrap.`);
    }
    if (!Array.isArray(entries)) {
      c.report("extension-entries", at, `The ${name} extension must be a list of version entries, such as [{ "version": "1" }], not ${isObject(entries) ? "a single object, as in 0.3" : JSON.stringify(entries)}.`);
      continue;
    }
    entries.forEach((entry, index) => {
      const entryAt = `${at}/${index}`;
      if (!isObject(entry)) {
        c.report("wrong-type", entryAt, `Each entry of the ${name} extension must be an object with a version.`, ref);
        return;
      }
      if (typeof entry.version === "number") {
        c.report("extension-version-number", `${entryAt}/version`, `The ${name} extension's version is the number ${entry.version}; write it as a string, such as "${entry.version}".`);
        return;
      }
      const version = member<string>(c, entry, entryAt, "version", "string", true, ref);
      if (version === undefined) return;
      const known = EXTENSIONS[name];
      if (!known) return;
      if (!known.includes(version)) {
        c.report("extension-version-unknown", `${entryAt}/version`, `${name} version ${version} isn't one this validator knows (${known.join(", ")}).`);
        return;
      }
      if (name === "operations") {
        const endpoint = httpsMember(c, entry, entryAt, "endpoint", false, extension04("operations", "Operations", "2", "support"), OURS);
        if (endpoint !== undefined || "endpoint" in entry) found.operationsEndpoint = true;
        unknownMembers(c, entry, entryAt, ["version", "endpoint"]);
      } else if (name === "mediated-sign-in") {
        const scopes = member<unknown[]>(c, entry, entryAt, "scopes", "array", true, extension04("mediated-sign-in", "Mediated Sign-In", "2", "support"));
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

export function checkPoppy(c: Checker, doc: unknown, context: { requestedDomain?: string }): PoppyFacts {
  const facts: PoppyFacts = { signIn: { direct: false, device: false, mediated: false } };
  if (!isObject(doc)) {
    c.report("wrong-type", "", "poppy.json must be a JSON object.", spec04("3.1", "fields"));
    return facts;
  }
  facts.domain = checkOrganization(c, doc);
  if (facts.domain && context.requestedDomain && facts.domain.toLowerCase() !== context.requestedDomain.toLowerCase()) {
    c.report("organization-domain-mismatch", "/organization/domain", `organization.domain is ${facts.domain}, but the document was served by ${context.requestedDomain}.`);
  }
  const agent = member<Obj>(c, doc, "", "agent", "object", false);
  const apis = member<unknown[]>(c, doc, "", "apis", "array", false);
  const web = member<Obj>(c, doc, "", "web", "object", false);
  const signedInAccess = agent ? checkAgent(c, agent) : false;
  if (apis) checkApis(c, apis);
  const checkedWeb = web ? checkWeb(c, web) : { browserSession: false, disabled: false, unscoped: false };
  if (!("agent" in doc) && !("apis" in doc) && !("web" in doc)) c.report("nothing-offered", "", "poppy.json has none of agent, apis or web.");
  if (checkedWeb.browserSession) facts.browserSession = true;
  if (checkedWeb.unscoped && !checkedWeb.browserSession) c.report("web-unscoped-without-join", "/web/unscoped", "web.unscoped is true, but web.browser_session_endpoint isn't listed.");
  if (checkedWeb.disabled) {
    if (checkedWeb.browserSession) c.report("web-disabled-browser-session", "/web/browser_session_endpoint", "web.disabled is true, so web.browser_session_endpoint must not be listed.");
    if (!("agent" in doc) && !("apis" in doc)) c.report("web-disabled-no-alternative", "/web/disabled", "web.disabled is true, but poppy.json lists neither agent nor apis for agents to use instead.");
  }
  const tasks = member<Obj>(c, doc, "", "tasks", "object", false, spec04("9", "task-coverage"));
  if (tasks) {
    httpsMember(c, tasks, "/tasks", "endpoint", true, spec04("9", "task-coverage"), OURS);
    unknownMembers(c, tasks, "/tasks", ["endpoint"]);
  }
  for (const moved of ["feedback", "excluded_tasks", "skill_index"]) {
    if (moved in doc) c.report("member-moved-to-tasks", `/${moved}`, `${moved} is 0.3's; 0.4 agents read it from the response at tasks.endpoint, and ignore it here.`);
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
    c.report("operations-endpoint-without-join", "/extensions/operations", "The operations entry lists an endpoint for website operations, but web.browser_session_endpoint isn't listed.");
  }
  if (found.browserControl && !checkedWeb.browserSession) {
    c.report("browser-control-without-join", "/extensions/browser-control", "browser-control is listed, but web.browser_session_endpoint isn't.");
  }
  // 3.2: these use Sessions, so the Company's identifier matters: its issuer, or its domain when it has none.
  facts.usesSessions = !!(agent || apis || tasks || checkedWeb.browserSession || found.mediated || (extensions && Object.keys(extensions).length > 0));
  const needsIssuer = [
    ...(checkedAuth?.issuer ? ["auth.issuer"] : []),
    ...(found.mediated ? ["the Mediated Sign-In extension"] : []),
    ...(signedInAccess ? ["signed_in access"] : [])
  ];
  if (needsIssuer.length) facts.needsIssuer = needsIssuer;
  if (checkedAuth?.disabled) {
    if (found.mediated) c.report("auth-disabled-sign-in", "/extensions/mediated-sign-in", "auth.disabled is true, but poppy.json lists the Mediated Sign-In extension.");
    if (signedInAccess) c.report("auth-disabled-sign-in", "/agent/protocols", "auth.disabled is true, but a poppy conversation entry declares signed_in access.");
  }
  if (!facts.usesSessions && !auth) c.report("website-only", "", "Nothing here uses Sessions: agents can only browse this Company's website, signed out.");
  unknownMembers(c, doc, "", ["protocol_version", "supported_versions", "organization", "auth", "agent", "apis", "web", "tasks", "extensions", "feedback", "excluded_tasks", "skill_index"]);
  return facts;
}

/** The issuer's metadata: 0.3's rules, `poppy:browser-sign-in` with browser join (6), and Direct Sign-In preferred (4). */
export function checkOAuthMetadata04(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void {
  checkOAuthMetadata(c, doc, poppy);
  if (!isObject(doc) || poppy?.disabled) return;
  if (poppy?.browserSession && Array.isArray(doc.scopes_supported) && !doc.scopes_supported.includes(BROWSER_SIGN_IN)) {
    c.report("browser-sign-in-unsupported", "/scopes_supported", `poppy.json lists web.browser_session_endpoint, but scopes_supported doesn't include ${BROWSER_SIGN_IN}.`);
  }
  if (!Array.isArray(doc.grant_types_supported)) return;
  const grants = doc.grant_types_supported;
  if (grants.includes(DEVICE_CODE) && !grants.includes("authorization_code")) {
    c.report("direct-sign-in-preferred", "/grant_types_supported", "The issuer offers Device Sign-In but not Direct Sign-In, the preferred type.");
  }
}

export const draft04: Profile = {
  version: "0.4",
  name: "Draft 0.4",
  poppy: checkPoppy,
  protectedResource: checkProtectedResource,
  noIssuer,
  oauthMetadata: checkOAuthMetadata04,
  // 0.4 client metadata lists no extensions; they go in Poppy-Extensions (3.4). 0.3's check reads the member only when present.
  clientMetadata: checkClientMetadata,
  jwks: checkJwks
};
