import { readIdentity, readSigningKeys } from "./keys";

/**
 * The client metadata document (spec 4.1). Its URL is our `client_id`: one
 * for 0.1 and 0.2, listing Operations 1, and one for 0.3, listing
 * Operations 2 (keys.ts). Everything else is the same.
 */
export function clientMetadata(env: Env, version: "0.2" | "0.3" = "0.2") {
  const identity = readIdentity(env);
  return {
    client_id: version === "0.3" ? identity.clientId03 : identity.clientId,
    client_name: identity.clientName,
    logo_uri: identity.logoUri,
    jwks_uri: identity.jwksUri,
    redirect_uris: [identity.redirectUri],
    token_endpoint_auth_method: "private_key_jwt",
    extensions: { operations: { version: version === "0.3" ? "2" : "1" } }
  };
}

const IDENTITY_PATHS = ["/poppy/client.json", "/poppy/0.3/client.json", "/poppy/jwks.json"];

const PUBLIC_CACHE = "public, max-age=3600";

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * `GET /poppy/client.json`, `GET /poppy/0.3/client.json` and `GET /poppy/jwks.json`. Served only on
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
    url.pathname === "/poppy/client.json"
      ? clientMetadata(env)
      : url.pathname === "/poppy/0.3/client.json"
        ? clientMetadata(env, "0.3")
        : { keys: (await readSigningKeys(env)).map((key) => key.publicJwk) };
  return Response.json(body, { headers: { "Cache-Control": PUBLIC_CACHE } });
}
