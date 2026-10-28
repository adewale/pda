/**
 * Wire support is explicit before 1.0. These are policies, not negotiated
 * headers. Versions are in order, oldest first: a rule a later version keeps
 * is asked for with `sinceVersion`, and one only that version has with
 * `isVersion`, so adding a version is a matter of answering, at each call,
 * whether it keeps the rule.
 */
export const PROTOCOL_VERSIONS = ["0.1", "0.2", "0.3"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
export const PROTOCOL_REVISION = "2026-10-19";
export const PROTOCOL_COMMIT = "39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d";
export function supportsProtocol(value: unknown): value is ProtocolVersion {
  return PROTOCOL_VERSIONS.some((version) => version === value);
}
/**
 * The text each version is implemented from. 0.3 is the in-progress draft
 * as rewritten on 28 October (spec/draft-0.3-retrieved-2026-10-28), which
 * upstream's repository hasn't caught up with, so it has no commit to pin.
 */
export const PROTOCOL_REVISIONS: Readonly<Record<ProtocolVersion, string>> = { "0.1": "2026-10-12", "0.2": PROTOCOL_REVISION, "0.3": "2026-10-28" };
export function protocolRevision(version: string): string | undefined {
  return supportsProtocol(version) ? PROTOCOL_REVISIONS[version] : undefined;
}

function checked(version: string): ProtocolVersion {
  if (!supportsProtocol(version)) throw new Error(`Unsupported Poppy version: ${version}`);
  return version;
}

/** Whether `company` speaks `version` or a later one. An unsupported version throws: cached state can't smuggle one in. */
export function sinceVersion(company: { readonly protocolVersion: string }, version: ProtocolVersion): boolean {
  return PROTOCOL_VERSIONS.indexOf(checked(company.protocolVersion)) >= PROTOCOL_VERSIONS.indexOf(version);
}

/** Whether `company` speaks exactly `version`. An unsupported version throws. */
export function isVersion(company: { readonly protocolVersion: string }, version: ProtocolVersion): boolean {
  return checked(company.protocolVersion) === version;
}

/** `sinceVersion` for a version string that may not be supported, such as a document's: false then. */
export function versionAtLeast(version: string, minimum: ProtocolVersion): boolean {
  return supportsProtocol(version) && PROTOCOL_VERSIONS.indexOf(version) >= PROTOCOL_VERSIONS.indexOf(minimum);
}
