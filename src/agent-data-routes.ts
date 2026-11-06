import { array, object, string, tryDecode } from "./decode";
import { agentNameFor, clearSession, type BrowserIdentity } from "./session";

type Authorize = (request: Request, env: Env, allowDeleting?: boolean) => Promise<BrowserIdentity>;

const MAX_WAIVERS = 64;
const MAX_REQUEST_BYTES = 8192;
const deletionRequest = object({ abandonRevocations: array(string) });

/** The credentials the person agreed to abandon. An empty body abandons none; a malformed one must not delete anything. */
async function waivers(request: Request): Promise<readonly string[] | null> {
  const body = await request.text();
  if (body === "") return [];
  if (body.length > MAX_REQUEST_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  const decoded = tryDecode(deletionRequest, parsed, "deletion request");
  return decoded.ok && decoded.value.abandonRevocations.length <= MAX_WAIVERS ? decoded.value.abandonRevocations : null;
}

/** Personal-data routes are kept separate from ordinary model and protocol operations. */
export async function handleAgentData(request: Request, env: Env, authorize: Authorize): Promise<Response> {
  if (request.method !== "GET" && request.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
  if (request.method === "DELETE" && (request.headers.get("Origin") !== new URL(request.url).origin || request.headers.get("X-PDA-Delete") !== "delete-my-agent")) {
    return new Response("Confirm deletion from Settings on this origin", { status: 403 });
  }
  const identity = await authorize(request, env, request.method === "DELETE");
  const agent = env.PersonalAgent.getByName(await agentNameFor(identity));
  if (request.method === "GET") return new Response(await agent.exportData(identity), { headers: {
    "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="pda-personal-data.json"',
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"
  } });
  const abandoned = await waivers(request);
  if (abandoned === null) return new Response("Invalid deletion request", { status: 400 });
  const receipt = crypto.randomUUID();
  try {
    const result = await agent.deleteData(identity, receipt, abandoned);
    return Response.json({ error: result.reason ?? "Company access has not been revoked. Your local data is retained.", unrevoked: result.unrevoked }, { status: 409, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Erasure aborts the object to clear its caches. Only its durable receipt establishes success.
    const reopened = env.PersonalAgent.getByName(await agentNameFor(identity));
    if (!await reopened.deletionCompleted(receipt)) throw error;
  }
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearSession(), "Cache-Control": "no-store", "Clear-Site-Data": '"cache", "storage"' } });
}
