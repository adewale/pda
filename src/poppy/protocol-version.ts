/**
 * The Poppy versions we speak. Before 1.0 every version can break the one
 * before (3.1), so support is explicit and a document that declares any
 * other version is refused before its issuer is used. We speak 0.4, the
 * 1.0 release candidate, as retrieved on 11 November 2026
 * (spec/draft-0.4-retrieved-2026-11-11), decision 43; 0.3 was dropped in
 * decision 49. With more than one, we choose the newest a Company offers
 * (3.4). The list is oldest first, and stays a list so a new version is
 * added as data (docs/upgrading.md).
 */
export const PROTOCOL_VERSIONS = ["0.4"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
/** The dates of the manually reviewed site snapshots we implement, by version. */
export const PROTOCOL_REVISIONS: Readonly<Record<ProtocolVersion, string>> = { "0.4": "2026-11-11" };
/** The newest version's snapshot date, as build info has always reported it. */
export const PROTOCOL_REVISION = PROTOCOL_REVISIONS["0.4"];
/** The upstream commit whose text the newest version's snapshot matches (spec/upstream.json). */
export const PROTOCOL_COMMIT: string | null = "ed474089d0fdeafae9584a95cfcc485209d8b124";

export function supportsProtocol(value: unknown): value is ProtocolVersion {
  return PROTOCOL_VERSIONS.some((version) => version === value);
}

/**
 * Drafts pinned beside the runtime versions but not yet spoken: the
 * validator checks documents against them, and the agent chooses them only
 * once they are in PROTOCOL_VERSIONS (spec/upstream.json, docs/upgrading.md).
 */
export const DRAFT_REVISIONS: Readonly<Record<string, string>> = {};

export function protocolRevision(version: string): string | undefined {
  return supportsProtocol(version) ? PROTOCOL_REVISIONS[version] : DRAFT_REVISIONS[version];
}

/** Throws for a version we don't speak, so cached state from an older agent can't smuggle one in. */
export function assertSupported(company: { readonly protocolVersion: string }): void {
  if (!supportsProtocol(company.protocolVersion)) throw new Error(`Unsupported Poppy version: ${company.protocolVersion}`);
}
