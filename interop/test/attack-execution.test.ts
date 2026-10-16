/** Replay execution and evidence, using real signed requests and recording fetchers. */
import { base64url, decodeJwt, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { Company } from "../../src/poppy/discovery.ts";
import { toIssuer } from "../../src/poppy/issuer.ts";
import { AttackSetupError, runAttack } from "../impls/pda-agent/attacks.ts";
import { runCell, toReply, type Driver } from "../runner/cell.ts";
import { loadScenarios } from "../runner/cli.ts";
import { assertTrace } from "../runner/traces.ts";
import { recording, NOW, TOKEN, type Spec } from "./helpers.ts";

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
      records.push({ at: Date.now() - NOW * 1000, url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text(), status, response, responseHeaders });
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

describe("YA audience mutation", () => {
  it.each(["same audience", "changed issuer", "reused client jti", "reused Session assertion", "reused proof", "wrong nonce", "changed assertion type", "no accepted baseline"])(
    "refuses misleading wire evidence: %s", async (fault) => {
      const { records } = await execute("YA", [200, 401], ["", "invalid_client"], ["n1"]);
      const fields = new URLSearchParams(records[1]!.body);
      const original = new URLSearchParams(records[0]!.body);
      // Trace predicates inspect claims; real signature validity is covered
      // separately against AuthServer in properties/attacks.test.ts.
      const changeClaims = (jwt: string, patch: Record<string, unknown>) => {
        const [header, , signature] = jwt.split(".");
        return `${header}.${base64url.encode(JSON.stringify({ ...decodeJwt(jwt), ...patch }))}.${signature}`;
      };
      const client = fields.get("client_assertion")!;
      if (fault === "same audience") fields.set("client_assertion", changeClaims(client, { aud: TOKEN }));
      if (fault === "changed issuer") fields.set("client_assertion", changeClaims(client, { iss: "https://other.agent.interop.test/client.json" }));
      if (fault === "reused client jti") fields.set("client_assertion", changeClaims(client, { jti: decodeJwt(original.get("client_assertion")!).jti }));
      if (fault === "reused Session assertion") fields.set("assertion", original.get("assertion")!);
      if (fault === "reused proof") records[1]!.headers!.dpop = records[0]!.headers!.dpop!;
      if (fault === "wrong nonce") records[1]!.headers!.dpop = changeClaims(records[1]!.headers!.dpop!, { nonce: "wrong" });
      if (fault === "changed assertion type") fields.set("client_assertion_type", "wrong");
      if (fault === "no accepted baseline") records[0]!.status = 400;
      records[1]!.body = fields.toString();
      expect(assertTrace(recording(...records), { check: "attack_observed", mutation: "client_audience" }).kind).toBe("failed");
    });

  it("negotiates a nonce before sending fresh credentials with only the client audience wrong", async () => {
    const { result, records } = await execute("YA", [400, 200, 401], ["use_dpop_nonce", "", "invalid_client"], ["n1"]);
    expect(result.outcome).toBe("pass");
    expect(records).toHaveLength(3);
    const forms = records.map((record) => new URLSearchParams(record.body));
    const clients = forms.map((fields) => decodeJwt(fields.get("client_assertion")!));
    expect(clients[1]!.aud).toBe(TOKEN);
    expect(clients[2]!.aud).toBe("https://auth.other.company.interop.test/oauth/token");
    expect(new Set(clients.map((claims) => claims.jti)).size).toBe(3);
    expect(decodeJwt(records[2]!.headers!.dpop!).nonce).toBe("n1");
    expect(forms[2]!.get("assertion")).not.toBe(forms[1]!.get("assertion"));
  });

  it("reports repeated nonce challenges during setup as an error rather than audience protection", async () => {
    const { result, records } = await execute("YA", [400, 400, 400], Array(3).fill("use_dpop_nonce"), ["n1", "n2", "n3"]);
    expect(result.outcome).toBe("error");
    expect(records).toHaveLength(3);
  });

  it("leaves nonce-only rejection of the mutation unsupported", async () => {
    expect((await execute("YA", [200, 400], ["", "use_dpop_nonce"], ["n1", "n2"])).result.outcome).toBe("unsupported");
  });

  it.each([[200, ""], [500, "server_error"], [400, "invalid_grant"], [401, "invalid_dpop_proof"]] as const)(
    "fails for an unrelated outcome: HTTP %s %s", async (status, error) => {
      expect((await execute("YA", [200, status], ["", error])).result.outcome).toBe("fail");
    });

  it("requires an accepted baseline and refuses a single nonce challenge as attack evidence", () => {
    const trace = recording({ url: TOKEN, method: "POST", status: 400, response: { error: "use_dpop_nonce" } });
    expect(assertTrace(trace, { check: "attack_observed", mutation: "client_audience" }).kind).toBe("failed");
  });
});

describe("attack evidence excludes unrelated credential failures", () => {
  it("keeps assertion lifetimes at 60 seconds when the clock crosses second boundaries", async () => {
    const start = Date.now();
    let ticks = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => start + ticks++ * 1_000);
    try {
      const { result, records } = await execute("YA", [200, 401], ["", "invalid_client"]);
      expect(result.outcome).toBe("pass");
      for (const record of records) for (const field of ["assertion", "client_assertion"]) {
        const claims = decodeJwt(new URLSearchParams(record.body).get(field)!);
        expect(claims.exp! - claims.iat!).toBe(60);
      }
    } finally { clock.mockRestore(); }
  });
  for (const id of ["YA", "YR", "YD"] as const) {
    it.each(["expired", "future", "overlong", "missing expiry", "assertion type", "expired Session", "stale proof"] as const)(`${id}: excludes %s as a second rejection cause`, async (fault) => {
      const error = id === "YA" ? "invalid_client" : id === "YR" ? "invalid_grant" : "invalid_dpop_proof";
      const { records } = await execute(id, [200, id === "YA" ? 401 : 400], ["", error]);
      const fields = new URLSearchParams(records[1]!.body);
      const credential = fault === "expired Session" ? fields.get("assertion")! : fault === "stale proof" ? records[1]!.headers!.dpop! : fields.get("client_assertion")!;
      const [header, , signature] = credential.split(".");
      const claims = { ...decodeJwt(credential) };
      const at = Math.floor(Date.now() / 1000);
      if (fault === "expired") { claims.iat = at - 120; claims.exp = at - 60; }
      if (fault === "future") { claims.iat = at + 60; claims.exp = at + 120; }
      if (fault === "overlong") claims.exp = at + 3_600;
      if (fault === "missing expiry") delete claims.exp;
      if (fault === "expired Session") { claims.iat = at - 120; claims.exp = at - 60; }
      if (fault === "stale proof") claims.iat = at - 120;
      const changed = `${header}.${base64url.encode(JSON.stringify(claims))}.${signature}`;
      if (fault === "stale proof") {
        records[1]!.headers!.dpop = changed;
        if (id === "YD") records[0]!.headers!.dpop = changed; // retain the exact replay premise
      } else if (fault === "expired Session") {
        fields.set("assertion", changed);
        if (id === "YR") {
          const baseline = new URLSearchParams(records[0]!.body);
          baseline.set("assertion", changed);
          records[0]!.body = baseline.toString();
        }
      } else fields.set("client_assertion", changed);
      if (fault === "assertion type") fields.set("client_assertion_type", "wrong");
      records[1]!.body = fields.toString();
      const params = id === "YA" ? { mutation: "client_audience" } : { replay: id === "YR" ? "assertion" : "dpop" };
      expect(assertTrace(recording(...records), { check: "attack_observed", ...params }).kind).toBe("failed");
      expect(assertTrace(recording(...records), { check: id === "YA" ? "audience_rejected" : "replay_rejected", ...params }).kind).toBe("failed");
    });
  }
});
