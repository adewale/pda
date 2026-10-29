import { domainFromInput } from "../domain.ts";
import { protocolRevision } from "../poppy/protocol-version.ts";
/**
 * The validator's entry points. The same functions back the library, the
 * CLI, the HTTP endpoint and the form, and our own Poppy client uses
 * `validateCompany` to decide what it will ingest.
 */
import { fetchDocument, metadataUrl, type Fetched, type Fetcher } from "./fetch.ts";
import { parseJson } from "./json.ts";
import { MESSAGES } from "./messages.ts";
import { Checker, isHostname, isObject, type DocumentKind, type Message } from "./primitives.ts";
import { LATEST, PROFILES, profileForVersion } from "./profiles/index.ts";
import type { PoppyFacts, Profile } from "./profiles/profile.ts";

export const VALIDATOR = { name: "poppy-validator", version: "1.0.0" } as const;

/**
 * valid: no errors. invalid: an error, which is a MUST, an RFC's MUST or a
 * normative statement without a key word broken (docs/conformance-levels.md).
 * indeterminate: fetching failed or a resource allowance prevented checks.
 * Limits are implementation choices informed by the Guides.
 */
export type Outcome = "valid" | "invalid" | "indeterminate";

export type DocumentResult = {
  readonly kind: DocumentKind;
  readonly url?: string;
  readonly finalUrl?: string;
  readonly status?: number;
  readonly contentType?: string;
  readonly maxAgeSeconds?: number | null;
  /** The parsed document, when it parsed. */
  readonly value?: unknown;
};

/** A check that needs context the input didn't give, such as the URL a document came from. */
export type Skipped = { readonly check: string; readonly reason: string };

export type Report = {
  readonly outputVersion: 1;
  readonly validator: typeof VALIDATOR;
  readonly outcome: Outcome;
  /** The protocol version the documents were checked against, such as "Draft 0.3". */
  readonly checkedAgainst: string;
  readonly protocolVersion: string;
  readonly specificationRevision: string;
  readonly documents: readonly DocumentResult[];
  readonly counts: { readonly error: number; readonly warning: number; readonly info: number };
  /**
   * Whether our own client refuses these documents, or would if it read
   * them (it reads only a Company's): a message that `refuses` (every error
   * but those the draft tells a reader to tolerate, and the warnings that
   * guard against hostile documents), or a document that couldn't be
   * checked. Separate from `outcome`, which is about the draft.
   */
  readonly refused: boolean;
  readonly messages: readonly Message[];
  readonly skipped: readonly Skipped[];
};

/** Messages after which the document wasn't fetched or read, so nothing in it was checked. */
const UNREACHABLE = new Set(["http-failed", "http-status", "http-non-public-host", "http-non-public-address", "http-too-many-redirects", "http-redirect-not-allowed", "http-too-large", "json-resource-limit"]);

function report(profile: Profile, documents: DocumentResult[], checkers: Checker[], skipped: Skipped[]): Report {
  const messages = checkers.flatMap((c) => c.messages);
  const count = (severity: Message["severity"]) => messages.filter((m) => m.severity === severity).length;
  const unreachable = messages.some((m) => UNREACHABLE.has(m.id));
  const outcome: Outcome = unreachable
    ? "indeterminate"
    : count("error") > 0
      ? "invalid"
      : "valid";
  return {
    outputVersion: 1,
    validator: VALIDATOR,
    outcome,
    checkedAgainst: profile.name,
    protocolVersion: profile.version,
    specificationRevision: protocolRevision(profile.version)!, // Profiles only contain supported versions.
    documents,
    counts: { error: count("error"), warning: count("warning"), info: count("info") },
    refused: unreachable || messages.some((m) => m.refuses),
    messages,
    skipped
  };
}

/** Parse text into the checker's document; undefined if parsing is refused. */
function parse(c: Checker, text: string): unknown {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    const id = parsed.resourceLimit ? "json-resource-limit" : "json-syntax";
    const definition = MESSAGES[id];
    c.messages.push({
      id,
      basis: definition.basis,
      severity: definition.severity,
      refuses: definition.refuses,
      document: c.document,
      pointer: "",
      line: parsed.position.line,
      column: parsed.position.column,
      text: `${parsed.error}.`,
      ref: definition.ref
    });
    return undefined;
  }
  c.usePositions(parsed.positions);
  if (parsed.bom) c.report("json-bom", "", "The document starts with a byte order mark.");
  for (const duplicate of parsed.duplicates) {
    c.report("json-duplicate-member", duplicate.pointer, `${JSON.stringify(duplicate.name)} appears twice in the same object.`, undefined, duplicate.position);
  }
  return parsed.value;
}

/**
 * The profile for a poppy.json's `protocol_version`, or undefined when its
 * wire version is unsupported (then nothing else is checked: the rules differ).
 */
function profileFor(c: Checker, doc: unknown): Profile | undefined {
  if (!isObject(doc) || !("protocol_version" in doc)) {
    if (isObject(doc)) c.report("missing-member", "/protocol_version", 'protocol_version is required, such as "0.3".');
    return LATEST;
  }
  const version = doc.protocol_version;
  const match = typeof version === "string" ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version) : null;
  if (!match) {
    c.report("version-format", "/protocol_version", `protocol_version must be major.minor, like "0.3", not ${JSON.stringify(version)}.`);
    return LATEST;
  }
  const profile = profileForVersion(version as string);
  if (!profile) {
    const known = PROFILES.map((p) => p.version).join(", ");
    c.report(Number(match[1]) === 0 ? "version-unsupported" : "version-unsupported-major", "/protocol_version", `poppy.json is protocol version ${version}; this validator supports ${known}.`);
    return undefined;
  }
  return profile;
}

function documentResult(kind: DocumentKind, fetched: Fetched | undefined, value: unknown): DocumentResult {
  return {
    kind,
    ...(fetched
      ? {
          url: fetched.url,
          finalUrl: fetched.finalUrl,
          ...(fetched.status !== undefined ? { status: fetched.status } : {}),
          ...(fetched.contentType ? { contentType: fetched.contentType } : {}),
          maxAgeSeconds: fetched.maxAgeSeconds
        }
      : {}),
    ...(value !== undefined ? { value } : {})
  };
}

export type TextOptions = {
  /** poppy.json: the domain whose well-known URL served it. */
  readonly domain?: string;
  /** client-metadata: the URL it was fetched from. */
  readonly fetchedFrom?: string;
  /** Documents without their own version: which protocol version to check against. 0.3, the only one, is the default. */
  readonly protocolVersion?: string;
};

function profileByOption(option: string | undefined, c: Checker): Profile | undefined {
  const profile = option === undefined ? LATEST : profileForVersion(option);
  if (!profile) c.report("version-unsupported", "", `Unsupported protocol context ${JSON.stringify(option)}.`);
  return profile;
}

/** Validate one pasted document. Checks that need other documents or a URL are listed as skipped. */
export function validateText(kind: DocumentKind, text: string, options: TextOptions = {}): Report {
  const c = new Checker(kind);
  if (new TextEncoder().encode(text).byteLength > 100_000) c.report("http-too-large", "", "The document is larger than 100 KB, which agents won't read.");
  const value = parse(c, text);
  const skipped: Skipped[] = [];
  let profile = profileByOption(options.protocolVersion, c);
  if (value !== undefined && profile) {
    if (kind === "poppy") {
      const chosen = profileFor(c, value);
      if (chosen) {
        profile = chosen;
        profile.poppy(c, value, { ...(options.domain ? { requestedDomain: options.domain } : {}) });
      }
      if (!options.domain) skipped.push({ check: "organization.domain is the host that serves the document", reason: "No domain given." });
      skipped.push({ check: "The domain's protected resource metadata and the issuer's OAuth metadata", reason: "Validate by domain to fetch them." });
    } else if (kind === "oauth-metadata") {
      profile.oauthMetadata(c, value, undefined);
      skipped.push({ check: "issuer is the one the domain names, protected_resources includes the domain, scopes are described", reason: "Needs the poppy.json; validate by domain." });
    } else if (kind === "client-metadata") {
      profile.clientMetadata(c, value, { ...(options.fetchedFrom ? { fetchedFrom: options.fetchedFrom } : {}) });
      if (!options.fetchedFrom) skipped.push({ check: "client_id equals the URL fetched", reason: "No URL given." });
      skipped.push({ check: "The key set at jwks_uri", reason: "Validate by URL to fetch it." });
    } else if (kind === "protected-resource") {
      profile.protectedResource(c, value, { signIn: { direct: false, device: false, mediated: false } });
      skipped.push({ check: "resource is https://{organization.domain}; auth.issuer is one of authorization_servers", reason: "Needs the poppy.json; validate by domain." });
    } else {
      profile.jwks(c, value);
    }
  }
  return report(profile ?? LATEST, [documentResult(kind, undefined, value)], [c], skipped);
}

export type CompanyReport = Report & {
  /** The validated documents, for a client that ingests them. */
  readonly poppy?: unknown;
  readonly metadata?: unknown;
  /** The domain's protected resource metadata (3.2). */
  readonly protectedResource?: unknown;
  /** The issuer the documents settled on: the one the domain's protected resource metadata names. */
  readonly issuer?: string;
  /** The shorter of the two documents' cache lifetimes, unbounded; null if neither said. */
  readonly maxAgeSeconds: number | null;
};

export { domainFromInput } from "../domain.ts";

/**
 * Discovery for one domain (spec 3): fetch poppy.json and check it, then the
 * domain's protected resource metadata, which names the issuer, and the
 * issuer's OAuth metadata, checked against poppy.json (3.2).
 */
export async function validateCompany(fetcher: Fetcher, domain: string): Promise<CompanyReport> {
  const requested = domainFromInput(domain);
  const poppyChecker = new Checker("poppy");
  const checkers = [poppyChecker];
  const documents: DocumentResult[] = [];
  if (!isHostname(requested)) {
    poppyChecker.report("domain-invalid", "", `${JSON.stringify(domain)} isn't a domain name.`);
    return { ...report(LATEST, documents, checkers, []), maxAgeSeconds: null };
  }
  const fetched = await fetchDocument(fetcher, `https://${requested}/.well-known/poppy.json`, poppyChecker);
  const poppy = fetched.text !== undefined ? parse(poppyChecker, fetched.text) : undefined;
  documents.push(documentResult("poppy", fetched, poppy));
  let profile = LATEST;
  let facts: PoppyFacts | undefined;
  let metadata: unknown;
  const ages = [fetched.maxAgeSeconds];
  if (poppy !== undefined) {
    const chosen = profileFor(poppyChecker, poppy);
    if (chosen) {
      profile = chosen;
      // The document speaks for the host that served it, after redirects (3).
      facts = profile.poppy(poppyChecker, poppy, { requestedDomain: new URL(fetched.finalUrl).hostname });
    }
  }
  let protectedResource: unknown;
  if (facts) {
    // A redirect may change the host, never the path (3).
    const final = new URL(fetched.finalUrl);
    if (final.pathname !== "/.well-known/poppy.json" || final.search !== "") {
      poppyChecker.report("poppy-redirect-path", "", `The document came from ${final.origin}${final.pathname}${final.search ? " with a query" : ""}, not /.well-known/poppy.json.`);
    }
    // The issuer is the one the domain's protected resource metadata names (3.2).
    const named = facts.issuer;
    facts.issuer = undefined;
    if (facts.domain && (facts.needsIssuer || named !== undefined)) {
      const prmChecker = new Checker("protected-resource");
      checkers.push(prmChecker);
      const prmFetched = await fetchDocument(fetcher, `https://${facts.domain.toLowerCase()}/.well-known/oauth-protected-resource`, prmChecker);
      protectedResource = prmFetched.text !== undefined ? parse(prmChecker, prmFetched.text) : undefined;
      documents.push(documentResult("protected-resource", prmFetched, protectedResource));
      ages.push(prmFetched.maxAgeSeconds);
      if (protectedResource !== undefined) facts.issuer = profile.protectedResource(prmChecker, protectedResource, { ...facts, ...(named !== undefined ? { issuer: named } : {}) });
    }
  }
  if (facts?.issuer) {
    const metadataChecker = new Checker("oauth-metadata");
    checkers.push(metadataChecker);
    const metaFetched = await fetchDocument(fetcher, metadataUrl(facts.issuer), metadataChecker);
    metadata = metaFetched.text !== undefined ? parse(metadataChecker, metaFetched.text) : undefined;
    documents.push(documentResult("oauth-metadata", metaFetched, metadata));
    ages.push(metaFetched.maxAgeSeconds);
    if (metadata !== undefined) profile.oauthMetadata(metadataChecker, metadata, facts);
  }
  const known = ages.filter((age): age is number => age !== null);
  return {
    ...report(profile, documents, checkers, []),
    ...(poppy !== undefined ? { poppy } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(protectedResource !== undefined ? { protectedResource } : {}),
    ...(facts?.issuer ? { issuer: facts.issuer } : {}),
    maxAgeSeconds: known.length ? Math.min(...known) : null
  };
}

/** A Personal Agent's client metadata at its client_id URL, and its key set (spec 4.1). */
export async function validateClient(fetcher: Fetcher, url: string, options: TextOptions = {}): Promise<Report> {
  const c = new Checker("client-metadata");
  const selected = profileByOption(options.protocolVersion, c);
  const profile = selected ?? LATEST;
  if (!selected) return report(profile, [], [c], []);
  const checkers = [c];
  const documents: DocumentResult[] = [];
  // Companies fetch client_id without following redirects (Guides, "Verifying personal agents").
  const fetched = await fetchDocument(fetcher, url, c, { followRedirects: false });
  const value = fetched.text !== undefined ? parse(c, fetched.text) : undefined;
  documents.push(documentResult("client-metadata", fetched, value));
  if (value !== undefined) {
    const facts = profile.clientMetadata(c, value, { fetchedFrom: url });
    if (facts.jwksUri) {
      const keys = new Checker("jwks");
      checkers.push(keys);
      const keysFetched = await fetchDocument(fetcher, facts.jwksUri, keys);
      const jwks = keysFetched.text !== undefined ? parse(keys, keysFetched.text) : undefined;
      documents.push(documentResult("jwks", keysFetched, jwks));
      if (jwks !== undefined) profile.jwks(keys, jwks);
    }
  }
  return report(profile, documents, checkers, []);
}

/**
 * Validate whatever is at a URL or domain: a bare domain or a poppy.json URL
 * checks the Company; anything else is taken as a client_id URL.
 */
export async function validateTarget(fetcher: Fetcher, target: string, options: TextOptions = {}): Promise<Report> {
  const trimmed = target.trim();
  if (!/^https?:\/\//i.test(trimmed)) return validateCompany(fetcher, trimmed);
  const url = new URL(trimmed);
  if (url.pathname === "/.well-known/poppy.json" || url.pathname === "/") return validateCompany(fetcher, url.hostname);
  if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
    const c = new Checker("oauth-metadata");
    const profile = profileByOption(options.protocolVersion, c);
    if (!profile) return report(LATEST, [], [c], []);
    const fetched = await fetchDocument(fetcher, url.href, c);
    const value = fetched.text !== undefined ? parse(c, fetched.text) : undefined;
    if (value !== undefined) profile.oauthMetadata(c, value, undefined);
    return report(profile, [documentResult("oauth-metadata", fetched, value)], [c], [
      { check: "issuer is the one the domain names, protected_resources includes the domain, scopes are described", reason: "Validate the Company's domain to check these." }
    ]);
  }
  return validateClient(fetcher, url.href, options);
}

/** One line per message our client refuses the documents over (every error but the tolerated ones, and the refusing warnings), for exceptions and logs. */
export function summarize(result: Report, limit = 3): string {
  const errors = result.messages.filter((m) => m.refuses);
  const shown = errors.slice(0, limit).map((m) => m.text.replace(/\.$/, ""));
  const more = errors.length > limit ? ` (and ${errors.length - limit} more)` : "";
  return `${shown.join("; ")}${more}`;
}
