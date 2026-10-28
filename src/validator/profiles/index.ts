/**
 * Every protocol version the validator knows: 0.3 alone. To support an
 * incompatible new version, add a profile module that imports the rules it
 * still wants from the previous one, and append it here.
 */
import { draft03 } from "./draft-0.3.ts";
import type { Profile } from "./profile.ts";

export const PROFILES: readonly Profile[] = [draft03];

/** The newest version's profile, for a document that names no usable version. */
export const LATEST: Profile = draft03;

export function profileForVersion(version: string): Profile | undefined {
  return PROFILES.find((profile) => profile.version === version);
}

export const SUPPORTED_VERSIONS = PROFILES.map((profile) => `${profile.version} (${profile.name})`).join(", ");
