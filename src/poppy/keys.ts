import { importJWK, type JWK } from "jose";
import { ConfigError, missingSetting } from "../config.ts";
import { departure, ours, show, shown } from "../diagnostic.ts";

/** One of our ES256 signing keys: the private half for signing, the public half for the JWKS. */
export type SigningKey = {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
};

/**
 * Where our identity lives. `client_id` is the metadata document's URL,
 * forever (decision 37: one document again, since 0.3).
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
    throw new ConfigError(missingSetting(ours(name), value));
  }
  return value.trim();
}

export function readIdentity(env: IdentityEnv): AgentIdentity {
  const origin = required(env, "PUBLIC_ORIGIN").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ConfigError(departure(ours("PUBLIC_ORIGIN"), ours("an https:// origin"), show.value(origin)));
  }
  if (url.protocol !== "https:" || url.origin !== origin) {
    throw new ConfigError(departure(ours("PUBLIC_ORIGIN"), ours("an https:// origin with no path"), show.value(origin)));
  }
  const logoUri = required(env, "POPPY_LOGO_URI");
  if (!logoUri.startsWith("https://")) {
    throw new ConfigError(departure(ours("POPPY_LOGO_URI"), ours("an https:// URL"), show.url(logoUri)));
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
    throw new ConfigError(departure(ours("POPPY_SIGNING_JWKS"), ours("a JSON array of JWKs"), ours("text that isn't JSON")));
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError(departure(ours("POPPY_SIGNING_JWKS"), ours("a non-empty JSON array of JWKs"), Array.isArray(list) ? ours("an empty array") : show.kind(list)));
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
        // Never the entry itself: it is a private key.
        throw new ConfigError(departure(ours("a POPPY_SIGNING_JWKS entry"), ours("a private P-256 EC JWK with a kid"), typeof entry === "object" && entry !== null ? shown`kty ${show.value(entry.kty)}, crv ${show.value(entry.crv)}${typeof entry.d === "string" ? ours("") : ours(", no private part")}${typeof entry.kid === "string" && entry.kid !== "" ? ours("") : ours(", no kid")}` : show.kind(entry)));
      }
      if (kids.has(entry.kid)) {
        throw new ConfigError(departure(ours("POPPY_SIGNING_JWKS's kids"), ours("each kid once"), shown`${show.value(entry.kid)} twice`));
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
