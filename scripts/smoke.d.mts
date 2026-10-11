/** Types for scripts/smoke.mjs, the read-only smoke test of a deployed Worker. */

export type Provider = "google" | "github";

export type SmokeResult = {
  readonly name: string;
  readonly ok: boolean;
  /** A note (a missing advisory header) never fails the run. */
  readonly note?: true;
  readonly problems: readonly string[];
};

export type Cookie = { readonly name: string; readonly value: string; readonly attributes: Readonly<Record<string, string>> };

export const PROVIDERS: Readonly<Record<Provider, { readonly origin: string; readonly path: string; readonly scope: string }>>;

export function parseBase(input: string): string;
export function parseSetCookies(headers: Headers): Cookie[];
export function signInRedirectProblems(location: string, base: string, provider: Provider): string[];
export function flowCookieProblems(cookies: readonly Cookie[]): string[];
export function setsSession(cookies: readonly Cookie[]): boolean;
export function clientMetadataProblems(metadata: unknown, base: string): string[];
export function jwksProblems(jwks: unknown): string[];
export function missingAdvisoryHeaders(headers: Headers): string[];
export function smoke(
  base: string,
  fetcher: (request: Request) => Promise<Response>,
  options?: { readonly providers?: readonly Provider[] }
): Promise<SmokeResult[]>;
export function report(results: readonly SmokeResult[]): string;
