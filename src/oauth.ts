import { decodeJwt } from "jose";
import {
  readProviderConfig,
  readSessionSecret,
  type Provider,
  type ProviderConfig
} from "./config";
import {
  base64url,
  cookie,
  createSession,
  readCookie,
  sign,
  unsign,
  type Identity
} from "./session";

/** Holds `state` and the PKCE verifier between the redirect and the callback. */
const FLOW_COOKIE = "__Host-oauth";
const FLOW_TTL_SECONDS = 10 * 60;

type Flow = {
  readonly provider: Provider;
  readonly state: string;
  readonly verifier: string;
  readonly exp: number;
};

/** The provider said no, or answered with something we cannot use. */
class SignInError extends Error {
  override name = "SignInError";
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export const PROVIDERS: readonly Provider[] = ["google", "github"];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

function callbackUrl(request: Request, provider: Provider): string {
  return `${new URL(request.url).origin}/auth/${provider}/callback`;
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
}

/** `GET /auth/<provider>`: send the browser to the provider's consent page. */
export async function startSignIn(
  request: Request,
  env: Env,
  provider: Provider
): Promise<Response> {
  const client = readProviderConfig(env, provider);
  const secret = readSessionSecret(env);
  const flow: Flow = {
    provider,
    state: randomToken(),
    verifier: randomToken(),
    exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS
  };
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: callbackUrl(request, provider),
    response_type: "code",
    state: flow.state,
    code_challenge: await challengeFor(flow.verifier),
    code_challenge_method: "S256"
  });
  let url: string;
  if (provider === "google") {
    params.set("scope", "openid email");
    params.set("prompt", "select_account");
    url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  } else {
    params.set("scope", "read:user user:email");
    url = `https://github.com/login/oauth/authorize?${params}`;
  }
  return redirect(url, [
    cookie(FLOW_COOKIE, await sign(flow, secret), { maxAge: FLOW_TTL_SECONDS })
  ]);
}

/** `GET /auth/<provider>/callback`: check state, swap the code, sign in. */
export async function finishSignIn(
  request: Request,
  env: Env,
  provider: Provider
): Promise<Response> {
  const client = readProviderConfig(env, provider);
  const secret = readSessionSecret(env);
  const clearFlow = cookie(FLOW_COOKIE, "", { maxAge: 0 });
  try {
    const url = new URL(request.url);
    const denied = url.searchParams.get("error");
    if (denied) throw new SignInError("denied", `Provider returned ${denied}`);

    const token = readCookie(request, FLOW_COOKIE);
    const flow = token ? await unsign<Flow>(token, secret) : null;
    if (
      !flow ||
      flow.provider !== provider ||
      flow.exp * 1000 <= Date.now() ||
      url.searchParams.get("state") !== flow.state
    ) {
      throw new SignInError("state", "Missing, expired or mismatched state");
    }
    const code = url.searchParams.get("code");
    if (!code) throw new SignInError("code", "No authorization code");

    const redirectUri = callbackUrl(request, provider);
    const identity =
      provider === "google"
        ? await googleIdentity(client, code, flow.verifier, redirectUri)
        : await githubIdentity(client, code, flow.verifier, redirectUri);
    return redirect("/", [clearFlow, await createSession(identity, secret)]);
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    console.warn("sign-in failed", provider, error.message);
    return redirect(`/?signin_error=${error.code}`, [clearFlow]);
  }
}

async function postForm(url: string, form: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(form)
  });
}

/**
 * Google returns an ID token straight from its token endpoint over TLS, so
 * OpenID Connect lets us skip its signature and check the claims.
 */
async function googleIdentity(
  client: ProviderConfig,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<Identity> {
  const response = await postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier
  });
  const body = (await response.json().catch(() => ({}))) as {
    id_token?: string;
    error?: string;
  };
  if (!response.ok || !body.id_token) {
    throw new SignInError("token", `Google token exchange failed: ${body.error ?? response.status}`);
  }
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(body.id_token);
  } catch {
    throw new SignInError("token", "Google returned an unreadable ID token");
  }
  const issuerOk =
    claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const audienceOk = Array.isArray(claims.aud)
    ? claims.aud.includes(client.clientId)
    : claims.aud === client.clientId;
  if (
    !issuerOk ||
    !audienceOk ||
    typeof claims.sub !== "string" ||
    claims.sub === "" ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 <= Date.now()
  ) {
    throw new SignInError("token", "Google ID token failed its claim checks");
  }
  const email =
    claims.email_verified === true && typeof claims.email === "string"
      ? claims.email
      : null;
  return { provider: "google", sub: claims.sub, email };
}

async function githubIdentity(
  client: ProviderConfig,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<Identity> {
  const response = await postForm("https://github.com/login/oauth/access_token", {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier
  });
  // GitHub reports a bad code as a 200 with an `error` field.
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new SignInError("token", `GitHub token exchange failed: ${body.error ?? response.status}`);
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${body.access_token}`,
    "User-Agent": "personal-agent",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const userResponse = await fetch("https://api.github.com/user", { headers });
  const user = (await userResponse.json().catch(() => ({}))) as { id?: unknown };
  if (!userResponse.ok || typeof user.id !== "number") {
    throw new SignInError("profile", "GitHub did not return a user id");
  }
  // The profile email can be hidden; the primary verified one is reliable.
  let email: string | null = null;
  const emailsResponse = await fetch("https://api.github.com/user/emails", { headers });
  if (emailsResponse.ok) {
    const emails = (await emailsResponse.json().catch(() => [])) as Array<{
      email?: string;
      primary?: boolean;
      verified?: boolean;
    }>;
    const primary = emails.find((entry) => entry.primary && entry.verified);
    email = typeof primary?.email === "string" ? primary.email : null;
  }
  return { provider: "github", sub: String(user.id), email };
}
