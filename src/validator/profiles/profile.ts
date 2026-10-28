import type { Checker } from "../primitives.ts";

/** What the poppy.json check learned, for checking the OAuth metadata against it. */
export type PoppyFacts = {
  domain?: string;
  /** The issuer: `auth.issuer` while poppy.json is checked, then the one the domain's metadata names. */
  issuer?: string;
  signIn: { direct: boolean; device: boolean; mediated: boolean };
  /**
   * The issuer comes from the domain's protected resource metadata (3.2),
   * and `auth.issuer` only picks one of several. Set when poppy.json lists
   * something that needs an issuer, so the metadata must exist.
   */
  needsIssuer?: boolean;
  /** The Mediated Sign-In extension's `scopes`, when it is listed. */
  mediatedScopes?: readonly string[];
  /**
   * The scopes `auth.scopes` describes, to compare with `scopes_supported`
   * (4.7). Unset when poppy.json lists an OpenAPI description, which may
   * describe the others.
   */
  describedScopes?: readonly string[];
};

export type ClientFacts = { jwksUri?: string };

/** Rules for one explicitly supported wire version; incompatible drafts get separate profiles. */
export type Profile = {
  readonly version: string;
  /** Human name, such as "Draft 0.3". */
  readonly name: string;
  /** poppy.json; `requestedDomain` is the host that served it, after redirects. */
  poppy(c: Checker, doc: unknown, context: { requestedDomain?: string }): PoppyFacts;
  /**
   * The domain's protected resource metadata (RFC 9728), which names the
   * issuer (3.2). Returns the issuer it settles on, if any.
   */
  protectedResource(c: Checker, doc: unknown, poppy: PoppyFacts): string | undefined;
  oauthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void;
  clientMetadata(c: Checker, doc: unknown, context: { fetchedFrom?: string }): ClientFacts;
  jwks(c: Checker, doc: unknown): void;
};
