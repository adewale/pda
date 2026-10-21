import type { Checker } from "../primitives.ts";

/** What the poppy.json check learned, for checking the OAuth metadata against it. */
export type PoppyFacts = {
  domain?: string;
  issuer?: string;
  signIn: { direct: boolean; device: boolean; mediated: boolean };
};

export type ClientFacts = { jwksUri?: string };

/** Rules for one explicitly supported wire version; incompatible drafts get separate profiles. */
export type Profile = {
  readonly version: string;
  /** Human name, such as "Draft 0.1". */
  readonly name: string;
  poppy(c: Checker, doc: unknown, context: { requestedDomain?: string }): PoppyFacts;
  oauthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void;
  clientMetadata(c: Checker, doc: unknown, context: { fetchedFrom?: string }): ClientFacts;
  jwks(c: Checker, doc: unknown): void;
};
