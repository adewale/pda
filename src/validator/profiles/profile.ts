import type { Checker } from "../primitives.ts";

/** What the poppy.json check learned, for checking the OAuth metadata against it. */
export type PoppyFacts = {
  domain?: string;
  /** The issuer: `auth.issuer` while poppy.json is checked, then the one the domain's metadata names. */
  issuer?: string;
  signIn: { direct: boolean; device: boolean; mediated: boolean };
  /**
   * poppy.json lists something that uses Sessions (an API, the Company
   * Agent, feedback, browser join or an extension), so the Company's
   * identifier matters: its issuer, from the domain's protected resource
   * metadata (3.2), or `https://{organization.domain}` when it has none.
   */
  usesSessions?: boolean;
  /**
   * What in poppy.json offers sign-in, so the Company MUST have an issuer
   * (3.2): `auth.issuer`, Mediated Sign-In or `signed_in` access.
   */
  needsIssuer?: readonly string[];
  /** `auth.disabled` (3.2): no sign-in for Personal Agents, though there is an issuer. */
  disabled?: boolean;
  /** The Mediated Sign-In extension's `scopes`, when it is listed. */
  mediatedScopes?: readonly string[];
  /**
   * The scopes `auth.scopes` describes, to compare with `scopes_supported`
   * (4.7). Unset when poppy.json lists an OpenAPI description, which may
   * describe the others.
   */
  describedScopes?: readonly string[];
  /** `scopes_supported` in the domain's protected resource metadata, when it lists one (0.4: 3.2, 4.7). */
  resourceScopes?: readonly string[];
  /** poppy.json lists `web.browser_session_endpoint` (0.4: the Company then supports `poppy:browser-sign-in`, 6). */
  browserSession?: boolean;
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
   * issuer (3.2). Returns the issuer it settles on; null when it says the
   * Company has none (authorization_servers absent or empty); undefined
   * when an error leaves it unsettled.
   */
  protectedResource(c: Checker, doc: unknown, poppy: PoppyFacts): string | null | undefined;
  /**
   * The Company has no issuer (3.2): its protected resource metadata is a
   * 404, or lists no authorization server. Valid only when nothing in
   * poppy.json offers sign-in.
   */
  noIssuer(c: Checker, poppy: PoppyFacts, how: "not-found" | "empty"): void;
  oauthMetadata(c: Checker, doc: unknown, poppy: PoppyFacts | undefined): void;
  clientMetadata(c: Checker, doc: unknown, context: { fetchedFrom?: string }): ClientFacts;
  jwks(c: Checker, doc: unknown): void;
};
