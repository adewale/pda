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

/**
 * Whether Browser Control 1 is used with this Company (B5): it lists the
 * extension with a browser-session endpoint (Browser Control 3), its
 * website isn't `web.disabled`, and this agent can hand a browser to the
 * User (`canHandOver`: Browser Run is on). Declaring it promises all three
 * of 3's "Support means": marked steps left to the User, control handed
 * over, and `navigator.poppy.controller` (handover.ts).
 */
export function usesBrowserControl(company: Company, canHandOver: boolean): boolean {
  return canHandOver && company.protocolVersion !== "0.3" && company.extensions.browserControl === true
    && !!company.web?.browserSessionEndpoint && !company.web.disabled;
}

export function declaration(company: Company, canHandOver = false): Declaration {
  if (company.protocolVersion === "0.3") return { version: "0.3", extensions: "" };
  // Mediated Sign-In isn't declared: the Company recognizes its grant type from the request itself (3.3).
  const used: [string, string][] = [
    ...(company.extensions.operations ? [["operations", "3"] as [string, string]] : []),
    ...(usesBrowserControl(company, canHandOver) ? [["browser-control", "1"] as [string, string]] : [])
  ];
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
