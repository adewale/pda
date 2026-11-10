import type { Company } from "./discovery";
import { sfString } from "./operations-v2";

/**
 * What a Session declares on every request it carries (0.4, 3.4): the
 * protocol version in `Poppy-Version`, and the extensions used with the
 * Company in `Poppy-Extensions`, an RFC 9651 List of Strings with each
 * version in `v`. The values are fixed for a Session; new values need a new
 * Session (client.ts). 0.3 defines neither header, so a 0.3 Session sends
 * none and declares only its version, for that comparison.
 */
export type Declaration = { readonly version: string; readonly extensions: string };

export function declaration(company: Company): Declaration {
  if (company.protocolVersion === "0.3") return { version: "0.3", extensions: "" };
  // Mediated Sign-In isn't declared: the Company recognizes its grant type from the request itself (3.3).
  const used: [string, string][] = company.extensions.operations ? [["operations", "3"]] : [];
  return { version: company.protocolVersion, extensions: used.map(([name, version]) => `${sfString(name)};v=${sfString(version)}`).join(", ") };
}

/** The headers a Session request carries for its declaration: none under 0.3. */
export function declarationHeaders(declared: Declaration): [string, string][] {
  if (declared.version === "0.3") return [];
  return [["Poppy-Version", declared.version], ...(declared.extensions ? [["Poppy-Extensions", declared.extensions] as [string, string]] : [])];
}

export function sameDeclaration(a: Declaration, b: Declaration): boolean {
  return a.version === b.version && a.extensions === b.extensions;
}
