import type { Checker } from "../primitives.ts";

/** What the poppy.json check learned, for checking the OAuth metadata against it. */
export type PoppyFacts = {
  domain?: string;
  issuer?: string;
  signIn: { direct: boolean; device: boolean; mediated: boolean };
};

export type ClientFacts = { jwksUri?: string };

/**
 * The rules for one major version of the protocol. Minor versions within a
 * major only add things agents can ignore (spec 3.1), so one profile covers
 * them all; `minors` are the ones it was written against.
 */
export type Profile = {
  readonly major: number;
  readonly minors: readonly number[];
  /** Human name, such as "Draft 0.1". */
  readonly name: string;
  poppy(c: Checker, doc: unknown, context: { requestedDomain?: string }): PoppyFacts;
  oauthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void;
  clientMetadata(c: Checker, doc: unknown, context: { fetchedFrom?: string }): ClientFacts;
  jwks(c: Checker, doc: unknown): void;
};
