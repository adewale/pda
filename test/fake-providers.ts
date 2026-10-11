/**
 * Fake Google and GitHub OAuth servers, for the Vitest config's outbound
 * service. Imported by both the config (Node) and the tests (workerd), so it
 * uses only web APIs.
 *
 * The Worker never calls the authorize URL; the browser does. A test plays
 * the browser and the provider's consent page: it reads `client_id`,
 * `redirect_uri` and `code_challenge` from the Worker's redirect and turns
 * them, with the person who consents, into a code with `grantCode()`. The
 * code carries the whole grant, so the fake needs no shared state, and the
 * token endpoint checks what a real one does: the client secret, the
 * redirect URI, and that the PKCE verifier hashes to the code's challenge.
 */

import { SignJWT } from "jose";

/** Must match test/wrangler.jsonc. */
export const GOOGLE_CLIENT = { id: "google-test-client", secret: "google-test-secret" };
export const GITHUB_CLIENT = { id: "github-test-client", secret: "github-test-secret" };

/** What the provider remembers about one authorization code. */
export type Grant = {
  /** From the authorize URL the browser was sent to. */
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly challengeMethod: string;
  /** Who consented: Google's `sub`, or GitHub's numeric id. */
  readonly sub: string;
  readonly email: string;
  /** Google Workspace domain, for the ID token's `hd`. */
  readonly hd?: string;
  /** Google: claims that replace the ID token's own (`aud`, `iss`, `exp`, `email_verified`, ...). */
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Google: claims to leave out of the ID token, such as `sub` or `exp`. */
  readonly omit?: readonly string[];
  /** GitHub: how its API misbehaves for this person. */
  readonly github?: {
    /** `/user` answers without an id, or with an error status. */
    readonly user?: "no-id" | "string-id" | "fails";
    /** `/user/emails` fails, or has no primary verified address. */
    readonly emails?: "fails" | "primary-unverified" | "no-primary";
  };
};

const PREFIX = "grant.";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The authorization code the provider would send back for this grant. */
export function grantCode(grant: Grant): string {
  return PREFIX + base64url(new TextEncoder().encode(JSON.stringify(grant)));
}

function readGrant(code: string | null): Grant | null {
  if (!code?.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(code.slice(PREFIX.length)))) as Grant;
  } catch {
    return null;
  }
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The grant behind a token request, if the request proves everything a real provider checks. */
async function redeem(form: URLSearchParams, client: { id: string; secret: string }): Promise<Grant | null> {
  const grant = readGrant(form.get("code"));
  const verifier = form.get("code_verifier");
  if (
    !grant ||
    form.get("client_id") !== client.id ||
    form.get("client_secret") !== client.secret ||
    grant.clientId !== client.id ||
    form.get("redirect_uri") !== grant.redirectUri ||
    grant.challengeMethod !== "S256" ||
    !verifier ||
    (await s256(verifier)) !== grant.challenge
  ) {
    return null;
  }
  return grant;
}

/** Signs the fake Google ID tokens; the Worker does not check this signature. */
const idTokenKey = crypto.getRandomValues(new Uint8Array(32));

async function idToken(grant: Grant): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT.id,
    sub: grant.sub,
    email: grant.email,
    email_verified: true,
    ...(grant.hd ? { hd: grant.hd } : {}),
    iat: now,
    exp: now + 3600,
    ...grant.claims
  };
  for (const name of grant.omit ?? []) delete claims[name];
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(idTokenKey);
}

/** GitHub's API, answering for the grant its access token stands for. */
function githubApi(url: URL, grant: Grant): Response {
  if (url.pathname === "/user") {
    const mode = grant.github?.user;
    if (mode === "fails") return Response.json({ message: "Server Error" }, { status: 500 });
    const id = mode === "no-id" ? {} : mode === "string-id" ? { id: grant.sub } : { id: Number(grant.sub) };
    return Response.json({ ...id, login: `user${grant.sub}`, email: null });
  }
  if (url.pathname === "/user/emails") {
    const mode = grant.github?.emails;
    if (mode === "fails") return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json([
      { email: `other-${grant.email}`, primary: false, verified: true },
      {
        email: grant.email,
        primary: mode !== "no-primary",
        verified: mode !== "primary-unverified"
      }
    ]);
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
}

/** The outbound service: Google and GitHub, and no other network. */
export async function fakeProviders(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.href === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(await request.text());
    const grant = await redeem(form, GOOGLE_CLIENT);
    if (!grant || form.get("grant_type") !== "authorization_code") {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({ id_token: await idToken(grant), access_token: "unused" });
  }
  if (request.method === "POST" && url.href === "https://github.com/login/oauth/access_token") {
    const grant = await redeem(new URLSearchParams(await request.text()), GITHUB_CLIENT);
    // GitHub reports a bad code as a 200 with an `error` field.
    if (!grant) return Response.json({ error: "bad_verification_code" });
    return Response.json({ access_token: `tok.${grantCode(grant)}` });
  }
  if (url.origin === "https://api.github.com") {
    const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer tok\./, "");
    const grant = readGrant(token);
    if (!grant || !request.headers.get("User-Agent")) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    return githubApi(url, grant);
  }
  return new Response("No network in tests", { status: 502 });
}
