/**
 * Every protocol version the validator knows. To support an incompatible new
 * version, add a profile module that imports the rules from the previous one
 * it still wants, and append it here. Old profiles stay, so documents that
 * still declare an old version are checked by that version's rules.
 */
import { draft0 } from "./draft-0.ts";
import { draft02 } from "./draft-0.2.ts";
import type { Profile } from "./profile.ts";

export const PROFILES: readonly Profile[] = [draft0, draft02];

/** The newest profile; versionless input defaults are selected explicitly by validate.ts. */
export const LATEST: Profile = PROFILES[PROFILES.length - 1]!;

export function profileForVersion(version: string): Profile | undefined {
  return PROFILES.find((profile) => profile.version === version);
}

export const SUPPORTED_VERSIONS = PROFILES.map((profile) => `${profile.version} (${profile.name})`).join(", ");
