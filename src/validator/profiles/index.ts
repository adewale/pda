/**
 * Every protocol version the validator knows. To support a new major
 * version, add a profile module that imports the rules from the previous one
 * it still wants, and append it here. Old profiles stay, so documents that
 * still declare an old version are checked by that version's rules.
 */
import { draft0 } from "./draft-0.ts";
import type { Profile } from "./profile.ts";

export const PROFILES: readonly Profile[] = [draft0];

/** The newest profile: used for documents that don't declare a version. */
export const LATEST: Profile = PROFILES[PROFILES.length - 1]!;

export function profileForMajor(major: number): Profile | undefined {
  return PROFILES.find((profile) => profile.major === major);
}

export const SUPPORTED_VERSIONS = PROFILES.map((profile) => `${profile.major}.x (${profile.name})`).join(", ");
