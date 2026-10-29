/** Actual browser approvals against the strict mock Company, through the production authenticated Worker. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

async function until(read, accepts, label) {
  const end = Date.now() + 20_000;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

async function clickApproval(page, summary = null) {
  const handle = await page.waitForFunction(expected => [...document.querySelectorAll("article [data-card-actions] button")].find(button =>
    !button.disabled && /^Approve(?: |$)/.test(button.textContent.trim()) && (!expected || button.closest("article").innerText.includes(expected))), {}, summary);
  const button = handle.asElement();
  assert.ok(button, "The actual approval button must be present");
  await button.click();
  await handle.dispose();
}

export async function approvalJourneys({ runtime, page, network, agentName, cookie, output }) {
  const agents = await runtime.getDurableObjectNamespace("PersonalAgent");
  const companies = await runtime.getDurableObjectNamespace("MOCK_COMPANY");
  const agent = agents.getByName(agentName);
  const receipts = [];
  const screenshots = [];
  const decisions = [];
  const resolutions = [];
  const onFrame = event => {
    try {
      const frame = JSON.parse(event.response.payloadData);
      if (frame.type === "poppy.approval") decisions.push({ approvalId: frame.approvalId, decision: frame.decision });
      if (frame.type === "poppy.approval.resolve") resolutions.push({ approvalId: frame.approvalId, outcome: frame.outcome });
    } catch { /* Other socket frames are irrelevant to this receipt. */ }
  };
  network.on("Network.webSocketFrameSent", onFrame);
  const capture = async suffix => {
    if (!output) return;
    const destination = `${output}.${suffix}.png`;
    writeFileSync(destination, Buffer.from(await page.screenshot({ type: "png", fullPage: true })));
    screenshots.push(destination);
  };
  const signInCompany = async (company, domain, config = {}) => {
    await company.configure({ protocolVersion: "0.3", deviceInterval: 1, ...config });
    const signIn = await agent.poppyTool("poppy_sign_in", { domain, scopes: ["orders:read", "orders:write"], reason: "To exchange your jacket" });
    assert.equal(signIn.isError, false, signIn.text);
    const signInCard = JSON.parse(await agent.poppyCards()).find(card => card.kind === "signin_link" && card.open);
    assert.ok(signInCard, "Synthetic Company setup must use the normal sign-in flow");
    const callbackUrl = await company.approveAuthorization(signInCard.url, { approve: true, account: "acct_ada" });
    const callback = await runtime.dispatchFetch(callbackUrl, { headers: { Cookie: cookie } });
    assert.equal(callback.status, 200, await callback.text());
  };
  const send = async prompt => {
    await page.waitForSelector('button[aria-label="Send message"]');
    await page.type('textarea[aria-label="Message your agent"]', prompt);
    await page.click('button[aria-label="Send message"]');
  };
  const showStep = async selector => {
    await page.waitForSelector('button[aria-label="Send message"]');
    await page.$eval(selector, element => element.scrollIntoView({ block: "center" }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  for (const [transport, viewport] of [["OpenAPI", "desktop"], ["MCP", "mobile"]]) {
    const companyId = `c${transport.toLowerCase()}journey`;
    const company = companies.getByName(companyId);
    const domain = `${companyId}.shop.test`;
    await signInCompany(company, domain);

    await page.setViewport(viewport === "desktop" ? { width: 1440, height: 1000, deviceScaleFactor: 1 } : { width: 390, height: 844, deviceScaleFactor: 1 });
    await page.goto("https://agent.test/", { waitUntil: "networkidle0" });
    await page.waitForSelector('textarea[aria-label="Message your agent"]');
    const before = await company.state();
    assert.equal(before.performs, 0);
    const prompt = `Please exchange my Stormline Jacket for the insulated medium at ${domain} using ${transport}.`;
    await send(prompt);
    const tool = transport === "OpenAPI" ? "poppy_api_call" : "poppy_mcp_call";
    await page.waitForSelector(`[data-tool="${tool}"][data-status="waiting"]`, { timeout: 20_000 });
    const ours = await until(async () => JSON.parse(await agent.poppyCards()), cards => cards.some(card => card.kind === "approval" && card.open && card.domain === domain), "Local approval not stored");
    const local = ours.find(card => card.kind === "approval" && card.open && card.domain === domain);
    assert.equal((await company.state()).performs, 0, "A displayed local approval cannot perform a write");
    assert.deepEqual((await company.state()).operations, [], "Local approval holds the initial operation request");
    await capture(`approval-${transport.toLowerCase()}-local-${viewport}`);
    await clickApproval(page);
    const termsCards = await until(async () => JSON.parse(await agent.poppyCards()), cards => cards.some(card => card.kind === "approval" && card.open && card.domain === domain && card.approvalId !== local.approvalId && card.terms), "Company terms not received after local approval");
    const terms = termsCards.find(card => card.kind === "approval" && card.open && card.domain === domain && card.terms);
    assert.match(terms.summary, /Exchange the Stormline Jacket/);
    assert.equal((await company.state()).performs, 0, "Company terms must wait for a separate User click");
    assert.deepEqual((await company.state()).operations.map(operation => [operation.state, operation.confirms]), [["proposed", 0]]);
    await page.waitForFunction(summary => [...document.querySelectorAll("article")].some(article => article.innerText.includes(summary) && article.querySelector("[data-card-actions] button")), {}, terms.terms.summary);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await capture(`approval-${transport.toLowerCase()}-terms-${viewport}`);
    await clickApproval(page, terms.terms.summary);
    await until(() => company.state(), state => state.performs === 1, "Approved Company operation did not perform");
    const decided = await until(async () => JSON.parse(await agent.poppyCards()), cards => [local.approvalId, terms.approvalId].every(id => cards.find(card => card.approvalId === id)?.status === "done"), "Both local and Company approvals must settle Done");
    await page.waitForSelector(`[data-tool="${tool}"][data-status="done"]`, { timeout: 20_000 });
    assert.equal(await page.$(`[data-tool="${tool}"][data-status="waiting"]`), null, "Original transcript step must stop waiting");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(`[data-tool="${tool}"][data-status="done"]`);
    await showStep(`[data-tool="${tool}"][data-status="done"]`);
    await capture(`approval-${transport.toLowerCase()}-done-${viewport}`);
    const activity = JSON.parse(await agent.poppyActivity());
    assert.deepEqual(activity.inProgress, [], "No approval may remain in Activity's in-progress list");
    const localEntry = activity.log.find(entry => entry.id === `approval-${local.approvalId}`);
    const termsEntry = activity.log.find(entry => entry.id === `approval-${terms.approvalId}`);
    assert.equal(localEntry?.result, "done", JSON.stringify(activity));
    assert.equal(termsEntry?.result, "done", JSON.stringify(activity));
    await page.goto("https://agent.test/activity", { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.body.innerText.includes("Nothing running"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await capture(`approval-${transport.toLowerCase()}-activity-${viewport}`);
    const state = await company.state();
    assert.equal(state.performs, 1, "Reloading the transcript and Activity must not repeat the operation");
    assert.deepEqual(state.violations, [], "Strict Company protocol violations");
    assert.deepEqual(state.warnings, [], "Strict Company protocol warnings");
    assert.deepEqual(state.operations.map(operation => [operation.state, operation.confirms, operation.approvedBy]), [["succeeded", 1, "user"]]);
    const journeyDecisions = decisions.filter(decision => [local.approvalId, terms.approvalId].includes(decision.approvalId));
    assert.deepEqual(journeyDecisions, [{ approvalId: local.approvalId, decision: "approve" }, { approvalId: terms.approvalId, decision: "approve" }], "Both User clicks must cross the actual browser WebSocket exactly once");
    const wire = transport === "OpenAPI" ? state.requests.filter(request => new URL(request.url).pathname.endsWith("/exchanges")).map(request => ({ status: request.status, companyApprovalPresent: !!request.headers["poppy-approval"] })) : null;
    if (wire) assert.deepEqual(wire, [{ status: 403, companyApprovalPresent: false }, { status: 201, companyApprovalPresent: true }]);
    receipts.push({
      transport, viewport, domain,
      localApproval: { id: local.approvalId, status: decided.find(card => card.approvalId === local.approvalId).status },
      companyApproval: { id: terms.approvalId, status: decided.find(card => card.approvalId === terms.approvalId).status },
      browserWebSocketDecisions: journeyDecisions,
      companyWire: wire,
      companyOperation: state.operations[0],
      performsBeforeEitherApproval: 0,
      performsAfterLocalApproval: 0,
      performsAfterTermsApprovalAndReload: state.performs,
      originalTranscript: "done",
      originalTranscriptSurvivesReload: true,
      activityInProgress: activity.inProgress.length,
      activityResults: [localEntry.result, termsEntry.result],
      strictCompanyViolations: state.violations.length,
      strictCompanyWarnings: state.warnings.length
    });
  }
  // The Company acts, but its response is lost: only an explicit User reconciliation can clear the block.
  const unknownCompany = companies.getByName("cunknownjourney");
  const unknownDomain = "cunknownjourney.shop.test";
  await signInCompany(unknownCompany, unknownDomain, { operations: false });
  const warm = await agent.poppyTool("poppy_api_call", { domain: unknownDomain, operation: "listOrders" });
  assert.equal(warm.isError, false, "Warm the ordinary token/nonce exchange before losing the action's answer");
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto("https://agent.test/", { waitUntil: "networkidle0" });
  const unknownPrompt = `Please exchange my Stormline Jacket for the insulated medium at ${unknownDomain} using OpenAPI.`;
  await send(unknownPrompt);
  const unknownCards = await until(async () => JSON.parse(await agent.poppyCards()), cards => cards.some(card => card.kind === "approval" && card.open && card.domain === unknownDomain), "Unknown-outcome test did not propose its action");
  const unknownApproval = unknownCards.find(card => card.kind === "approval" && card.open && card.domain === unknownDomain);
  await agent.poppyFault({ method: "POST", url: "/exchanges", mode: "throw" });
  await clickApproval(page);
  await until(async () => JSON.parse(await agent.poppyCards()), cards => cards.find(card => card.approvalId === unknownApproval.approvalId)?.status === "unknown", "A lost Company answer must remain unknown");
  const writes = state => state.requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/exchanges")).length;
  const unknownState = await unknownCompany.state();
  assert.equal(unknownState.performs, 1, "The synthetic Company performed the action before losing its answer");
  await agent.poppySql("UPDATE poppy_cards SET updated_at = ? WHERE id = ?", Date.now() - 2 * 60 * 60 * 1000, `approval-${unknownApproval.approvalId}`);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => ["I checked: it happened", "I checked: it did not happen"].every(text => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === text)));
  assert.equal(await page.$('[aria-label="Needs you"] [aria-label="Dismiss"]'), null, "The unresolved receipt must not offer Dismiss");
  await capture("unknown-choices-desktop");
  await send(unknownPrompt);
  const blockedStep = '[data-tool="poppy_api_call"][data-status="failed"]';
  await page.waitForSelector(blockedStep, { timeout: 20_000 });
  await page.click(`${blockedStep} button[aria-expanded="false"]`);
  await page.waitForFunction(selector => {
    const text = document.querySelector(selector)?.innerText ?? "";
    return text.includes("unknown outcome") && text.includes("Nothing was sent.") && text.includes("approval_changed");
  }, { timeout: 20_000 }, blockedStep);
  const afterBlocked = await unknownCompany.state();
  assert.equal(writes(afterBlocked), writes(unknownState), "A fresh chat proposal cannot resend an unresolved action");
  assert.equal(afterBlocked.performs, 1);
  assert.equal(JSON.parse(await agent.poppyCards()).filter(card => card.kind === "approval" && card.domain === unknownDomain).length, 1, "An unresolved action cannot gain a new approval card");
  await page.click(`${blockedStep} button[aria-expanded="true"]`);
  // The test has checked the strict mock's own state, so this assertion matches the simulated fact.
  const checked = await page.waitForFunction(() => [...document.querySelectorAll("button")].find(button => !button.disabled && button.textContent.trim() === "I checked: it happened"));
  await checked.asElement().click();
  await checked.dispose();
  const resolvedCards = await until(async () => JSON.parse(await agent.poppyCards()), cards => cards.find(card => card.approvalId === unknownApproval.approvalId)?.outcomeResolution?.outcome === "performed", "The User's reconciliation was not stored");
  const resolved = resolvedCards.find(card => card.approvalId === unknownApproval.approvalId);
  assert.equal(resolved.status, "unknown", "The original uncertain receipt must be preserved");
  const reconciledActivity = JSON.parse(await agent.poppyActivity());
  const checkedOutcome = reconciledActivity.log.find(entry => entry.id === `approval-${unknownApproval.approvalId}`);
  assert.equal(checkedOutcome.outcomeBy, "you");
  await page.waitForFunction(outcome => document.body.innerText.includes(outcome), {}, checkedOutcome.outcome);
  await page.reload({ waitUntil: "networkidle0" });
  const resolvedStep = await page.waitForFunction(outcome => [...document.querySelectorAll('[data-tool="poppy_api_call"][data-status="done"]')].find(step => step.innerText.includes(outcome)), {}, checkedOutcome.outcome);
  await resolvedStep.asElement().evaluate(element => element.scrollIntoView({ block: "center" }));
  await resolvedStep.dispose();
  await capture("unknown-reconciled-desktop");
  // Once the resolved card leaves the page, the original step must keep the
  // User's attribution through Activity rather than imply a Company answer.
  const resolvedAt = Date.now() - 2 * 60 * 60 * 1000;
  await agent.poppySql("UPDATE poppy_cards SET updated_at = ? WHERE id = ?", resolvedAt, `approval-${unknownApproval.approvalId}`);
  await agent.poppyRestart();
  assert.equal(JSON.parse(await agent.poppySql("SELECT updated_at FROM poppy_cards WHERE id = ?", `approval-${unknownApproval.approvalId}`))[0].updated_at, resolvedAt, "Recovery must not renew a resolved receipt's age");
  const unknownIssuer = JSON.parse(await agent.poppySql("SELECT issuer FROM poppy_approvals WHERE id = ?", unknownApproval.approvalId))[0].issuer;
  await agent.poppySql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 205)
    INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at)
    SELECT 'apr_browser_history_' || i, ?, 'main', 'Synthetic later action', '{}', 'done', ? + i FROM n`, unknownIssuer, Date.now());
  const boundedActivity = JSON.parse(await agent.poppyActivity());
  assert.equal(boundedActivity.log.some(entry => entry.id === `approval-${unknownApproval.approvalId}`), false, "The old decision must be outside the bounded Activity feed");
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(attribution => [...document.querySelectorAll('[data-tool="poppy_api_call"][data-status="done"]')].some(step => step.innerText.includes(attribution)), {}, checkedOutcome.outcome);
  assert.equal(await page.evaluate(() => document.body.innerText.includes("Recording this did not send another request.")), false, "The resolved receipt must have aged out of the page");
  await capture("unknown-reconciled-history-desktop");
  const resolvedState = await unknownCompany.state();
  assert.equal(resolvedState.performs, 1);
  assert.equal(writes(resolvedState), writes(unknownState), "Recording and reloading reconciliation cannot resend the action");
  assert.deepEqual(resolutions, [{ approvalId: unknownApproval.approvalId, outcome: "performed" }], "User reconciliation must cross the real browser WebSocket once");
  assert.deepEqual(resolvedState.violations, []);
  assert.deepEqual(resolvedState.warnings, []);
  assert.equal(reconciledActivity.log.find(entry => entry.id === `approval-${unknownApproval.approvalId}`)?.result, "done");
  assert.deepEqual(reconciledActivity.inProgress, []);
  const recovery = {
    transport: "OpenAPI", viewport: "desktop", fault: "Company performs the action, then the response is lost",
    initialReceipt: "unknown", agedReceiptSurvivesReload: true, ageAtReloadHours: 2, unresolvedReceiptOffersDismiss: false, freshProposalBlocked: true,
    browserWebSocketResolution: resolutions[0], preservedReceiptStatus: resolved.status,
    userReportedOutcome: resolved.outcomeResolution.outcome,
    resolvedReceiptExpired: true, recoveryPreservesReceiptAge: true, newerSyntheticActivityRows: 205,
    originalDecisionOutsideActivity: true, userAttributionAfterResolvedReceiptExpiry: true,
    exchangeRequestsBeforeReconciliation: writes(unknownState), exchangeRequestsAfterReconciliationAndReload: writes(resolvedState),
    performsBeforeReconciliation: unknownState.performs, performsAfterReconciliationAndReload: resolvedState.performs,
    originalTranscriptAfterReload: "done, attributed to the User's check with the Company",
    activityResult: "done", activityInProgress: reconciledActivity.inProgress.length,
    strictCompanyViolations: resolvedState.violations.length, strictCompanyWarnings: resolvedState.warnings.length
  };
  const verificationCompany = companies.getByName("cverificationjourney");
  const verificationDomain = "cverificationjourney.shop.test";
  await verificationCompany.configure({ protocolVersion: "0.3", agentReplies: false });
  const hello = await agent.poppyTool("poppy_message", { domain: verificationDomain, text: "Hello" });
  assert.equal(hello.isError, false);
  const conversation = JSON.parse(hello.text).conversationId;
  await verificationCompany.say(conversation, "To verify your identity, please provide your email and verification code.");
  await agent.poppyReadNow(conversation);
  await send(`Please send a verification reply at ${verificationDomain} in ${conversation}.`);
  const withheldStep = await page.waitForFunction(() => [...document.querySelectorAll('[data-tool="poppy_message"]')].find(step => step.innerText.includes("Kept verification details private")));
  const withheldText = await withheldStep.asElement().evaluate(element => { element.scrollIntoView({ block: "center" }); return element.innerText; });
  assert.equal(withheldText.includes("482913"), false);
  assert.equal(withheldText.includes("Wrote to"), false);
  await withheldStep.dispose();
  await capture("withheld-message-desktop");
  const verificationState = await verificationCompany.state();
  const sent = verificationState.conversations.flatMap(item => item.sent);
  assert.equal(sent.some(message => message.includes("482913")), false);
  assert.equal(sent.filter(message => message.startsWith("agent:Please send an authorization event")).length, 1);
  assert.deepEqual(verificationState.violations, []);
  assert.deepEqual(verificationState.warnings, []);
  network.off("Network.webSocketFrameSent", onFrame);
  return {
    journeys: receipts, recovery, messageWithheld: { actualBrowserToolCall: true, replyQuotedAsSent: false, verificationCodeSent: false, authorizationMessages: 1, strictViolations: 0, strictWarnings: 0 }, screenshots,
    companySignInSetup: "strict mock authorization decision followed by production authenticated callback",
    userApprovals: "actual Chromium clicks sent over the production WebSocket",
    liveOAuthOrExternalPaymentsVerified: false
  };
}
