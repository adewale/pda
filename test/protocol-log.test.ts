import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PROTOCOL_STEPS } from "../src/poppy/protocol-log";
import { PROTOCOL_LOG_LIMIT, type PoppyServerFrame, type ProtocolEntry } from "../src/poppy/wire";
import { agent, cards, company, signInDirect, tool, until, wideEvents, type Agent, type Company } from "./agent-helpers";
import worker from "./worker";

/**
 * The protocol view (src/poppy/protocol-log.ts): each Poppy exchange the
 * agent made with a Company, in order, with its spec section, kept in the
 * agent's own SQLite from a whitelist of fields, bounded per Company, and
 * sent to the page on request. Every mock Company a test creates must
 * record no violations or warnings (agent-helpers.ts).
 */

const ORIGIN = "https://agent.test";

type Frame = Extract<PoppyServerFrame, { type: "poppy.protocol" | "poppy.protocol.index" }>;

const exchange = {
  operation: "POST /orders/{order_id}/exchanges",
  params: { order_id: "ord_7Hk2" },
  body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
};

/** The page's WebSocket, keeping every protocol frame, raw and parsed. */
async function page(a: Agent) {
  const bootstrap = await worker.fetch(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: a.cookie } }), env);
  expect(bootstrap.status).toBe(200);
  const { workspaceId } = await bootstrap.json() as { workspaceId: string };
  const response = await worker.fetch(
    new Request(`${ORIGIN}/ws?workspace=${encodeURIComponent(workspaceId)}`, { headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: a.cookie } }),
    env
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const raw: string[] = [];
  const frames: Frame[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || !event.data.includes('"poppy.protocol')) return;
    raw.push(event.data);
    frames.push(JSON.parse(event.data) as Frame);
  });
  socket.send(JSON.stringify({ type: "poppy.context", locale: "en-GB", time_zone: "Europe/London" }));
  await until(() => frames.some((frame) => frame.type === "poppy.protocol.index"));
  return {
    socket,
    raw,
    frames,
    index: () => frames.filter((frame) => frame.type === "poppy.protocol.index").at(-1)!,
    /** Asks for one Company's log, as the page does when its disclosure opens. */
    async log(key: string) {
      const before = frames.length;
      socket.send(JSON.stringify({ type: "poppy.protocol", key }));
      return until(() => frames.slice(before).find((frame): frame is Extract<Frame, { type: "poppy.protocol" }> => frame.type === "poppy.protocol" && frame.key === key));
    }
  };
}

/** Where each step first appears; -1 if it doesn't. */
function firstOf(log: readonly ProtocolEntry[], step: string): number {
  return log.findIndex((entry) => entry.step === step);
}

describe("the protocol log", () => {
  it("records a full flow in order, each exchange with its spec section: discovery, Session, sign-in, conversation, API call, operation", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_discover", { domain: c.domain });
    await signInDirect(a, c);
    await tool(a, "poppy_message", { domain: c.domain, text: "Hello, is the sale still on?" });
    await tool(a, "poppy_api_call", { domain: c.domain, ...exchange });
    // Only the Company's terms need a decision (Ops 4, 5).
    const terms = await until(async () => (await cards(a)).find((item) => item.kind === "approval" && item.open && item.terms));
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);

    const log = await a.stub.poppyProtocol(c.hosts.issuer);
    const expected: [string, string][] = [
      ["discovery.poppy", "§3"],
      ["discovery.resource", "§3.2"],
      ["discovery.metadata", "§3.2"],
      ["discovery.verdict", "§3"],
      ["signin.direct.state", "§4.2"],
      ["signin.direct.exchange", "§4.2"],
      ["token.refresh", "§4.4"],
      ["conversation.start", "§8.3"],
      ["conversation.opened", "§8.3"],
      ["api.call", "§7"],
      ["operation.approval_required", "Ops §4"],
      ["operation.decided", "Ops §5"],
      ["operation.sent", "Ops §6"]
    ];
    const positions = expected.map(([step]) => firstOf(log, step));
    expect(positions.every((position) => position >= 0), JSON.stringify(log.map((entry) => entry.step))).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    for (const [step, section] of expected) expect(log[firstOf(log, step)]!.section).toBe(section);
    // Every entry's section is the one its step names, and in sequence.
    for (const entry of log) expect(entry.section).toBe(PROTOCOL_STEPS[entry.step as keyof typeof PROTOCOL_STEPS].section);
    expect(log.map((entry) => entry.seq)).toEqual([...log.map((entry) => entry.seq)].sort((x, y) => x - y));

    const at = (step: string) => log[firstOf(log, step)]!;
    expect(at("discovery.poppy")).toMatchObject({ method: "GET", url: `https://${c.domain}/.well-known/poppy.json`, status: 200, outcome: "ok" });
    expect(at("discovery.resource")).toMatchObject({ method: "GET", url: `https://${c.domain}/.well-known/oauth-protected-resource`, status: 200 });
    expect(at("discovery.verdict").result).toMatch(/^(valid|invalid): \d+ errors?, \d+ warnings?, \d+ info · used by our client/);
    // No Session request: the agent makes its Sessions itself (5.2).
    expect(log.some((entry) => entry.step.startsWith("session."))).toBe(false);
    expect(at("signin.direct.exchange")).toMatchObject({ method: "POST", url: c.hosts.tokenEndpoint, status: 200, outcome: "ok" });
    expect(at("signin.direct.exchange").summary).toBe("Exchange the authorization code: authorization_code grant with the PKCE verifier and redirect_uri, client assertion, DPoP proof");
    expect(at("signin.direct.exchange").result).toContain("refresh token issued");
    expect(log.filter((entry) => entry.step === "signin.direct.state").map((entry) => entry.result).at(-1)).toBe("stored → done");
    expect(at("token.refresh").summary).toBe("Get an access token: refresh_token grant, client assertion, DPoP proof");
    expect(at("conversation.start").summary).toMatch(/^Start a conversation, message msg_[\w-]+ author agent with text, context, wait \d+ s · Session header and DPoP token$/);
    // An API call is named by its operation and path template, not the values filled in.
    expect(at("api.call")).toMatchObject({ method: "POST", url: `${c.hosts.api}/orders/{order_id}/exchanges`, status: 403 });
    expect(at("api.call").summary).toBe("exchangeItem (POST /orders/{order_id}/exchanges), Idempotency-Key · Session header and DPoP token");
    expect(at("api.call").result).toBe("403 approval_required");
    expect(at("operation.approval_required").result).toBe("Shown to the User on an approval card");
    expect(at("operation.decided").result).toBe("Approved by the User, on their card: sending the approval");
    // The same request again, with the approval of the revision the User saw (Ops 6).
    const operationId = /Operation (\S+) revision (\S+)/.exec(at("operation.approval_required").summary)!;
    expect(at("operation.sent")).toMatchObject({ method: "POST", url: `${c.hosts.api}/orders/{order_id}/exchanges`, status: 201 });
    expect(at("operation.sent").summary).toBe(`exchangeItem (POST /orders/{order_id}/exchanges), Idempotency-Key, approval of ${operationId[1]} revision ${operationId[2]} · Session header and DPoP token`);
    // URLs are origin and path only.
    for (const entry of log) if (entry.url) expect(entry.url).not.toMatch(/[?#]/);

    // The index names the Company once, with its count and newest entry.
    const index = await a.stub.poppyProtocolIndex();
    expect(index).toEqual([expect.objectContaining({ key: c.hosts.issuer, issuer: c.hosts.issuer, count: log.length, lastSeq: log.at(-1)!.seq })]);
  });

  it("records a Company discovery refused under its domain, with the validator's verdict and what it refused", async () => {
    const c = await company({ organizationDomain: "other.shop.test" });
    const a = await agent();
    expect((await tool(a, "poppy_discover", { domain: c.domain })).isError).toBe(true);
    const index = await a.stub.poppyProtocolIndex();
    // Keyed by the domain's https origin, which joins the log of an issuer at that origin; shown by its host.
    expect(index.map((entry) => entry.key)).toEqual([`https://${c.domain}`]);
    expect(index[0]).toMatchObject({ issuer: null, company: c.domain, domain: c.domain });
    const log = await a.stub.poppyProtocol(`https://${c.domain}`);
    expect(log.map((entry) => entry.step)).toEqual(["discovery.poppy", "discovery.resource", "discovery.metadata", "discovery.verdict"]);
    expect(log[3]).toMatchObject({ outcome: "refused", section: "§3", title: "Validator" });
    expect(log[3]!.result).toMatch(/^invalid: [1-9]\d* errors?, .* · refused by our client \([\w.-]+/);
  });

  it("says why discovery got no answer, under the domain's https origin", async () => {
    const c = await company();
    const a = await agent();
    await a.stub.poppyFault({ method: "GET", url: `${c.domain}/.well-known/poppy.json`, mode: "lose" });
    expect((await tool(a, "poppy_discover", { domain: c.domain })).isError).toBe(true);
    const log = await a.stub.poppyProtocol(`https://${c.domain}`);
    expect(log[0]).toMatchObject({ step: "discovery.poppy", outcome: "failed", result: "No answer (network)" });
  });

  it("records DPoP nonce retries, Retry-After waits and Session restarts as their own exchanges", async () => {
    const c = await company({ requireNonce: true, nonceScope: "origin", rateLimit: { tokenRequests429: 0, requests429: 1, retryAfterSeconds: 1 } });
    const a = await agent();
    // Signed in, so the token endpoint and the API both take DPoP proofs, and ask for nonces (4.5).
    await signInDirect(a, c);
    const call = () => tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } });
    expect((await call()).isError).toBe(false);
    expect(await c.stub.endAllSessions()).toBe(1);
    expect((await call()).isError).toBe(false);
    const log = await a.stub.poppyProtocol(c.hosts.issuer);
    const retries = log.filter((entry) => entry.outcome === "retry");

    // The first token request is told to use a nonce, and sent again with one.
    const nonce = retries.find((entry) => entry.step === "signin.direct.exchange" && entry.error === "use_dpop_nonce")!;
    expect(nonce.result).toBe("400 use_dpop_nonce: sending again with the Company's DPoP-Nonce and a new proof");
    expect(log[log.indexOf(nonce) + 1]).toMatchObject({ step: "signin.direct.exchange", outcome: "ok" });
    expect(log[log.indexOf(nonce) + 1]!.summary).toContain("DPoP proof with nonce");

    // A 429 with Retry-After: the wait, then the request again, with a new Session JWT (5.2: each jti once).
    const limited = retries.find((entry) => entry.status === 429)!;
    expect(limited.result).toBe("429: Retry-After 1 s: waiting, then sending again with a new Session JWT");
    // Then the API's own nonce, and the answer.
    expect(log.slice(log.indexOf(limited) + 1).map((entry) => `${entry.step} ${entry.status} ${entry.error ?? ""}`.trim()).slice(0, 2)).toEqual([
      "api.call 401 use_dpop_nonce",
      "api.call 200"
    ]);

    // The Company ended the Session: a new Session, then the call again, once (5.5).
    const restart = retries.find((entry) => entry.error === "invalid_session")!;
    expect(restart).toMatchObject({ step: "api.call", section: "§7" });
    expect(restart.result).toBe("400 invalid_session: starting a new Session, then sending again once");
    expect(log.slice(log.indexOf(restart) + 1).find((entry) => entry.step === "api.call")).toMatchObject({ status: 200, outcome: "ok" });
  });

  it("keeps the newest rows of each Company, pruning the oldest", async () => {
    const a = await agent();
    await a.stub.poppyProtocolIndex();
    const insert = (key: string, count: number) =>
      a.stub.poppySql(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result) SELECT ?, ?, i, 'api.call', 'ok', 'call ' || i, '200' FROM n`,
        count,
        key,
        key
      );
    await insert("https://auth.other.test", 3);
    await insert("https://auth.busy.test", PROTOCOL_LOG_LIMIT + 120);
    const busy = await a.stub.poppyProtocol("https://auth.busy.test");
    expect(busy).toHaveLength(PROTOCOL_LOG_LIMIT);
    expect(busy[0]!.summary).toBe("call 121");
    expect(busy.at(-1)!.summary).toBe(`call ${PROTOCOL_LOG_LIMIT + 120}`);
    // Another Company's rows are its own.
    expect(await a.stub.poppyProtocol("https://auth.other.test")).toHaveLength(3);
    const index = await a.stub.poppyProtocolIndex();
    expect(index.map((entry) => [entry.key, entry.count])).toEqual([
      ["https://auth.busy.test", PROTOCOL_LOG_LIMIT],
      ["https://auth.other.test", 3]
    ]);
  });
});

/**
 * No secret can enter the log: the flows the other secret checks use (Direct,
 * Device and Mediated Sign-In with a one-time code, conversations, an
 * operation, MCP with a Bearer token, signing out), with every secret that
 * crossed the wire collected by the test's fetcher (tokens, proofs,
 * assertions, codes, verifiers, sign-in values, session ids, cookies), plus
 * the `state` and code of the Direct Sign-In; none may be in a row or a frame.
 */
describe("secrets and the protocol log", () => {
  /** Every value that must stay out, longest first; short ones are matched as whole words. */
  async function secretsOf(a: Agent, extra: string[]): Promise<string[]> {
    const found = new Set([...(await a.stub.poppyWireSecrets()), ...extra]);
    for (const query of ["SELECT token AS value FROM poppy_accounts", "SELECT secret AS value FROM poppy_signins", "SELECT state_hash AS value FROM poppy_signins WHERE state_hash IS NOT NULL"]) {
      for (const row of JSON.parse(await a.stub.poppySql(query)) as { value: string }[]) found.add(row.value);
    }
    return [...found].filter((value) => value.length >= 6).sort((x, y) => y.length - x.length);
  }

  function leaks(text: string, secrets: readonly string[]): string[] {
    return secrets.filter((secret) =>
      secret.length >= 12 ? text.includes(secret) : new RegExp(`(^|[^A-Za-z0-9_-])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(text)
    );
  }

  async function flows(c: Company, a: Agent): Promise<string[]> {
    const extra: string[] = [];
    // Direct Sign-In: its state and code travel in the browser's URLs, not ours.
    const signedIn = (await signInDirect(a, c))!;
    const location = new URL(signedIn.location);
    extra.push(location.searchParams.get("code")!, location.searchParams.get("state")!);
    await tool(a, "poppy_message", { domain: c.domain, text: "Hello, is the sale still on?" });
    await tool(a, "poppy_api_call", { domain: c.domain, ...exchange });
    // Our card, then the Company's terms (Ops 4, 5, 6).
    for (let decided = 0; decided < 2; decided++) {
      const open = (await cards(a)).find((item) => item.kind === "approval" && item.open);
      if (!open) break;
      await a.stub.poppyFrame({ type: "poppy.approval", approvalId: open.approvalId, decision: "approve" });
    }
    expect((await c.stub.state()).performs).toBe(1);
    await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } });
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    return extra;
  }

  it("never holds or sends a token, assertion, proof, code, verifier, state, session id or sign-in value", async () => {
    const extra: string[] = [];
    // One Company for Direct Sign-In and the rest, one for Device, one for Mediated with a one-time code.
    const direct = await company({ requireNonce: true, nonceScope: "origin" });
    const device = await company({ signIn: { direct: null, device: ["orders:read"], mediated: null } });
    const mediated = await company({ signIn: { direct: null, device: null, mediated: ["orders:read"] } });
    const a = await agent();
    // Everything written to the console from here: every wide event the flows make (src/log.ts).
    const logMark = await a.stub.poppyLogMark();
    extra.push(...(await flows(direct, a)));

    await tool(a, "poppy_sign_in", { domain: device.domain, scopes: ["orders:read"], reason: "To see your orders" });
    const code = (await cards(a)).find((item) => item.kind === "signin_device")!;
    extra.push(code.userCode);
    await a.stub.poppyAdvance(1000);
    await device.stub.approveDevice(code.userCode, { account: "acct_ada" });
    await a.stub.poppyAdvance(1000);
    await a.stub.poppyWaitForNotice(`Signed in to Mock Shop ${device.id}`);

    await tool(a, "poppy_sign_in", { domain: mediated.domain, scopes: ["orders:read"], reason: "test" });
    const form = (await cards(a)).find((item) => item.kind === "signin_credentials")!;
    const values = { email: "grace@example.com", password: "battery staple" };
    extra.push(values.email, values.password);
    await a.stub.poppyFrame({ type: "poppy.credentials", signInId: form.signInId, values });
    const oneTime = (await mediated.stub.lastOneTimeCode())!;
    extra.push(oneTime);
    await a.stub.poppyFrame({ type: "poppy.code", signInId: form.signInId, code: oneTime });
    expect(JSON.parse((await tool(a, "poppy_status", { domain: mediated.domain })).text).sessions[0].signedIn).toBe(true);

    const secrets = await secretsOf(a, extra);
    // The fetcher saw them: Bearer and DPoP tokens, proofs, assertions, codes, the password.
    expect(secrets.length).toBeGreaterThan(20);
    expect(secrets).toContain("battery staple");
    expect(secrets).toContain(oneTime);

    // Every row of the table, every column.
    const rows = await a.stub.poppySql("SELECT * FROM poppy_protocol_log");
    expect(JSON.parse(rows).length).toBeGreaterThan(30);
    expect(leaks(rows, secrets)).toEqual([]);
    // The mediated sign-in's code went to the token endpoint, as a grant (MSI §4): its URL holds nothing to hide.
    const log = await a.stub.poppyProtocol(mediated.hosts.issuer);
    expect(log.find((entry) => entry.step === "signin.mediated.code")!.url).toBe(mediated.hosts.tokenEndpoint);
    expect(log.find((entry) => entry.step === "signin.mediated.credentials")!.summary).toBe("Send the sign-in form: 2 fields, values never recorded, scope orders:read, client assertion, DPoP proof");
    for (const step of ["signin.device.start", "signin.device.poll"]) {
      expect((await a.stub.poppyProtocol(device.hosts.issuer)).some((entry) => entry.step === step)).toBe(true);
    }
    expect((await a.stub.poppyProtocol(direct.hosts.issuer)).some((entry) => entry.step === "account.revoke" && entry.section === "§4.6")).toBe(true);
    const mcpCalls = (await a.stub.poppyProtocol(direct.hosts.issuer)).filter((entry) => entry.step === "mcp.call").map((entry) => entry.summary);
    expect(mcpCalls.some((summary) => summary.endsWith("Session header and Bearer token")), JSON.stringify(mcpCalls)).toBe(true);

    // The frames the page gets: the index on connect, and each Company's log when asked.
    const p = await page(a);
    const keys = p.index().type === "poppy.protocol.index" ? (p.index() as Extract<Frame, { type: "poppy.protocol.index" }>).companies.map((entry) => entry.key) : [];
    expect(keys.sort()).toEqual([device.hosts.issuer, direct.hosts.issuer, mediated.hosts.issuer].sort());
    for (const key of keys) expect((await p.log(key)).entries.length).toBeGreaterThan(0);
    expect(leaks(p.raw.join("\n"), secrets)).toEqual([]);
    expect(p.raw.join("\n")).not.toMatch(/"(token|secret|state_hash|device_code|code_verifier|password|assertion|access_token|refresh_token)"/);
    p.socket.close();

    // The operator's logs and the User's "Copy diagnostics" (src/log.ts, src/agent-log.ts): the same flows, and none of it.
    const logs = (await a.stub.poppyLogsSince(logMark)).join("\n");
    const events = await wideEvents(a, logMark);
    expect(events.filter((event) => event.kind === "turn").length).toBeGreaterThan(0);
    expect(events.filter((event) => event.kind === "job").length).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "turn" && event.poppy?.requests > 0 && String(event.poppy_issuers).includes(direct.hosts.issuer))).toBe(true);
    expect(events.some((event) => event.kind === "ws" && event.frame === "poppy.credentials")).toBe(true);
    const diagnostics = await a.stub.diagnostics();
    expect(diagnostics).toContain("Poppy protocol log");
    // What the User and the model said, and tool arguments' free text, too: none of it is in an event.
    const said = ["Where is my order?", "stormline-insulated-m", "jacket", a.identity.email!, a.identity.sub];
    for (const text of [logs, diagnostics]) {
      expect(leaks(text, secrets)).toEqual([]);
      expect(said.filter((words) => text.includes(words))).toEqual([]);
    }
  });
});
