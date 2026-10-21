/** Wire support is explicit before 1.0. These are policies, not negotiated headers. */
export const PROTOCOL_VERSIONS = ["0.1", "0.2"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
export const PROTOCOL_REVISION = "2026-10-19";
export const PROTOCOL_COMMIT = "39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d";
export function supportsProtocol(value: unknown): value is ProtocolVersion {
  return PROTOCOL_VERSIONS.some((version) => version === value);
}
export const PROTOCOL_REVISIONS: Readonly<Record<ProtocolVersion, string>> = { "0.1": "2026-10-12", "0.2": PROTOCOL_REVISION };
export function protocolRevision(version: string): string | undefined {
  return supportsProtocol(version) ? PROTOCOL_REVISIONS[version] : undefined;
}
export function isDraft2(company: { readonly protocolVersion: string }): boolean {
  if (!supportsProtocol(company.protocolVersion)) throw new Error(`Unsupported Poppy version: ${company.protocolVersion}`);
  return company.protocolVersion === "0.2";
}
