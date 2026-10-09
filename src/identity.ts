import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "./config";

/** A request without a valid Access JWT. */
export class AuthError extends Error {
  override name = "AuthError";
}

export type Identity = {
  /** Access's stable user id. */
  readonly sub: string;
  readonly email: string | undefined;
};

// One JWKS per team domain per isolate, so keys are cached between requests.
const keySets = new Map<string, JWTVerifyGetKey>();

function keySetFor(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
}

/**
 * Checks the `Cf-Access-Jwt-Assertion` header: signature against the team's
 * certs, issuer, audience and expiry. Anything else is an `AuthError`.
 */
export async function verifyAccess(
  request: Request,
  config: Pick<Config, "teamDomain" | "policyAud">
): Promise<Identity> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AuthError("Missing Access JWT");
  try {
    const { payload } = await jwtVerify(token, keySetFor(config.teamDomain), {
      issuer: config.teamDomain,
      audience: config.policyAud
    });
    if (typeof payload.sub !== "string" || payload.sub === "") {
      throw new AuthError("Access JWT has no subject");
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      `Invalid Access JWT: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** The person's Durable Object name: hex SHA-256 of `access:<sub>`. */
export async function agentNameFor(identity: Identity): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`access:${identity.sub}`)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
