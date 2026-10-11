import { describe, expect, it } from "vitest";
import { discover, DiscoveryError, isCompany, protocolEndpoint, tokenHostAllowed, type Company } from "../../src/poppy/discovery";
import { validateCompany, validateText } from "../../src/validator/validate";
import { companies, hosts, serving, type GeneratedCompany } from "./companies";
import { gs, jsonValues, propertyAsync, property, type Json } from "./hegel";

/**
 * Discovery (spec 3) and the validator that gates it. Accept: any Company
 * the draft calls valid is discovered, as its documents say. Reject: each
 * broken MUST refuses it. And no document, however broken, makes either
 * throw anything but a DiscoveryError.
 */

async function discovered(company: GeneratedCompany): Promise<Company> {
  const { result } = await discover(serving(company).fetcher, company.requested);
  if (!isCompany(result)) throw new Error("discovered as website only");
  return result;
}

/** discover's answer, or the DiscoveryError it threw; anything else is rethrown, failing the property. */
async function outcome(company: { readonly requested: string; readonly domain: string; readonly poppy: unknown; readonly metadata: unknown }) {
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
    "discovers it, keyed by its issuer, with the endpoints, sign-in types, APIs and extensions it lists",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const found = await discovered(company);
      const { poppy, metadata } = company;
      expect(found.issuer).toBe(poppy.auth.issuer);
      expect(found.domain).toBe(company.domain.toLowerCase().replace(/^www\./, ""));
      expect(Object.keys(found.signIn).sort()).toEqual(Object.keys(poppy.auth).filter((key) => ["direct", "device", "mediated"].includes(key)).sort());
      expect(found.endpoints.token).toBe(metadata.token_endpoint);
      expect(found.endpoints.revocation).toBe(metadata.revocation_endpoint);
      expect(found.endpoints.authorization).toBe(poppy.auth.direct ? metadata.authorization_endpoint : undefined);
      expect(found.endpoints.deviceAuthorization).toBe(poppy.auth.device ? metadata.device_authorization_endpoint : undefined);
      expect(found.apis.map((api) => [api.type, api.url])).toEqual(
        (poppy.apis ?? []).filter((api: { type: string }) => api.type === "openapi" || api.type === "mcp").map((api: { type: string; url: string }) => [api.type, api.url])
      );
      expect(found.conversations?.endpoint).toBe(poppy.agent?.protocols.find((entry: { type: string }) => entry.type === "poppy").endpoint);
      expect(found.extensions.operations?.endpoint).toBe(poppy.extensions?.operations.endpoint);
    })
  );

  it(
    "lets every host poppy.json lists for a service that takes a Session Token have one (N10)",
    propertyAsync(async (tc) => {
      const found = await discovered(tc.draw(companies));
      const services = [found.conversations?.endpoint, found.extensions.operations?.endpoint, found.signIn.mediated?.endpoint, ...found.apis.map((api) => api.url)];
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
        found.signIn.mediated?.endpoint,
        found.conversations?.endpoint,
        found.extensions.operations?.endpoint,
        found.web?.browserSessionEndpoint
      ];
      for (const endpoint of poppyEndpoints.filter((value): value is string => !!value)) {
        const suffix = tc.draw(gs.fromRegex("(/[A-Za-z0-9_-]{1,8}){0,3}", { fullmatch: true }));
        expect(protocolEndpoint(found, new URL(`${endpoint}${suffix}`)), `${endpoint}${suffix}`).toBe(endpoint);
      }
    })
  );
});

type Documents = { readonly requested: string; readonly domain: string; readonly poppy: unknown; readonly metadata: unknown };

/** The validator's errors for a Company's documents, by id: why discovery refuses it. */
async function errors(company: Documents): Promise<string[]> {
  const report = await validateCompany(serving(company).fetcher, company.requested);
  return report.messages.filter((message) => message.severity === "error").map((message) => message.id);
}

describe("discovery refuses a Company whose documents break a MUST (3.1, 3.2)", () => {
  it(
    "refuses a protocol_version whose major isn't 0",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const major = tc.draw(gs.integers({ minValue: 1, maxValue: Number.MAX_SAFE_INTEGER }));
      const minor = tc.draw(gs.integers({ minValue: 0, maxValue: Number.MAX_SAFE_INTEGER }));
      const changed = { ...company, poppy: { ...company.poppy, protocol_version: `${major}.${minor}` } };
      expect((await outcome(changed)).ok).toBe(false);
      expect(await errors(changed)).toEqual(["version-unsupported-major"]);
    })
  );

  it(
    "refuses an organization.domain that isn't the requested host",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const other = tc.draw(hosts);
      tc.assume(other.toLowerCase().replace(/^www\./, "") !== company.domain.toLowerCase().replace(/^www\./, ""));
      const changed = { ...company, poppy: { ...company.poppy, organization: { ...company.poppy.organization, domain: other } } };
      expect((await outcome(changed)).ok).toBe(false);
      // poppy_domains may now leave the new domain out too.
      expect(await errors(changed)).toContain("organization-domain-mismatch");
    })
  );

  it(
    "refuses metadata whose issuer isn't exactly auth.issuer",
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
    "refuses metadata whose poppy_domains leaves out organization.domain",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const others = tc.draw(gs.arrays(hosts, { maxSize: 3 })).filter((domain) => domain.toLowerCase() !== company.domain.toLowerCase());
      const changed = { ...company, metadata: { ...company.metadata, poppy_domains: others } };
      expect((await outcome(changed)).ok).toBe(false);
      expect(await errors(changed)).toEqual(["metadata-domain-missing"]);
    })
  );

  it(
    "refuses a Company any of whose endpoints isn't HTTPS, naming that endpoint",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      const fields = urlFields(company);
      const { document, path } = fields[tc.draw(gs.integers({ minValue: 0, maxValue: fields.length - 1 }))]!;
      const scheme = tc.draw(gs.sampledFrom(["http", "ftp", "ws", "wss", "file"]));
      const insecure = (url: string) => url.replace(/^https:/, `${scheme}:`);
      let changed: { poppy: unknown; metadata: unknown } = { poppy: company.poppy, metadata: company.metadata };
      changed = { ...changed, [document]: replaced(changed[document], path, insecure(lookup(company[document], path))) };
      // The issuer is in both documents, which must agree; it changes in both.
      if (document === "poppy" && path.join("/") === "auth/issuer") changed.metadata = { ...company.metadata, issuer: insecure(company.metadata.issuer) };
      tc.note(`${document} /${path.join("/")} as ${scheme}`);
      const result = await outcome({ ...company, ...changed });
      expect(result.ok).toBe(false);
      const report = await validateCompany(serving({ ...company, ...changed }).fetcher, company.requested);
      expect(report.messages.filter((message) => message.id === "not-https-url").map((message) => [message.document, message.pointer])).toEqual([
        [document === "poppy" ? "poppy" : "oauth-metadata", `/${path.join("/")}`]
      ]);
    })
  );
});

/**
 * Every member of a generated Company's documents that is a URL the client
 * fetches or sends to, and so must be HTTPS: the issuer, sign-in, conversation,
 * API, browser-session and extension endpoints in poppy.json, and the
 * endpoints in the issuer's metadata.
 */
function urlFields(company: GeneratedCompany): { document: "poppy" | "metadata"; path: (string | number)[] }[] {
  const { poppy, metadata } = company;
  const fields: { document: "poppy" | "metadata"; path: (string | number)[] }[] = [{ document: "poppy", path: ["auth", "issuer"] }];
  if (poppy.auth.mediated) fields.push({ document: "poppy", path: ["auth", "mediated", "endpoint"] });
  (poppy.agent?.protocols ?? []).forEach((_: unknown, index: number) => fields.push({ document: "poppy", path: ["agent", "protocols", index, "endpoint"] }));
  (poppy.apis ?? []).forEach((_: unknown, index: number) => fields.push({ document: "poppy", path: ["apis", index, "url"] }));
  if (poppy.web?.browser_session_endpoint) fields.push({ document: "poppy", path: ["web", "browser_session_endpoint"] });
  for (const name of Object.keys(poppy.extensions ?? {})) fields.push({ document: "poppy", path: ["extensions", name, "endpoint"] });
  for (const key of ["token_endpoint", "revocation_endpoint", "authorization_endpoint", "device_authorization_endpoint"]) {
    if (key in metadata) fields.push({ document: "metadata", path: [key] });
  }
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
      const which = tc.draw(gs.sampledFrom(["poppy", "metadata"] as const));
      const targets = paths(company[which]);
      const path = targets[tc.draw(gs.integers({ minValue: 0, maxValue: targets.length - 1 }))]!;
      const next = tc.draw(gs.optional(jsonValues(3)));
      await outcome({ ...company, [which]: replaced(company[which], path, next ?? undefined) });
    })
  );

  it(
    "discover throws only DiscoveryError, whatever JSON either document is",
    propertyAsync(async (tc) => {
      const company = tc.draw(companies);
      await outcome({ ...company, poppy: tc.draw(gs.oneOf<Json>(jsonValues(), gs.just(company.poppy))), metadata: tc.draw(jsonValues()) });
    })
  );

  for (const kind of ["poppy", "oauth-metadata", "client-metadata", "jwks"] as const) {
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
