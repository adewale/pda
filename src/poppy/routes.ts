import { readIdentity, readSigningKeys } from "./keys";

/**
 * The client metadata document (spec 4.1). Its URL is our `client_id`. It
 * lists Operations 2 (Ops 2); Mediated Sign-In needs no listing (MSI 2).
 */
export function clientMetadata(env: Env) {
  const identity = readIdentity(env);
  return {
    client_id: identity.clientId,
    client_name: identity.clientName,
    logo_uri: identity.logoUri,
    jwks_uri: identity.jwksUri,
    redirect_uris: [identity.redirectUri],
    token_endpoint_auth_method: "private_key_jwt",
    extensions: { operations: { version: "2" } }
  };
}

const IDENTITY_PATHS = ["/poppy/client.json", "/poppy/jwks.json"];

const PUBLIC_CACHE = "public, max-age=3600";

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * `GET /poppy/client.json` and `GET /poppy/jwks.json`. Served only on
 * `PUBLIC_ORIGIN`, never by redirect, so a Company that fetches `client_id`
 * gets a document whose `client_id` equals the URL it fetched.
 */
export async function handleIdentityRoute(
  request: Request,
  env: Env
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!IDENTITY_PATHS.includes(url.pathname)) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const identity = readIdentity(env);
  if (url.origin !== identity.origin) return notFound();
  const body =
    url.pathname === "/poppy/client.json" ? clientMetadata(env) : { keys: (await readSigningKeys(env)).map((key) => key.publicJwk) };
  return Response.json(body, { headers: { "Cache-Control": PUBLIC_CACHE } });
}
