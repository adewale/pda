import { describe, expect, it } from "vitest";
import { discover, DiscoveryError, isCompany, protocolEndpoint, tokenHostAllowed, type Company } from "../../src/poppy/discovery";
import { validateCompany, validateText } from "../../src/validator/validate";
import { companies, DEVICE_GRANT, hosts, MEDIATED_GRANT, serving, type Documents, type GeneratedCompany } from "./companies";
import { gs, jsonValues, propertyAsync, property, type Json } from "./hegel";

/**
 * Discovery (spec 3) and the validator that gates it. Accept: any Company
 * draft 0.3 calls valid is discovered, as its documents say. Reject: each
 * broken MUST refuses it. And no document, however broken, makes either
 * throw anything but a DiscoveryError.
 */

async function discovered(company: GeneratedCompany): Promise<Company> {
  const { result } = await discover(serving(company).fetcher, company.requested);
  if (!isCompany(result)) throw new Error("discovered as website only");
  return result;
}

/** discover's answer, or the DiscoveryError it threw; anything else is rethrown, failing the property. */
async function outcome(company: Documents) {
  try {
    return { ok: true as const, result: (await discover(serving(company).fetcher, company.requested)).result };
  } catch (error) {
    if (error instanceof DiscoveryError) return { ok: false as const, error };
    throw error;
  }
}

describe("discovery accepts every valid Company, as its documents say (3)", () => {
  it(
    "the validator calls a generated Company's poppy.json valid",
    property((tc) => {
      const company = tc.draw(companies);
      const report = validateText("poppy", JSON.stringify(company.poppy), { domain: company.requested });
      expect(report.messages.filter((message) => message.severity === "error")).toEqual([]);
    })
  );

  it(
    "the validator calls a generated Company's three documents valid, and our client refuses nothing in them",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const report = await validateCompany(serving(company).fetcher, company.requested);
      expect(report.messages.filter((message) => message.severity === "error" || message.refuses)).toEqual([]);
      expect(report.issuer).toBe(company.issuer);
    })
  );

  it(
    "discovers it, keyed by the issuer its domain names, with the endpoints, sign-in types, APIs and extensions its documents list",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const found = await discovered(company);
      const { poppy, metadata } = company;
      const grants: string[] = metadata.grant_types_supported;
      expect(found.issuer).toBe(company.issuer);
      expect(found.domain).toBe(company.domain.toLowerCase());
      // The sign-in types the issuer's grant_types_supported says (3.2), Mediated Sign-In with its extension (Mediated Sign-In 2).
      const types = [
        ...(grants.includes("authorization_code") ? ["direct"] : []),
        ...(grants.includes(DEVICE_GRANT) ? ["device"] : []),
        ...(grants.includes(MEDIATED_GRANT) && poppy.extensions?.["mediated-sign-in"] ? ["mediated"] : [])
      ];
      expect(Object.keys(found.signIn).sort()).toEqual(types.sort());
      expect(found.signIn.direct?.scopes ?? metadata.scopes_supported).toEqual(metadata.scopes_supported);
      expect(found.signIn.device?.scopes ?? metadata.scopes_supported).toEqual(metadata.scopes_supported);
      expect(found.signIn.mediated?.scopes).toEqual(poppy.extensions?.["mediated-sign-in"]?.scopes);
      // Mediated Sign-In's credentials go to the token endpoint and nowhere else (Mediated Sign-In 3).
      expect(found.signIn.mediated?.endpoint).toBe(found.signIn.mediated ? metadata.token_endpoint : undefined);
      expect(found.endpoints.token).toBe(metadata.token_endpoint);
      expect(found.endpoints.revocation).toBe(metadata.revocation_endpoint);
      expect(found.endpoints.authorization).toBe(found.signIn.direct ? metadata.authorization_endpoint : undefined);
      expect(found.endpoints.deviceAuthorization).toBe(found.signIn.device ? metadata.device_authorization_endpoint : undefined);
      expect(found.dpop).toBe("dpop_signing_alg_values_supported" in metadata);
      expect(found.apis.map((api) => [api.type, api.url])).toEqual(
        (poppy.apis ?? []).filter((api: { type: string }) => api.type === "openapi" || api.type === "mcp").map((api: { type: string; url: string }) => [api.type, api.url])
      );
      expect(found.conversations?.endpoint).toBe(poppy.agent?.protocols.find((entry: { type: string }) => entry.type === "poppy").endpoint);
      expect(found.web?.browserSessionEndpoint).toBe(poppy.web?.browser_session_endpoint);
      expect(found.feedback?.endpoint).toBe(poppy.feedback?.endpoint);
      expect(found.excludedTasks?.url).toBe(poppy.excluded_tasks?.url);
      expect(found.extensions.operations).toBe(poppy.extensions?.operations ? true : undefined);
      expect(found.customScopes).toEqual(poppy.auth.scopes);
    })
  );

  it(
    "lets every host poppy.json lists for a service that takes the Session header and access tokens have them (N10)",
    propertyAsync(async (tc) => {
      const found = await discovered(tc.draw(companies));
      const services = [found.conversations?.endpoint, found.feedback?.endpoint, found.web?.browserSessionEndpoint, ...found.apis.map((api) => api.url)];
      for (const service of services.filter((value): value is string => !!value)) {
        expect(tokenHostAllowed(found, new URL(service)), service).toBe(true);
      }
    })
  );

  it(
    "keeps a model's API call from every Poppy endpoint a discovered Company has, and anything under one",
    propertyAsync(async (tc) => {
      const found = await discovered(tc.draw(companies));
      const poppyEndpoints = [
        found.endpoints.token,
        found.endpoints.revocation,
        found.endpoints.authorization,
        found.endpoints.deviceAuthorization,
        found.conversations?.endpoint,
        found.web?.browserSessionEndpoint,
        found.feedback?.endpoint
      ];
      for (const endpoint of poppyEndpoints.filter((value): value is string => !!value)) {
        const suffix = tc.draw(gs.fromRegex("(/[A-Za-z0-9_-]{1,8}){0,3}", { fullmatch: true }));
        expect(protocolEndpoint(found, new URL(`${endpoint}${suffix}`)), `${endpoint}${suffix}`).toBe(endpoint);
      }
    })
  );
});

/** The validator's errors for a Company's documents, by id: why discovery refuses it. */
async function errors(company: Documents): Promise<string[]> {
  const report = await validateCompany(serving(company).fetcher, company.requested);
  return report.messages.filter((message) => message.severity === "error").map((message) => message.id);
}

describe("discovery refuses a Company whose documents break a MUST (3, 3.1, 3.2)", () => {
  it(
    "refuses any protocol_version but 0.3 (3.1: before 1.0, every major.minor can break compatibility)",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const major = tc.draw(gs.integers({ minValue: 0, maxValue: Number.MAX_SAFE_INTEGER }));
      const minor = tc.draw(gs.integers({ minValue: 0, maxValue: Number.MAX_SAFE_INTEGER }));
      tc.assume(`${major}.${minor}` !== "0.3");
      const changed = { ...company, poppy: { ...company.poppy, protocol_version: `${major}.${minor}` } };
      expect((await outcome(changed)).ok).toBe(false);
      expect(await errors(changed)).toEqual([major === 0 ? "version-unsupported" : "version-unsupported-major"]);
    })
  );

  it(
    "refuses a blank display name, which the validator names (3.1)",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const name = tc.draw(gs.text({ alphabet: " \t", maxSize: 5 }));
      const unnamed = { ...company, poppy: { ...company.poppy, organization: { ...company.poppy.organization, name } } };
      expect((await outcome(unnamed)).ok).toBe(false);
      expect(await errors(unnamed)).toEqual(["organization-name-missing"]);
    })
  );

  it(
    "refuses an organization.domain that isn't the host that served the document",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      // Another host, or the same one with `www.` added or dropped, which is another host too (3.1), while it stays a DNS name.
      const toggled = company.domain.startsWith("www.") ? company.domain.slice(4) : `www.${company.domain}`;
      const other = tc.draw(toggled.length <= 253 ? gs.oneOf(hosts, gs.just(toggled)) : hosts);
      tc.assume(other.toLowerCase() !== company.domain.toLowerCase());
      const changed = { ...company, poppy: { ...company.poppy, organization: { ...company.poppy.organization, domain: other } } };
      expect((await outcome(changed)).ok).toBe(false);
      // The other domain's protected resource metadata isn't served, and the issuer's doesn't list it, so more may follow.
      expect(await errors(changed)).toContain("organization-domain-mismatch");
    })
  );

  it(
    "refuses protected resource metadata whose resource isn't exactly https://{organization.domain}",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const resource = tc.draw(gs.oneOf(gs.just(`https://${company.domain}/`), gs.just(`http://${company.domain}`), gs.just(`https://${company.domain}:443`), hosts.map((host) => `https://${host}`), gs.urls()));
      tc.assume(resource.toLowerCase() !== `https://${company.domain.toLowerCase()}`);
      const changed = { ...company, resource: { ...company.resource, resource } };
      expect((await outcome(changed)).ok).toBe(false);
      expect(await errors(changed)).toEqual(["prm-resource-mismatch"]);
    })
  );

  it(
    "refuses a domain whose protected resource metadata names several issuers without auth.issuer choosing one, or one that isn't listed",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const others = tc.draw(gs.arrays(hosts.map((host) => `https://${host}`), { minSize: 1, maxSize: 2 })).filter((server) => server !== company.issuer);
      tc.assume(others.length > 0);
      const ambiguous = tc.draw(gs.booleans());
      const { issuer: _chosen, ...auth } = company.poppy.auth;
      const changed = ambiguous
        ? { ...company, poppy: { ...company.poppy, auth }, resource: { ...company.resource, authorization_servers: [company.issuer, ...others] } }
        : { ...company, poppy: { ...company.poppy, auth: { ...auth, issuer: company.issuer } }, resource: { ...company.resource, authorization_servers: others } };
      expect((await outcome(changed)).ok).toBe(false);
      expect(await errors(changed)).toEqual([ambiguous ? "issuer-ambiguous" : "issuer-not-listed"]);
    })
  );

  it(
    "refuses metadata whose issuer isn't exactly the issuer the domain names",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const issuer: string = company.metadata.issuer;
      const variant = tc.draw(
        gs.oneOf(
          gs.just(issuer.endsWith("/") ? issuer.slice(0, -1) : `${issuer}/`),
          gs.just(issuer.replace("https://", "http://")),
          gs.just(issuer.toUpperCase()),
          gs.just(`${issuer}x`),
          gs.urls(),
          gs.text()
        )
      );
      tc.assume(variant !== issuer);
      const changed = { ...company, metadata: { ...company.metadata, issuer: variant } };
      expect((await outcome(changed)).ok).toBe(false);
      expect(await errors(changed)).toEqual(["metadata-issuer-mismatch"]);
    })
  );

  it(
    "refuses metadata whose protected_resources leaves out https://{organization.domain}",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const resources = tc.draw(
        gs.arrays(gs.oneOf(hosts.map((host) => `https://${host}`), gs.just(`https://${company.domain}/`), gs.just(`https://${company.domain}/mcp`), gs.just(`https://${company.domain}:8443`)), { maxSize: 3 })
      ).filter((entry) => entry.toLowerCase() !== `https://${company.domain.toLowerCase()}`);
      const changed = { ...company, metadata: { ...company.metadata, protected_resources: resources } };
      expect((await outcome(changed)).ok).toBe(false);
      expect(await errors(changed)).toEqual(["metadata-protected-resources"]);
    })
  );

  it(
    "refuses metadata whose grant_types_supported leaves out refresh_token",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const changed = { ...company, metadata: { ...company.metadata, grant_types_supported: company.metadata.grant_types_supported.filter((grant: string) => grant !== "refresh_token") } };
      expect((await outcome(changed)).ok).toBe(false);
      expect(await errors(changed)).toEqual(["metadata-refresh-grant"]);
    })
  );

  it(
    "refuses an issuer that isn't HTTPS, where the domain's protected resource metadata names it",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const scheme = tc.draw(gs.sampledFrom(["http", "ftp", "ws", "wss", "file"]));
      const issuer = company.issuer.replace(/^https:/, `${scheme}:`);
      // The issuer is in all three documents, which must agree; it changes in each.
      const changed = {
        ...company,
        poppy: { ...company.poppy, auth: { ...company.poppy.auth, ...("issuer" in company.poppy.auth ? { issuer } : {}) } },
        resource: { ...company.resource, authorization_servers: [issuer] },
        metadata: { ...company.metadata, issuer }
      };
      expect((await outcome(changed)).ok).toBe(false);
      const report = await validateCompany(serving(changed).fetcher, company.requested);
      expect(report.messages.filter((message) => message.id === "not-https-url").map((message) => [message.document, message.pointer])).toEqual([
        ...("issuer" in company.poppy.auth ? [["poppy", "/auth/issuer"]] : []),
        ["protected-resource", "/authorization_servers/0"]
      ]);
      expect(report.refused).toBe(true);
    })
  );

  it(
    "refuses a Company any of whose URLs isn't HTTPS, naming that URL",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const fields = urlFields(company);
      const { document, path } = fields[tc.draw(gs.integers({ minValue: 0, maxValue: fields.length - 1 }))]!;
      const scheme = tc.draw(gs.sampledFrom(["http", "ftp", "ws", "wss", "file"]));
      const insecure = (url: string) => url.replace(/^https:/, `${scheme}:`);
      const changed = { ...company, [document]: replaced(company[document], path, insecure(lookup(company[document], path))) };
      tc.note(`${document} /${path.join("/")} as ${scheme}`);
      expect((await outcome(changed)).ok).toBe(false);
      const report = await validateCompany(serving(changed).fetcher, company.requested);
      const insecureMessages = report.messages.filter((message) => message.id === "not-https-url");
      expect(insecureMessages.map((message) => [message.document, message.pointer])).toEqual([[DOCUMENT[document], `/${path.join("/")}`]]);
      expect(report.refused).toBe(true);
    })
  );
});

/** The validator's name for each generated document. */
const DOCUMENT = { poppy: "poppy", resource: "protected-resource", metadata: "oauth-metadata" } as const;

/**
 * Every member of a generated Company's documents that is a URL, and so must
 * be HTTPS (3), but the issuer, which is in all three and has its own
 * property: the conversation, API, browser-session, feedback and
 * excluded-tasks URLs in poppy.json, and the endpoints and other protected
 * resources in the issuer's metadata.
 */
function urlFields(company: GeneratedCompany): { document: "poppy" | "metadata"; path: (string | number)[] }[] {
  const { poppy, metadata } = company;
  const fields: { document: "poppy" | "metadata"; path: (string | number)[] }[] = [];
  (poppy.agent?.protocols ?? []).forEach((_: unknown, index: number) => fields.push({ document: "poppy", path: ["agent", "protocols", index, "endpoint"] }));
  (poppy.apis ?? []).forEach((_: unknown, index: number) => fields.push({ document: "poppy", path: ["apis", index, "url"] }));
  if (poppy.web?.browser_session_endpoint) fields.push({ document: "poppy", path: ["web", "browser_session_endpoint"] });
  if (poppy.feedback) fields.push({ document: "poppy", path: ["feedback", "endpoint"] });
  if (poppy.excluded_tasks) fields.push({ document: "poppy", path: ["excluded_tasks", "url"] });
  for (const key of ["token_endpoint", "revocation_endpoint", "authorization_endpoint", "device_authorization_endpoint"]) {
    if (key in metadata) fields.push({ document: "metadata", path: [key] });
  }
  // The domain's own entry is what protected_resources must include; any other is just a URL.
  (metadata.protected_resources as string[]).slice(1).forEach((_, index) => fields.push({ document: "metadata", path: ["protected_resources", index + 1] }));
  return fields;
}

function lookup(value: unknown, path: readonly (string | number)[]): string {
  return path.reduce<unknown>((at, key) => (at as Record<string | number, unknown>)[key], value) as string;
}

/** Every path to a member or element of a JSON value. */
function paths(value: unknown, at: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return [at, ...value.flatMap((item, index) => paths(item, [...at, index]))];
  if (typeof value === "object" && value !== null) return [at, ...Object.entries(value).flatMap(([key, item]) => paths(item, [...at, key]))];
  return [at];
}

/** `value` with the member at `path` replaced (or, with `undefined`, removed). */
function replaced(value: unknown, path: (string | number)[], next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = [...value];
    if (next === undefined && rest.length === 0) copy.splice(head as number, 1);
    else copy[head as number] = replaced(copy[head as number], rest, next);
    return copy;
  }
  const copy = { ...(value as Record<string, unknown>) };
  if (next === undefined && rest.length === 0) delete copy[head as string];
  else copy[head as string] = replaced(copy[head as string], rest, next);
  return copy;
}

describe("no document makes discovery or the validator throw", () => {
  it(
    "discover throws only DiscoveryError for a valid Company with any one member changed or removed",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const which = tc.draw(gs.sampledFrom(["poppy", "resource", "metadata"] as const));
      const targets = paths(company[which]);
      const path = targets[tc.draw(gs.integers({ minValue: 0, maxValue: targets.length - 1 }))]!;
      const next = tc.draw(gs.optional(jsonValues(3)));
      await outcome({ ...company, [which]: replaced(company[which], path, next ?? undefined) });
    })
  );

  it(
    "discover throws only DiscoveryError, whatever JSON any document is",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const any = (document: Json) => tc.draw(gs.oneOf<Json>(jsonValues(), gs.just(document)));
      await outcome({ ...company, poppy: any(company.poppy), resource: any(company.resource), metadata: tc.draw(jsonValues()) });
    })
  );

  for (const kind of ["poppy", "protected-resource", "oauth-metadata", "client-metadata", "jwks"] as const) {
    it(
      `the validator reports on any text as a ${kind} document without throwing`,
      property((tc) => {
        const text = tc.draw(gs.oneOf(gs.text(), jsonValues().map((value) => JSON.stringify(value))));
        const report = validateText(kind, text, { domain: tc.draw(hosts) });
        expect(["valid", "invalid"]).toContain(report.outcome);
        expect(report.counts.error > 0).toBe(report.outcome === "invalid");
      })
    );
  }
});

describe("what these properties found, as examples", () => {
  it.each([
    ["0", "not-a-url"],
    ["https://[", "not-a-url"],
    ["http://auth.shop.example", "not-https-url"],
    ["https://auth.shop.example/#fragment", "url-has-fragment"]
  ])("refuses an invalid protected-resource issuer without fetching its metadata: %s", async (issuer, messageId) => {
    // Hegel reduced a mutation of authorization_servers to ["0"]. The
    // validator reported the bad URL, then tried to build its metadata URL.
    const domain = "shop.example";
    const company = {
      requested: domain, domain,
      poppy: { protocol_version: "0.3", organization: { name: "Shop", domain }, web: { browser_session_endpoint: `https://${domain}/poppy/browser-session` } },
      resource: { resource: `https://${domain}`, authorization_servers: [issuer] },
      metadata: {}
    };
    const network = serving(company);
    const report = await validateCompany(network.fetcher, domain);
    expect(report.outcome).toBe("invalid");
    expect(report.refused).toBe(true);
    expect(report.issuer).toBeUndefined();
    expect(report.messages.filter((message) => message.severity === "error").map((message) => [message.id, message.document, message.pointer])).toEqual([
      [messageId, "protected-resource", "/authorization_servers/0"]
    ]);
    expect(network.requests).toEqual([`https://${domain}/.well-known/poppy.json`, `https://${domain}/.well-known/oauth-protected-resource`]);
    await expect(discover(serving(company).fetcher, domain)).rejects.toBeInstanceOf(DiscoveryError);
  });

  it("keeps the description of a scope named like a member every object inherits", async () => {
    const domain = "shop.example";
    const issuer = "https://auth.shop.example";
    // Parsed from text, as a Company's document is, so `__proto__` is a member, not the prototype.
    const poppy = JSON.parse(`{"protocol_version":"0.3","organization":{"name":"Shop","domain":"${domain}"},"auth":{"scopes":{"__proto__":"A scope by any name","constructor":"Another"}},"agent":{"protocols":[{"type":"poppy","endpoint":"https://api.${domain}/poppy/conversations"}]}}`);
    const company = {
      requested: domain,
      domain,
      poppy,
      resource: { resource: `https://${domain}`, authorization_servers: [issuer] },
      metadata: { issuer, token_endpoint: `${issuer}/token`, revocation_endpoint: `${issuer}/revoke`, grant_types_supported: ["refresh_token", "authorization_code"], authorization_endpoint: `${issuer}/authorize`, authorization_response_iss_parameter_supported: true, scopes_supported: ["__proto__", "constructor"], protected_resources: [`https://${domain}`] }
    };
    const found = await discover(serving(company).fetcher, domain);
    expect(isCompany(found.result) && Object.entries(found.result.customScopes)).toEqual([["__proto__", "A scope by any name"], ["constructor", "Another"]]);
  });
});
