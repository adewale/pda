import { importJWK, type JWK } from "jose";
import { ConfigError } from "../config.ts";

/** One of our ES256 signing keys: the private half for signing, the public half for the JWKS. */
export type SigningKey = {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
};

/**
 * Where our identity lives. `client_id` is the metadata document's URL,
 * forever (decision 37: one document again, now that we speak 0.3 alone).
 */
export type AgentIdentity = {
  readonly origin: string;
  readonly clientId: string;
  readonly jwksUri: string;
  readonly redirectUri: string;
  readonly clientName: string;
  readonly logoUri: string;
};

type IdentityEnv = {
  readonly PUBLIC_ORIGIN?: string;
  readonly POPPY_CLIENT_NAME?: string;
  readonly POPPY_LOGO_URI?: string;
  readonly POPPY_SIGNING_JWKS?: string;
};

function required(env: IdentityEnv, name: keyof IdentityEnv): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Missing required setting ${name}`);
  }
  return value.trim();
}

export function readIdentity(env: IdentityEnv): AgentIdentity {
  const origin = required(env, "PUBLIC_ORIGIN").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ConfigError("PUBLIC_ORIGIN must be an https:// origin");
  }
  if (url.protocol !== "https:" || url.origin !== origin) {
    throw new ConfigError("PUBLIC_ORIGIN must be an https:// origin with no path");
  }
  const logoUri = required(env, "POPPY_LOGO_URI");
  if (!logoUri.startsWith("https://")) {
    throw new ConfigError("POPPY_LOGO_URI must be an https:// URL");
  }
  return {
    origin,
    clientId: `${origin}/poppy/client.json`,
    jwksUri: `${origin}/poppy/jwks.json`,
    redirectUri: `${origin}/poppy/callback`,
    clientName: required(env, "POPPY_CLIENT_NAME"),
    logoUri
  };
}

// Imported keys are cached per isolate, keyed by the secret's text.
let cached: { source: string; keys: Promise<SigningKey[]> } | undefined;

/**
 * Our signing keys from `POPPY_SIGNING_JWKS`, a JSON array of private ES256
 * JWKs, each with a `kid`. The first signs; the rest stay published so a new
 * key can be announced before use and an old one kept until its signatures
 * expire (Guides, "Rotating keys").
 */
export function readSigningKeys(env: IdentityEnv): Promise<SigningKey[]> {
  const source = required(env, "POPPY_SIGNING_JWKS");
  if (cached?.source === source) return cached.keys;
  const keys = parseKeys(source);
  cached = { source, keys };
  keys.catch(() => {
    if (cached?.source === source) cached = undefined;
  });
  return keys;
}

async function parseKeys(source: string): Promise<SigningKey[]> {
  let list: unknown;
  try {
    list = JSON.parse(source);
  } catch {
    throw new ConfigError("POPPY_SIGNING_JWKS must be a JSON array of JWKs");
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError("POPPY_SIGNING_JWKS must be a non-empty JSON array of JWKs");
  }
  const kids = new Set<string>();
  return Promise.all(
    list.map(async (entry: JWK) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        entry.kty !== "EC" ||
        entry.crv !== "P-256" ||
        typeof entry.d !== "string" ||
        typeof entry.kid !== "string" ||
        entry.kid === ""
      ) {
        throw new ConfigError(
          "POPPY_SIGNING_JWKS entries must be private P-256 EC JWKs with a kid"
        );
      }
      if (kids.has(entry.kid)) {
        throw new ConfigError(`POPPY_SIGNING_JWKS has a duplicate kid ${entry.kid}`);
      }
      kids.add(entry.kid);
      const privateKey = (await importJWK({ ...entry, alg: "ES256" }, "ES256")) as CryptoKey;
      const { d: _private, ...rest } = entry;
      const publicJwk: JWK = {
        kty: "EC",
        crv: "P-256",
        x: rest.x,
        y: rest.y,
        kid: entry.kid,
        alg: "ES256",
        use: "sig"
      };
      return { kid: entry.kid, privateKey, publicJwk };
    })
  );
}

/** The key that signs now. */
export async function currentKey(env: IdentityEnv): Promise<SigningKey> {
  return (await readSigningKeys(env))[0]!;
}
