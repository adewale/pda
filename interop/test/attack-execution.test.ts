/** Replay execution and evidence, using real signed requests and recording fetchers. */
import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import type { Company } from "../../src/poppy/discovery.ts";
import { toIssuer } from "../../src/poppy/issuer.ts";
import { AttackSetupError, runAttack } from "../impls/pda-agent/attacks.ts";
import { runCell, toReply, type Driver } from "../runner/cell.ts";
import { loadScenarios } from "../runner/cli.ts";
import { assertTrace } from "../runner/traces.ts";
import { recording, TOKEN, type Spec } from "./helpers.ts";

const company: Company = {
  issuer: toIssuer("https://auth.acme.company.interop.test"), domain: "acme.company.interop.test", name: "Acme", protocolVersion: "0.1",
  endpoints: { token: TOKEN, revocation: "https://auth.acme.company.interop.test/oauth/revoke" },
  signIn: {}, customScopes: {}, apis: [], extensions: {}
};

async function execute(id: string, statuses: readonly number[], errors: readonly string[], nonces: readonly (string | undefined)[] = []) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const key = { ...await exportJWK(privateKey), kid: "attack-key" };
  const records: Spec[] = [];
  const ctx = {
    clientId: "https://evil-agent.agent.interop.test/poppy/client.json", signingJwks: JSON.stringify([key]),
    fetcher: async (request: Request) => {
      const n = records.length;
      if (statuses[n] === undefined) throw new Error("attack made an unexpected extra request");
      const status = statuses[n]!;
      const response = status === 200 ? { access_token: `at_${n}`, session_id: `ses_${n}` } : { error: errors[n] };
      const responseHeaders: Record<string, string> = nonces[n] ? { "dpop-nonce": nonces[n]! } : {};
      records.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text(), status, response, responseHeaders });
      return Response.json(response, { status, headers: responseHeaders });
    }
  };
  const driver: Driver = {
    agent: async (op) => {
      if (op === "arm") return { kind: "ok", result: { armed: id } };
      try {
        const result = await runAttack(ctx, company, id, {});
        return toReply(200, result.poppy_error ? { ok: false, poppy_error: result.poppy_error, status: result.status } : { ok: true, result }, true);
      } catch (error) {
        if (error instanceof AttackSetupError) return toReply(500, { error: "attack_setup_failed", detail: error.message }, true);
        throw error;
      }
    },
    company: async () => { throw new Error("unexpected Company hook"); },
    runner: async (_op, params) => assertTrace(recording(...records), params)
  };
  const scenario = loadScenarios().find((scenario) => scenario.id === id)!;
  return { result: await runCell(scenario, {}, driver), records };
}

for (const [id, rejection] of [["YR", "invalid_grant"], ["YD", "invalid_dpop_proof"]] as const) {
  describe(id, () => {
    it("negotiates a nonce, then replays the accepted credential with the other credentials fresh", async () => {
      const { result, records } = await execute(id, [400, 200, 400], ["use_dpop_nonce", "", rejection], ["n1"]);
      expect(result.outcome).toBe("pass");
      expect(records).toHaveLength(3);
      const forms = records.map((x) => new URLSearchParams(x.body));
      const proofs = records.map((x) => x.headers!.dpop!);
      expect(decodeJwt(proofs[0]!).nonce).toBeUndefined();
      expect(decodeJwt(proofs[1]!).nonce).toBe("n1");
      expect(new Set(forms.map((x) => decodeJwt(x.get("client_assertion")!).jti)).size).toBe(3);
      expect(forms[0]!.get("assertion")).not.toBe(forms[1]!.get("assertion"));
      if (id === "YR") {
        expect(forms[2]!.get("assertion")).toBe(forms[1]!.get("assertion"));
        expect(decodeJwt(proofs[2]!).nonce).toBe("n1");
        expect(decodeJwt(proofs[2]!).jti).not.toBe(decodeJwt(proofs[1]!).jti);
      } else {
        expect(proofs[2]).toBe(proofs[1]);
        expect(forms[2]!.get("assertion")).not.toBe(forms[1]!.get("assertion"));
      }
    });

    it("also exercises replay against a Company that does not require a nonce", async () => {
      const { result, records } = await execute(id, [200, 400], ["", rejection]);
      expect(result.outcome).toBe("pass");
      expect(records).toHaveLength(2);
    });

    it("reports exhausted nonce setup as a harness error, never a pass", async () => {
      const { result, records } = await execute(id, [400, 400, 400], Array(3).fill("use_dpop_nonce"), ["n1", "n2", "n3"]);
      expect(result.outcome).toBe("error");
      expect(records).toHaveLength(3);
      expect(result.reason).toContain("no attack was sent");
    });

    it("fails when the Company accepts the replay", async () => {
      expect((await execute(id, [200, 200], ["", ""])).result.outcome).toBe("fail");
    });

    it("does not count a server error as replay protection", async () => {
      expect((await execute(id, [200, 500], ["", "server_error"])).result.outcome).toBe("fail");
    });

    it("leaves nonce-only rejection visibly unsupported", async () => {
      expect((await execute(id, [200, 400], ["", "use_dpop_nonce"], ["n1", "n2"])).result.outcome).toBe("unsupported");
    });

    it("does not accept a single ordinary token request as attack evidence", () => {
      const ordinary = { url: TOKEN, method: "POST", status: 400, response: { error: rejection } };
      expect(assertTrace(recording(ordinary), { check: "attack_observed", replay: id === "YR" ? "assertion" : "dpop" }).kind).toBe("failed");
    });
  });
}
