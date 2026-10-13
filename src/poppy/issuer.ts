import { DecodeError, type Decoder } from "../decode";

declare const ISSUER: unique symbol;
declare const ORIGIN: unique symbol;

/**
 * A Company's `auth.issuer`, exactly as it publishes it (an https URL with no
 * query, fragment or credentials). Issuers are compared exactly (spec-issues
 * S7: a trailing slash or a path is part of it), so this keeps the string
 * unchanged; what it rules out is a value that isn't an issuer at all, such
 * as a bare domain. Made only by `parseIssuer`. Everything keyed by Company
 * (SQL rows, the protocol log, limiters, tokens) takes one.
 */
export type Issuer = string & { readonly [ISSUER]: true };

/** An http(s) origin, `scheme://host[:port]`, as `URL.origin` writes it. Made only by `originOf`. */
export type Origin = string & { readonly [ORIGIN]: true };

/** The issuer `value` is, or null. */
export function parseIssuer(value: unknown): Issuer | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.search || url.hash || value.includes("#") || url.username || url.password) return null;
  return value as Issuer;
}

/** An issuer from a value that must be one (a test's fixture, say); throws a `DecodeError` otherwise. */
export function toIssuer(value: string): Issuer {
  return issuerDecoder(value, "issuer");
}

export const issuerDecoder: Decoder<Issuer> = (value, at) => {
  const parsed = parseIssuer(value);
  if (parsed === null) throw new DecodeError(`${at || "the value"}: expected an issuer (an https URL with no query or fragment)`);
  return parsed;
};

/** The origin of an http(s) URL, or null. */
export function originOf(value: string | URL): Origin | null {
  if (typeof value === "string" && !URL.canParse(value)) return null;
  const url = typeof value === "string" ? new URL(value) : value;
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== "null" ? (url.origin as Origin) : null;
}

/** A domain's https origin (`shop.example` is `https://shop.example`), or null for one that isn't a host name. */
export function domainOrigin(domain: string): Origin | null {
  const host = domain.trim().toLowerCase();
  return URL.canParse(`https://${host}`) && new URL(`https://${host}`).host === host ? originOf(`https://${host}`) : null;
}
