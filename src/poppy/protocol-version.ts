/**
 * The Poppy versions we speak. Before 1.0 every version can break the one
 * before (3.1), so support is explicit and a document that declares any
 * other version is refused before its issuer is used. We speak 0.3 alone,
 * as upstream rewrote it on 28 October 2026 (spec/draft-0.3-retrieved-2026-10-28),
 * decision 37. The list stays a list so a new version is added as data
 * (docs/poppy-0.3-plan.md).
 */
export const PROTOCOL_VERSIONS = ["0.3"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
/** The date of the text we implement: the site snapshot, since upstream hasn't committed it. */
export const PROTOCOL_REVISION = "2026-10-28";
/** Upstream's commit for that text: none yet (spec/upstream.json). */
export const PROTOCOL_COMMIT: string | null = null;

export function supportsProtocol(value: unknown): value is ProtocolVersion {
  return PROTOCOL_VERSIONS.some((version) => version === value);
}

export const PROTOCOL_REVISIONS: Readonly<Record<ProtocolVersion, string>> = { "0.3": PROTOCOL_REVISION };

export function protocolRevision(version: string): string | undefined {
  return supportsProtocol(version) ? PROTOCOL_REVISIONS[version] : undefined;
}

/** Throws for a version we don't speak, so cached state from an older agent can't smuggle one in. */
export function assertSupported(company: { readonly protocolVersion: string }): void {
  if (!supportsProtocol(company.protocolVersion)) throw new Error(`Unsupported Poppy version: ${company.protocolVersion}`);
}
