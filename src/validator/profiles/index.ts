/**
 * Every protocol version the validator knows. To support an incompatible new
 * version, add a profile module that imports the rules from the previous one
 * it still wants, and append it here. Old profiles stay, so documents that
 * still declare an old version are checked by that version's rules.
 */
import { draft0 } from "./draft-0.ts";
import { draft02 } from "./draft-0.2.ts";
import { draft03 } from "./draft-0.3.ts";
import type { Profile } from "./profile.ts";

export const PROFILES: readonly Profile[] = [draft0, draft02, draft03];

/**
 * The newest published version's profile, for a document that names no
 * usable version. 0.3 is still an in-progress draft, so a document has to
 * say "0.3" to be checked by it.
 */
export const LATEST: Profile = draft02;

export function profileForVersion(version: string): Profile | undefined {
  return PROFILES.find((profile) => profile.version === version);
}

export const SUPPORTED_VERSIONS = PROFILES.map((profile) => `${profile.version} (${profile.name})`).join(", ");
