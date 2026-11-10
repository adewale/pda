/**
 * Every protocol version the validator knows: 0.3, and the 0.4 draft. To
 * support an incompatible new version, add a profile module that imports the
 * rules it still wants from the previous one, and append it here.
 */
import { draft03 } from "./draft-0.3.ts";
import { draft04 } from "./draft-0.4.ts";
import type { Profile } from "./profile.ts";

export const PROFILES: readonly Profile[] = [draft03, draft04];

/**
 * The profile for a document that names no usable version, and the default
 * context for documents without their own: 0.3, the version the agent speaks
 * at runtime, until 0.4 is added to it (docs/poppy-0.4-upgrade.md, P1).
 */
export const LATEST: Profile = draft03;

export function profileForVersion(version: string): Profile | undefined {
  return PROFILES.find((profile) => profile.version === version);
}

export const SUPPORTED_VERSIONS = PROFILES.map((profile) => `${profile.version} (${profile.name})`).join(", ");
