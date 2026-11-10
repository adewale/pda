/**
 * The Poppy versions we speak. Before 1.0 every version can break the one
 * before (3.1), so support is explicit and a document that declares any
 * other version is refused before its issuer is used. We speak 0.3 alone,
 * as retrieved on 3 November 2026 (spec/draft-0.3-retrieved-2026-11-03),
 * decision 37. The list stays a list so a new version is added as data
 * (docs/upgrading.md).
 */
export const PROTOCOL_VERSIONS = ["0.3"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
/** The date of the manually reviewed site snapshot we implement. */
export const PROTOCOL_REVISION = "2026-11-03";
/** The upstream commit whose text the snapshot matches (spec/upstream.json). */
export const PROTOCOL_COMMIT: string | null = "7205250c6fb7d4a181707898fa418911ccbcb163";

export function supportsProtocol(value: unknown): value is ProtocolVersion {
  return PROTOCOL_VERSIONS.some((version) => version === value);
}

export const PROTOCOL_REVISIONS: Readonly<Record<ProtocolVersion, string>> = { "0.3": PROTOCOL_REVISION };

/**
 * Drafts pinned beside the runtime versions but not yet spoken: the
 * validator checks documents against them, and the agent chooses them only
 * once they are in PROTOCOL_VERSIONS (spec/upstream.json, docs/upgrading.md).
 */
export const DRAFT_REVISIONS: Readonly<Record<string, string>> = { "0.4": "2026-11-10" };

export function protocolRevision(version: string): string | undefined {
  return supportsProtocol(version) ? PROTOCOL_REVISIONS[version] : DRAFT_REVISIONS[version];
}

/** Throws for a version we don't speak, so cached state from an older agent can't smuggle one in. */
export function assertSupported(company: { readonly protocolVersion: string }): void {
  if (!supportsProtocol(company.protocolVersion)) throw new Error(`Unsupported Poppy version: ${company.protocolVersion}`);
}
