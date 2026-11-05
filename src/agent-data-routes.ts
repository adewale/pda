import { agentNameFor, clearSession, type BrowserIdentity } from "./session";

type Authorize = (request: Request, env: Env, allowDeleting?: boolean) => Promise<BrowserIdentity>;

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
  const receipt = crypto.randomUUID();
  try {
    const result = await agent.deleteData(identity, receipt);
    return Response.json({ error: result.reason ?? "Company access has not been revoked. Your local data is retained so revocation can be retried.", companies: result.companies }, { status: 409, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Erasure aborts the object to clear its caches. Only its durable receipt establishes success.
    const reopened = env.PersonalAgent.getByName(await agentNameFor(identity));
    if (!await reopened.deletionCompleted(receipt)) throw error;
  }
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearSession(), "Cache-Control": "no-store", "Clear-Site-Data": '"cache", "storage"' } });
}
