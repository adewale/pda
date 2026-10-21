/** Identity host for the unmodified official validator's one-sided lane. */
import { readFileSync } from "node:fs";
const pin = JSON.parse(readFileSync("/repo/spec/upstream.json", "utf8"));
const { keygen } = await import(`/repo/${pin.snapshot}/kit/company/validate/identity.ts`);
import { authorized, json, serve, setting } from "../shared/serve.ts";

const name = process.env.INTEROP_NAME ?? "official-validator";
const secret = setting("INTEROP_SECRET");
const origin = setting("INTEROP_ORIGIN");
await keygen(`${origin}/poppy-test`, { cwd: "/state" });
serve(8080, async (request) => {
  const file = new URL(request.url).pathname.split("/").at(-1);
  return file === "agent.json" || file === "jwks.json"
    ? new Response(readFileSync(`/state/.poppy/${file}`, "utf8"), { headers: { "Content-Type": "application/json" } })
    : json({ error: "not_found" }, 404);
});
serve(8081, async (request) => {
  const path = new URL(request.url).pathname;
  if (path === "/healthz") return json({ ok: true });
  if (!authorized(request, secret)) return json({ error: "unauthorized" }, 401);
  if (path === "/manifest") return json({ interop: 1, name, role: "agent", commit: pin.commit, poppy: [pin.protocolVersion], scenarios: [] });
  if (path === "/hooks") return json([]);
  if (path === "/reset") return json({ ok: true });
  return json({ error: "unsupported" }, 501);
});
