/**
 * The official kit's schemas as an oracle for what our agent sends (V0 in
 * docs/poppy-0.4-upgrade.md). agent-helpers runs it after every test; this
 * file shows that it sees each kind of payload, and that it refuses a
 * broken one, so a clean run means something.
 */
import { describe, expect, it } from "vitest";
import { agent, cards, company, signInDirect, tool, until } from "./agent-helpers";
import { kitSchemaErrors, kitSchemasApplied, parseDictionary } from "./kit-schemas";
import type { AgentPayload, MockConfig } from "./mock-company/types";

const V3: Partial<MockConfig> = { protocolVersion: "0.3" };
const SCOPES = ["orders:read", "orders:write"];

async function sentTo(c: Awaited<ReturnType<typeof company>>): Promise<AgentPayload[]> {
  return (await c.stub.state()).sent.map((payload) => JSON.parse(payload) as AgentPayload);
}

describe("the kit's schemas judge what the agent sends", () => {
  it("checks the client metadata, Session JWTs, delegations, conversation bodies and every kind of approval", async () => {
    const approve = async (call: (a: Awaited<ReturnType<typeof agent>>, domain: string) => Promise<unknown>) => {
      const c = await company(V3);
      const a = await agent();
      await signInDirect(a, c, SCOPES);
      await call(a, c.domain);
      const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
      await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
      expect((await c.stub.state()).performs).toBe(1);
      return sentTo(c);
    };
    const sent = [
      ...(await approve((a, domain) => tool(a, "poppy_message", { domain, text: "Please exchange the jacket on my order" }))),
      ...(await approve((a, domain) => tool(a, "poppy_api_call", { domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } }))),
      ...(await approve((a, domain) => tool(a, "poppy_mcp_call", { domain, tool: "exchange_item", args: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } })))
    ];
    expect(kitSchemasApplied(sent)).toEqual([
      "approval.schema.json",
      "client-metadata.schema.json",
      "conversation-message-request.schema.json",
      "conversation-request.schema.json",
      "delegation.schema.json",
      "session-jwt.schema.json"
    ]);
    expect(sent.some((payload) => payload.approval !== undefined)).toBe(true);
    expect(sent.some((payload) => payload.method === "POST" && new URL(payload.url).pathname === "/mcp" && JSON.stringify(payload.json).includes("personalagentprotocol.org/approval"))).toBe(true);
    expect(kitSchemaErrors(sent)).toEqual([]);

    // The same payloads, each broken the way a regression would break it.
    const first = <T,>(pick: (payload: AgentPayload) => T | undefined): T => sent.map(pick).find((value) => value !== undefined)!;
    const jwt = first((payload) => payload.sessionJwt && payload);
    const metadata = first((payload) => payload.clientMetadata !== undefined ? payload : undefined);
    const approval = first((payload) => payload.approval !== undefined ? payload : undefined);
    const message = first((payload) => payload.method === "POST" && /\/messages$/.test(payload.url) ? payload : undefined);
    const { sid: _sid, ...withoutSid } = jwt.sessionJwt!.payload;
    const { jwks_uri: _jwks, ...withoutJwks } = metadata.clientMetadata as Record<string, unknown>;
    const tampered: [AgentPayload, RegExp][] = [
      [{ ...jwt, delegation: undefined, sessionJwt: { ...jwt.sessionJwt!, payload: withoutSid } }, /Session JWT .*\(session-jwt\.schema\.json\)/],
      [{ ...jwt, sessionJwt: undefined, delegation: { ...jwt.delegation!, header: { ...jwt.delegation!.header, typ: "JWT" } } }, /delegation .*\(delegation\.schema\.json\)/],
      [{ ...metadata, clientMetadata: withoutJwks }, /client metadata .*\(client-metadata\.schema\.json\)/],
      [{ method: approval.method, url: approval.url, approval: approval.approval!.replace(/revision="[^"]*"/, "revision=7") }, /Poppy-Approval .*\(approval\.schema\.json\) \/revision/],
      [{ method: message.method, url: message.url, json: {} }, /body of POST .*\(conversation-message-request\.schema\.json\)/]
    ];
    for (const [payload, error] of tampered) {
      const errors = kitSchemaErrors([payload]);
      expect(errors.length, JSON.stringify(payload)).toBeGreaterThan(0);
      expect(errors.every((line) => error.test(line)), errors.join("\n")).toBe(true);
    }
  });
});

describe("RFC 9651 Dictionaries for Poppy-Approval", () => {
  it("keeps Strings, Integers, Tokens and Booleans, and drops parameters", () => {
    expect(parseDictionary(`operation_id="exc_5Rt2", revision="r\\"1", approved_at=1791487260, input_type="tap", flag, t=tok;p=1`)).toEqual({
      operation_id: "exc_5Rt2",
      revision: 'r"1',
      approved_at: 1791487260,
      input_type: "tap",
      flag: true,
      t: "tok"
    });
  });

  it("refuses what isn't a Dictionary", () => {
    for (const field of [`Operation_id="x"`, `a="unterminated`, `a="x",`, `a="x" b="y"`, `a=1234567890123456`, `a="é"`]) {
      expect(parseDictionary(field), field).toBeNull();
    }
  });
});
