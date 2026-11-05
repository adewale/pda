import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLive } from "./check-live.mjs";

const origin = "https://agent.example";
function deployment(overrides = {}) {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ url: input, ...init });
    const path = new URL(input).pathname;
    if (path === "/api/build-info") return Response.json({ commit: "abc1234", dirty: false, workerVersion: "test-worker-version", ...overrides });
    if (path === "/poppy/client.json") return Response.json({ client_id: origin + path });
    if (path === "/poppy/jwks.json") return Response.json({ keys: [{ kty: "EC", kid: "public" }] });
    if (path === "/api/sign-in-options") return Response.json({ providers: ["google", "github"] });
    if (path.startsWith("/auth/")) {
      const provider = path.split("/").at(-1);
      const host = provider === "google" ? "accounts.google.com" : "github.com";
      return new Response(null, { status: 303, headers: { Location: `https://${host}/authorize?redirect_uri=${encodeURIComponent(origin + path + "/callback")}&state=DO_NOT_FOLLOW` } });
    }
    if (path === "/api/me" || path === "/api/agent-data") return new Response(null, { status: 401 });
    return new Response("Public page", { headers: { "Content-Security-Policy": "default-src 'self'" } });
  };
  return { calls, fetcher };
}

test("public preflight verifies provenance and never follows OAuth or sends a business request", async () => {
  const { calls, fetcher } = deployment();
  const result = await checkLive({ origin, expectedCommit: "abc1234abcdef" }, fetcher);
  assert.equal(result.passed, true);
  assert.equal(result.authenticatedJourneyVerified, false);
  assert.ok(calls.every(call => call.url.startsWith(origin + "/") && call.method === undefined && call.redirect === "manual"));
  assert.ok(!JSON.stringify(result).includes("DO_NOT_FOLLOW"));
});

test("public preflight rejects dirty or mismatched deployments before claiming a pass", async () => {
  for (const provenance of [{ dirty: true }, { commit: "deadbee" }]) {
    await assert.rejects(checkLive({ origin, expectedCommit: "abc1234" }, deployment(provenance).fetcher));
  }
});
