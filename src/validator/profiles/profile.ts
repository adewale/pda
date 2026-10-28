import type { Checker } from "../primitives.ts";

/** What the poppy.json check learned, for checking the OAuth metadata against it. */
export type PoppyFacts = {
  domain?: string;
  issuer?: string;
  signIn: { direct: boolean; device: boolean; mediated: boolean };
  /**
   * 0.3: the issuer comes from the domain's protected resource metadata
   * (3.2), and `auth.issuer` only picks one of several. Set when poppy.json
   * lists something that needs an issuer, so the metadata must exist.
   */
  needsIssuer?: boolean;
  /** 0.3: the Mediated Sign-In extension's `scopes`, when it is listed. */
  mediatedScopes?: readonly string[];
  /** 0.3: scopes poppy.json describes or hints at, to compare with `scopes_supported`. */
  describedScopes?: readonly string[];
};

export type ClientFacts = { jwksUri?: string };

/** Rules for one explicitly supported wire version; incompatible drafts get separate profiles. */
export type Profile = {
  readonly version: string;
  /** Human name, such as "Draft 0.1". */
  readonly name: string;
  poppy(c: Checker, doc: unknown, context: { requestedDomain?: string }): PoppyFacts;
  /**
   * 0.3: the domain's protected resource metadata (RFC 9728), which names
   * the issuer (3.2). Returns the issuer it settles on, if any. Profiles
   * without it read the issuer from poppy.json.
   */
  protectedResource?(c: Checker, doc: unknown, poppy: PoppyFacts): string | undefined;
  oauthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void;
  clientMetadata(c: Checker, doc: unknown, context: { fetchedFrom?: string }): ClientFacts;
  jwks(c: Checker, doc: unknown): void;
};
