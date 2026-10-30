#!/usr/bin/env node
/** SIGKILL the actual PDA/workerd process group; keep the independent Company process alive. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
// Focus one boundary while retaining the complete default matrix.
const pointIndex = process.argv.indexOf("--point");
const onlyPoint = pointIndex < 0 ? null : process.argv[pointIndex + 1];
if (pointIndex >= 0) assert.ok(onlyPoint, "--point requires a boundary name");
const directory = mkdtempSync(path.join(tmpdir(), "pda-approval-process-crash-"));
const children = new Set();
const results = [];
let serial = 0;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  process.exit(signal === "SIGINT" ? 130 : 143);
});

async function start(settings, role) {
  const child = spawn(process.execPath, [path.join(root, "test/durability/process-runtime.mjs"), settings, role], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  let diagnostics = "";
  child.stdout.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  const pending = new Map();
  const barriers = new Map();
  let ready;
  const started = new Promise((resolve, reject) => {
    ready = resolve;
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Runtime startup failed (${role}): ${diagnostics}`)));
  });
  child.on("message", message => {
    if (message.type === "ready") ready(message);
    if (message.type === "reply") {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error)); else waiting?.resolve(message.value);
    }
    if (message.type === "barrier") barriers.get(message.point)?.();
  });
  child.on("exit", () => {
    children.delete(child);
    for (const waiting of pending.values()) waiting.reject(new Error("Runtime killed"));
    pending.clear();
  });
  const info = await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error(`Runtime startup timed out (${role}): ${diagnostics}`)), 30_000).unref())]);
  const rpc = action => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Runtime command timed out: ${action.action}/${action.method ?? ""}: ${diagnostics}`)); }, 30_000).unref();
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.send({ ...action, id });
  });
  return { child, ...info, rpc, call: (name, method, ...args) => rpc({ action: "call", name, method, args }),
    barrier: point => new Promise((resolve, reject) => { barriers.set(point, resolve); setTimeout(() => reject(new Error(`Barrier ${point} was not reached: ${diagnostics}`)), 20_000).unref(); }) };
}

async function kill(runtime) {
  const exited = once(runtime.child, "exit");
  process.kill(-runtime.child.pid, "SIGKILL");
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
}

try {
  const config = JSON.parse(readFileSync(path.join(root, "test/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  config.name = "pda-process-crash";
  config.main = path.join(root, "test/durability/process-worker.ts");
  const configFile = path.join(directory, "wrangler.json");
  writeFileSync(configFile, JSON.stringify(config));
  const bundle = path.join(directory, "bundle");
  execFileSync(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--config", configFile, "--outdir", bundle], { cwd: root, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  const keys = await Promise.all(["crash-current", "crash-next"].map(async kid => { const { privateKey } = await generateKeyPair("ES256", { extractable: true }); return { ...await exportJWK(privateKey), kid, alg: "ES256", use: "sig" }; }));
  const bindings = { ...config.vars, POPPY_SIGNING_JWKS: JSON.stringify(keys), TOKEN_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"), CF_VERSION_METADATA: { id: "process-crash-fixture" } };
  const sessionFile = path.join(directory, "session.mjs");
  await build({ entryPoints: [path.join(root, "src/session.ts")], outfile: sessionFile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const { createSession, agentNameFor } = await import(pathToFileURL(sessionFile));
  const identity = { provider: "google", sub: "process-crash-user", email: "owner@example.com", domain: null };
  const cookie = (await createSession(identity, bindings.SESSION_SECRET)).split(";", 1)[0];
  const name = await agentNameFor(identity);
  for (const channel of ["openapi", "mcp"]) for (const point of ["before-dispatch", "after-effect", "after-commit", "after-notification"]) {
    if (onlyPoint && point !== onlyPoint) continue;
    const runDirectory = path.join(directory, `${channel}-${point}`);
    const settings = path.join(directory, `${channel}-${point}.json`);
    writeFileSync(settings, JSON.stringify({ config, bindings, cookie, bundle, script: path.join(bundle, "process-worker.js"), persistence: { pda: path.join(runDirectory, "pda"), company: path.join(runDirectory, "company") } }), { mode: 0o600 });
    const company = await start(settings, "company");
    let pda = await start(settings, "pda");
    await company.rpc({ action: "peer", port: pda.port });
    await pda.rpc({ action: "peer", port: company.port });
    await pda.rpc({ action: "authenticate" });
    const companyCall = (method, ...args) => company.call("crash", method, ...args);
    const call = (method, ...args) => pda.call(name, method, ...args);
    await companyCall("configure", { protocolVersion: "0.3", strictAssertions: true, dpopTokens: true });
    const domain = "crash.shop.test";
    const started = await call("poppyTool", "poppy_sign_in", { domain, scopes: ["orders:read", "orders:write"], reason: "Process-crash verification" });
    assert.equal(started.isError, false);
    const signin = JSON.parse(await call("poppyCards")).find(card => card.kind === "signin_link" && card.open);
    const location = await companyCall("approveAuthorization", signin.url, { approve: true, account: "acct_ada" });
    // The ordinary token exchange and client/session machinery remain in use.
    await call("crashCompleteSignIn", location);
    const ask = () => call("poppyTool", channel === "openapi" ? "poppy_api_call" : "poppy_mcp_call", channel === "openapi"
      ? { domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } }
      : { domain, tool: "exchange_item", args: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    assert.equal((await ask()).isError, false);
    const terms = JSON.parse(await call("poppyCards")).find(card => card.kind === "approval" && card.open);
    assert.ok(terms?.terms, "The Company's real terms must wait on their own card");
    const userId = await call("poppySql", "SELECT user_id FROM poppy_user_ids");
    await call("crashArm", point, terms.approvalId);
    const reached = pda.barrier(point);
    const pendingDecision = pda.rpc({ action: "frame", frame: { type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" } }).catch(error => error.message);
    await reached;
    const expectedEffects = point === "before-dispatch" ? 0 : 1;
    const atCrash = await companyCall("state");
    const ledgerBefore = await company.rpc({ action: "ledger" });
    assert.equal(atCrash.performs, expectedEffects);
    const oldPid = pda.pid;
    await kill(pda);
    await pendingDecision;
    pda = await start(settings, "pda");
    assert.notEqual(pda.pid, oldPid, "PDA must be a new operating-system process");
    await pda.rpc({ action: "peer", port: company.port });
    await company.rpc({ action: "peer", port: pda.port });
    await pda.rpc({ action: "authenticate" });
    assert.equal(await call("poppySql", "SELECT user_id FROM poppy_user_ids"), userId, "SQLite identity must survive SIGKILL");
    const expectedStatus = point === "after-commit" || point === "after-notification" ? "done" : "unknown";
    const recovered = JSON.parse(await call("poppyCards"));
    assert.equal(recovered.find(card => card.approvalId === terms.approvalId)?.status, expectedStatus);
    assert.equal(recovered.filter(card => card.kind === "approval").length, 1, "Internal task dispatch cannot become another approval receipt");
    const activity = JSON.parse(await call("poppyActivity"));
    assert.equal(activity.log.find(entry => entry.id === terms.id)?.decidedBy, "you");
    await call("poppyFrame", { type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    if (expectedStatus === "unknown") {
      const held = await ask();
      assert.equal(held.isError, true);
      assert.match(held.text, /unknown outcome/);
    }
    if (expectedStatus === "done") {
      const [{ notice_id }] = JSON.parse(await call("poppySql", "SELECT json_extract(notification, '$.id') AS notice_id FROM poppy_approvals WHERE id = ?", terms.approvalId));
      const notices = JSON.parse(await call("poppySql", "SELECT COUNT(*) AS n, COUNT(DISTINCT text) AS texts FROM test_notices WHERE operation_id = ?", notice_id));
      assert.equal(notices[0].n, point === "after-notification" ? 2 : 1, "The durable callback must recover; an unacknowledged delivery retries its same operation");
      assert.equal(notices[0].texts, 1, "Notification retries must preserve the original text and operation ID");
    }
    const after = await companyCall("state");
    assert.equal(after.performs, expectedEffects, "Restart, duplicate approval and a fresh tool call cannot repeat the effect");
    const ledgerAfter = await company.rpc({ action: "ledger" });
    assert.deepEqual(ledgerAfter, ledgerBefore, "The separate Company's ledger must show no resent business request; metadata reads remain allowed");
    assert.deepEqual(after.violations, []);
    assert.deepEqual(after.warnings, []);
    results.push({ channel, point, signal: "SIGKILL", oldPdaPid: oldPid, newPdaPid: pda.pid, companyPid: company.pid, companyNeverRestarted: true, effectsBeforeCrash: atCrash.performs, effectsAfterRecovery: after.performs, status: expectedStatus, userAttribution: true, noResend: true });
    process.stdout.write(`${channel}/${point}: passed\n`);
    await kill(pda);
    await kill(company);
  }
  // Initial task dispatch and Pi tool settlement are different crash windows from
  // clicking Company terms. Keep both, with an independent surviving ledger.
  const probes = [
    ...["openapi", "mcp"].flatMap(channel => ["task-before-dispatch", "task-after-effect", "task-after-terms-link"].map(point => ({ channel, point }))),
    { channel: "mcp", point: "tool-settlement", replay: "safe" },
    { channel: "mcp", point: "tool-settlement", replay: "unsafe" }
  ];
  for (const { channel, point, replay } of probes) {
    if (onlyPoint && point !== onlyPoint) continue;
    const label = `${channel}-${point}${replay ? `-${replay}` : ""}`;
    const runDirectory = path.join(directory, label);
    const settings = path.join(directory, `${label}.json`);
    writeFileSync(settings, JSON.stringify({ config, bindings, cookie, bundle, script: path.join(bundle, "process-worker.js"), persistence: { pda: path.join(runDirectory, "pda"), company: path.join(runDirectory, "company") } }), { mode: 0o600 });
    const company = await start(settings, "company");
    let pda = await start(settings, "pda");
    await company.rpc({ action: "peer", port: pda.port });
    await pda.rpc({ action: "peer", port: company.port });
    await pda.rpc({ action: "authenticate" });
    const companyCall = (method, ...args) => company.call("crash", method, ...args);
    const call = (method, ...args) => pda.call(name, method, ...args);
    const domain = "crash.shop.test";
    // No Operations extension is a current 0.3 routine write, not a legacy approval flow.
    await companyCall("configure", { protocolVersion: "0.3", strictAssertions: true, dpopTokens: true, operations: point === "task-after-terms-link" });
    assert.equal((await call("poppyTool", "poppy_sign_in", { domain, scopes: ["orders:read", "orders:write"], reason: "Initial task crash verification" })).isError, false);
    const signin = JSON.parse(await call("poppyCards")).find(card => card.kind === "signin_link" && card.open);
    await call("crashCompleteSignIn", await companyCall("approveAuthorization", signin.url, { approve: true, account: "acct_ada" }));
    const tool = channel === "openapi" ? "poppy_api_call" : "poppy_mcp_call";
    const args = channel === "openapi"
      ? { domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } }
      : { domain, tool: "exchange_item", args: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } };
    const noticesBefore = await call("poppyNotices");
    const callId = `initial-${label}`;
    const ask = id => call("poppyTool", tool, args, id);
    await call("crashArm", point, "", replay ?? "safe");
    const reached = pda.barrier(point);
    const pending = point === "tool-settlement"
      ? pda.rpc({ action: "frame", frame: { type: "submit", id: crypto.randomUUID(), input: `Place this exchange. @@obey ${tool} ${Buffer.from(JSON.stringify(args)).toString("base64url")}` } })
      : ask(callId);
    const interrupted = pending.catch(error => error.message);
    await reached;
    const atCrash = await companyCall("state");
    const expectedEffects = ["task-after-effect", "tool-settlement"].includes(point) ? 1 : 0;
    assert.equal(atCrash.performs, expectedEffects);
    const ledgerBefore = await company.rpc({ action: "ledger" });
    assert.equal(ledgerBefore.businessRequests.length, point === "task-before-dispatch" ? 0 : 1, "Only the exact exchange request is business dispatch; metadata and token traffic are excluded");
    assert.ok(ledgerBefore.businessRequests.every(request => request.channel === channel && !request.approved));
    const rowsBefore = JSON.parse(await call("poppySql", "SELECT id, status, result, terms_approval_id FROM poppy_approvals WHERE id GLOB 'req_*'"));
    assert.equal(rowsBefore.length, 1);
    assert.equal(rowsBefore[0].status, point === "task-before-dispatch" ? "pending" : point === "tool-settlement" ? "done" : "executing");
    assert.equal(JSON.parse(await call("poppySql", "SELECT * FROM poppy_task_calls")).length, 1, "The interrupted tool must already have its durable binding");
    if (point === "task-after-terms-link") {
      assert.ok(rowsBefore[0].terms_approval_id);
      assert.equal(JSON.parse(await call("poppyCards")).filter(card => card.kind === "approval").length, 0, "Kill precedes terms publication");
    }
    let saved;
    if (point === "tool-settlement") {
      saved = JSON.parse(JSON.parse(await call("poppySql", "SELECT result FROM test_saved_tool"))[0].result);
      assert.equal(saved.isError ?? false, false);
      assert.deepEqual(JSON.parse(await call("crashToolResults")), [], "Pi has not yet committed its tool result");
      // The random exchange id is an exact-result witness, not a command-name/count proxy.
      assert.ok(JSON.stringify(saved).includes(JSON.parse(rowsBefore[0].result).structuredContent.exchange.exchange_id));
    }
    const oldPid = pda.pid;
    await kill(pda);
    await interrupted;
    pda = await start(settings, "pda");
    assert.notEqual(pda.pid, oldPid);
    await pda.rpc({ action: "peer", port: company.port });
    await company.rpc({ action: "peer", port: pda.port });
    await pda.rpc({ action: "authenticate" });
    const expectedStatus = point === "task-before-dispatch" ? "failed" : point === "task-after-effect" ? "unknown" : point === "task-after-terms-link" ? "terms" : "done";
    const recovered = JSON.parse(await call("poppySql", "SELECT id, status, result, terms_approval_id FROM poppy_approvals WHERE id GLOB 'req_*'"));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, expectedStatus);
    assert.equal(JSON.parse(await call("poppySql", "SELECT id FROM poppy_approvals WHERE id GLOB 'req_*' AND status IN ('pending', 'executing')")).length, 0, "Recovery cannot strand internal pending requests");
    if (point === "tool-settlement") {
      const deadline = Date.now() + 15_000;
      let settled;
      for (;;) {
        settled = JSON.parse(await call("crashToolResults")).filter(result => result.toolName === tool);
        if (settled.length) break;
        if (Date.now() >= deadline) throw new Error("Pi did not settle the interrupted MCP call");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(settled.length, 1);
      if (replay === "safe") {
        assert.equal(settled[0].isError, false);
        assert.deepEqual(settled[0].content, saved.output);
        assert.deepEqual(settled[0].details, saved.details);
      } else {
        assert.equal(settled[0].isError, true, "Negative control: stored unsafe intent must NOT recover the successful result");
        assert.match(JSON.stringify(settled[0]), /interrupted/);
        assert.notDeepEqual(settled[0].content, saved.output);
      }
      assert.equal(JSON.parse(await call("poppySql", "SELECT result FROM test_saved_tool")).length, 1);
    } else {
      const retried = await ask(callId);
      if (point === "task-after-terms-link") {
        assert.equal(retried.isError, false);
        assert.equal(JSON.parse(retried.text).proposed, recovered[0].terms_approval_id);
        const coalesced = await ask(`${callId}-coalesced`);
        assert.equal(coalesced.isError, false);
        assert.equal(JSON.parse(coalesced.text).proposed, recovered[0].terms_approval_id);
        assert.equal(JSON.parse(await call("poppySql", "SELECT * FROM poppy_task_calls")).length, 2);
      } else {
        assert.equal(retried.isError, true);
        if (point === "task-after-effect") {
          assert.match(retried.text, /Interrupted|unknown/i);
          const fresh = await ask(`${callId}-fresh`);
          assert.equal(fresh.isError, true);
          assert.match(fresh.text, /unknown outcome/);
          assert.equal(JSON.parse(await call("poppySql", "SELECT status FROM poppy_approvals WHERE id = ?", recovered[0].id))[0].status, "unknown");
        } else assert.match(retried.text, /Nothing was sent/);
      }
    }
    const recoveredCards = JSON.parse(await call("poppyCards")).filter(card => card.kind === "approval");
    assert.equal(recoveredCards.length, point === "tool-settlement" ? 0 : 1, "Only Company terms or an interrupted-task failure may have a card; no extra internal receipts");
    if (point === "task-after-terms-link") {
      const [terms] = JSON.parse(await call("poppySql", "SELECT status, terms FROM poppy_approvals WHERE id = ?", recovered[0].terms_approval_id));
      assert.equal(terms.status, "pending", "Recovery publishes the terms, never decides them");
      assert.equal(recoveredCards[0].approvalId, recovered[0].terms_approval_id);
      assert.equal(recoveredCards[0].open, true);
      assert.deepEqual(recoveredCards[0].terms, JSON.parse(terms.terms), "Recover the exact saved Company terms");
      assert.deepEqual(await call("poppyNotices"), noticesBefore, "An intermediate terms handoff must not wake the model");
    }
    const after = await companyCall("state");
    assert.equal(after.performs, expectedEffects);
    assert.deepEqual(await company.rpc({ action: "ledger" }), ledgerBefore, "Restart/replay may renew metadata or tokens, never resend the business write");
    assert.deepEqual(after.violations, []);
    assert.deepEqual(after.warnings, []);
    results.push({ channel, point, ...(replay ? { replay, negativeControl: replay === "unsafe", exactSavedResultRecovered: replay === "safe" } : {}), signal: "SIGKILL", oldPdaPid: oldPid, newPdaPid: pda.pid, companyPid: company.pid, companyNeverRestarted: true, effectsBeforeCrash: atCrash.performs, effectsAfterRecovery: after.performs, status: expectedStatus, noResend: true, noStrandedPendingTasks: true });
    process.stdout.write(`${label}: passed${replay === "unsafe" ? " (negative control: interrupted, not saved success)" : ""}\n`);
    await kill(pda);
    await kill(company);
  }
  assert.ok(results.length, `No crash probes matched ${onlyPoint}`);
  const receipt = { tests: results, runtime: "separate OS process groups and workerd runtimes; PDA SQLite reused after SIGKILL", liveAuthenticationVerified: false };
  if (output) writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
} finally {
  for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  await Promise.all([...children].map(child => once(child, "exit").catch(() => undefined)));
  rmSync(directory, { recursive: true, force: true });
}
