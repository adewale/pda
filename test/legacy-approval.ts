/**
 * Compatibility fixture for local approvals stored before task requests used
 * Company terms directly. These tests still exercise the production decoder,
 * dispatch, withdrawal and recovery paths; this helper never approves a card.
 * New protocol journeys use agent-helpers.tool, not this fixture.
 */
import { runInDurableObject } from "cloudflare:test";
import { CheckedApiRequest, listMcpTools } from "../src/poppy/apis";
import { proposeLocal } from "../src/poppy/operations";
import { intent } from "../src/poppy/store";
import { randomId } from "../src/poppy/jwt";
import { json } from "../src/decode";
import { isObject } from "../src/poppy/json";
import { PoppyError } from "../src/poppy/client";
import { tool, type Agent } from "./agent-helpers";

export async function legacyTool(a: Pick<Agent, "stub">, name: string, args: Record<string, unknown>, callId: string = crypto.randomUUID()) {
  if (name !== "poppy_api_call" && name !== "poppy_mcp_call") return tool(a, name, args, callId);
  const result = await runInDurableObject(a.stub, async instance => {
    try {
    const client = instance.poppy.client;
    const company = await client.company(String(args.domain));
    const label = typeof args.session === "string" ? args.session : "main";
    const apiUrl = typeof args.api === "string" ? args.api : undefined;
    let request;
    let summary: string;
    if (name === "poppy_api_call") {
      const checked = await CheckedApiRequest.check(client, company, {
        operation: String(args.operation), apiUrl,
        params: args.params as Record<string, string | number | boolean> | undefined,
        ...(args.body !== undefined ? { body: json(args.body, "body") } : {}),
        ...(args.files !== undefined ? { files: args.files as Record<string, string> } : {}),
        idempotencyKey: () => intent(client.sql, `legacy-idem|${callId}`, () => crypto.randomUUID())
      });
      if (checked.method === "GET" || checked.attachments.length) return null;
      await client.token(company, { label });
      const session = client.session(company.issuer, label)!;
      request = { kind: "openapi" as const, call: checked.call, method: checked.method, url: checked.url, binding: { account: session.account, sessionId: session.session_id, authorityGeneration: session.authority_generation } };
      summary = checked.describe();
    } else {
      const tools = await listMcpTools(client, company, label, apiUrl);
      const described = tools.find(item => isObject(item) && item.name === args.tool);
      if (isObject(described) && isObject(described.annotations) && described.annotations.readOnlyHint === true) return null;
      const api = company.apis.find(api => api.type === "mcp" && (!apiUrl || api.url === apiUrl))!;
      await client.token(company, { label, resource: api.url });
      const session = client.session(company.issuer, label)!;
      request = { kind: "mcp" as const, call: { apiUrl: api.url, tool: String(args.tool), args: json(args.args ?? {}, "args") }, binding: { account: session.account, sessionId: session.session_id, authorityGeneration: session.authority_generation } };
      summary = `${company.name}: run ${String(args.tool)} with ${JSON.stringify(args.args ?? {})}`;
    }
    const id = await proposeLocal(client, company, label, summary, request, intent(client.sql, `legacy-approval|${callId}`, () => randomId("apr_")));
    const result = JSON.stringify({ proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." });
    return { text: result, details: result, isError: false };
    } catch (error) {
      if (!(error instanceof PoppyError)) throw error;
      return { text: `${error.message} [${error.code}]`, details: JSON.stringify({ error: error.code }), isError: true };
    }
  });
  return result ?? tool(a, name, args, callId);
}
