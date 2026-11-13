/**
 * Every protocol version the validator knows: 0.4 and the 1.0 draft. A
 * document that declares another version is refused as unsupported, since
 * our client won't use it, except that from 1.0 a newer minor version is
 * checked with the newest profile of its major version (3.4). To support an
 * incompatible new version, add a profile module that imports the rules it
 * still wants from the previous one, and append it here.
 */
import { draft04 } from "./draft-0.4.ts";
import { draft10 } from "./draft-1.0.ts";
import type { Profile } from "./profile.ts";

export const PROFILES: readonly Profile[] = [draft04, draft10];

/**
 * The profile for a document that names no usable version, and the default
 * context for documents without their own: 1.0, the newest version the
 * agent speaks (docs/poppy-1.0-upgrade.md).
 */
export const LATEST: Profile = draft10;

/**
 * The rules for a document of `version`: its own profile, or from 1.0 the
 * newest profile with the same major version and no newer minor version,
 * since a newer minor version doesn't break older Personal Agents, which
 * ignore what it adds (3.1, 3.4).
 */
export function profileForVersion(version: string): Profile | undefined {
  const exact = PROFILES.find((profile) => profile.version === version);
  if (exact) return exact;
  const [major, minor] = version.split(".").map(Number) as [number, number];
  if (!(major >= 1) || !Number.isInteger(minor)) return undefined;
  return PROFILES.filter((profile) => {
    const [pMajor, pMinor] = profile.version.split(".").map(Number) as [number, number];
    return pMajor === major && pMinor <= minor;
  }).at(-1);
}

export const SUPPORTED_VERSIONS = PROFILES.map((profile) => `${profile.version} (${profile.name})`).join(", ");
