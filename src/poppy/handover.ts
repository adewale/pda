/**
 * Handing the browser to the User (0.4 Browser Control 5, 6; decision 47).
 *
 * The agent browses with its fetch browser, which runs no JavaScript and
 * leaves every step a Company marks for the User undone (Browser Control 4).
 * When it reaches one, the User is offered control on a card. Taking it
 * starts a real browser in Cloudflare Browser Run for the same Session: it
 * gets the fetch browser's cookies, so the Company sees the same joined
 * browser, opens the page with the step, and gives `navigator.poppy.controller`
 * as `"user"` on the Company's hosts. The User drives it through a live view
 * that only their own page receives. While they hold control the model's
 * browser actions are refused, and only the User ends it, by handing back or
 * cancelling: no timeout, mark or message from the Company does. Then the
 * handover browser closes, keeping nothing of what the User did there (a
 * login they typed in it included), and the agent looks at the page again
 * before it does anything else on the website.
 *
 * The browser starts only when the User takes control, never for the model:
 * the agent itself never runs a page's scripts (decision 28).
 */
import type { BrowserCookie, PageSnapshot } from "./browser";
import { PoppyError, type PoppyClient } from "./client";
import type { Company } from "./discovery";
import { randomId } from "./jwt";
import { sameAuthority, sessionAuthority, type Authority } from "./authority";
import type { Card } from "./wire";
import type { Issuer } from "./issuer";
import { integer, one, rows } from "../rows";
import { object } from "../decode";
import { handoversTable, type HandoverRow } from "./store";
import { isObject, parseStrictJson } from "./json";
import { usesBrowserControl } from "./declaration";

/** A real browser the User drives: Browser Run in production (browser-run.ts), a fake in tests. */
export interface HandoverBrowser {
  /** Its Browser Run session, to connect to again after an eviction. */
  readonly sessionId: string;
  /** The Session's cookies and `navigator.poppy` first, then the page. */
  open(url: string, cookies: readonly BrowserCookie[], domain: string): Promise<void>;
  /** After connecting again: `navigator.poppy` for the page open now and every one after. */
  restore(domain: string): Promise<void>;
  /** A link that shows and drives the browser, until `expiresAt`: whoever holds it controls the browser. */
  liveView(now: number): Promise<{ readonly url: string; readonly expiresAt: number }>;
  currentUrl(): Promise<string | null>;
  close(): Promise<void>;
}

export interface HandoverLauncher {
  /** A new browser that reaches only `domain`, its subdomains and common CDNs. */
  launch(domain: string): Promise<HandoverBrowser>;
  /** The browser of that Browser Run session, or null once it has gone. */
  connect(sessionId: string): Promise<HandoverBrowser | null>;
}

export const HANDOVER_LIMITS = {
  /** Browsers started an hour, per agent: each one costs Browser Run time. */
  perHour: 6,
  /** After this long the browser closes, to bound its cost; the User keeps control until they end it (5). */
  browserMs: 30 * 60_000,
  /** How often a handover's browser is checked: connected, `navigator.poppy` in place, its Session unchanged. */
  heartbeatMs: 30_000
} as const;

export type HandoverState = "offered" | "user" | "returned" | "cancelled" | "declined" | "ended";

/**
 * `navigator.poppy`, read-only, on the Company's hosts only (Browser Control
 * 6): elsewhere it stays undefined, so other websites can't tell the browser
 * is a Personal Agent's. The handover browser exists only while the User
 * holds control, so its controller is always `"user"`.
 */
export function controllerScript(domain: string): string {
  return `(() => {
  const domain = ${JSON.stringify(domain.toLowerCase())};
  const host = location.hostname.toLowerCase().replace(/\\.$/, "");
  if (location.protocol !== "https:" || (host !== domain && !host.endsWith("." + domain))) return;
  const poppy = Object.freeze(Object.create(null, { controller: { value: "user", enumerable: true } }));
  try { Object.defineProperty(Navigator.prototype, "poppy", { get: () => poppy, enumerable: true, configurable: false }); } catch {}
})();`;
}

/** Browsers this agent has open, by handover: in memory only, since a connection can't be stored. */
const openBrowsers = new WeakMap<PoppyClient, Map<string, HandoverBrowser>>();

function browsersOf(client: PoppyClient): Map<string, HandoverBrowser> {
  let browsers = openBrowsers.get(client);
  if (!browsers) {
    browsers = new Map();
    openBrowsers.set(client, browsers);
  }
  return browsers;
}

/** Browsers starting, by handover, so a second Take waits for the first's instead of starting another. */
const startingBrowsers = new WeakMap<PoppyClient, Map<string, Promise<unknown>>>();

function startingOf(client: PoppyClient): Map<string, Promise<unknown>> {
  let starting = startingBrowsers.get(client);
  if (!starting) {
    starting = new Map();
    startingBrowsers.set(client, starting);
  }
  return starting;
}

/**
 * Whether the agent can hand this Company's website to the User, and so
 * declares Browser Control 1 there (B5): a launcher, a 0.4 Company that lists
 * the extension, and a browser-session endpoint to join with (3).
 */
export function handsOver(client: PoppyClient, company: Company): boolean {
  return usesBrowserControl(company, client.host.handover?.() != null);
}

function row(client: PoppyClient, id: string): HandoverRow | undefined {
  return one(client.sql, handoversTable.row, "SELECT * FROM poppy_handovers WHERE id = ?", id);
}

function bindingOf(value: HandoverRow): Authority {
  const parsed = parseStrictJson(value.binding);
  if (!isObject(parsed)) throw new Error("A handover's binding isn't an object");
  return {
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
    account: typeof parsed.account === "string" ? parsed.account : null,
    authorityGeneration: typeof parsed.authorityGeneration === "number" ? parsed.authorityGeneration : -1
  };
}

/** The handover in which the User holds control of this Session's browser, if any. */
export function userControl(client: PoppyClient, issuer: Issuer, label: string): HandoverRow | undefined {
  return one(client.sql, handoversTable.row, "SELECT * FROM poppy_handovers WHERE issuer = ? AND label = ? AND state = 'user'", issuer, label);
}

/**
 * Immediately before each request the model's browsing sends, as well as
 * when it starts: the User may have taken control while it waited (5).
 */
export function refuseWhileUserHasControl(client: PoppyClient, company: Company, label: string): void {
  if (!userControl(client, company.issuer, label)) return;
  throw new PoppyError(
    "user_has_control",
    `The User has control of the browser at ${company.name}, so the agent doesn't use it. Don't wait for them: carry on with other work, and you'll be told when they hand it back.`,
    0
  );
}

/**
 * Before any of the model's browser actions on this Session's website:
 * refused while the User holds control (5: "MUST NOT carry out browser
 * actions from its model"), and after they hand back, refused until the
 * agent has opened a page again ("looks at the page again before it continues").
 */
export function beforeModelAction(client: PoppyClient, company: Company, label: string, opening: boolean): void {
  refuseWhileUserHasControl(client, company, label);
  const back = one(client.sql, handoversTable.row, "SELECT * FROM poppy_handovers WHERE issuer = ? AND label = ? AND looked = 0 AND state IN ('returned', 'cancelled')", company.issuer, label);
  if (!back) return;
  if (!opening) throw new PoppyError("invalid_request", `The User used the browser at ${company.name}. Open the page again (poppy_browse with open) to see it as it is now before doing anything else there.`, 0);
  client.sql.exec("UPDATE poppy_handovers SET looked = 1 WHERE id = ?", back.id);
}

function card(company: Company, value: HandoverRow, note?: string): Card {
  const state = value.state as HandoverState;
  return {
    id: `handover-${value.id}`,
    kind: "browser_control",
    company: company.name,
    domain: company.domain,
    open: state === "offered" || state === "user",
    handoverId: value.id,
    step: value.step,
    url: value.url,
    state,
    ...(note ? { note } : {})
  };
}

/** What a marked step asks of the User, in our words (Browser Control 4). */
export function describeStep(action: { readonly kind: "click" | "fill" | "submit"; readonly selector: string }): string {
  if (action.kind === "click") return `follow the link ${action.selector}`;
  if (action.kind === "fill") return `fill in ${action.selector}`;
  return `submit the form ${action.selector}`;
}

/**
 * Offer the User control at a marked step (5): a card, and nothing else
 * waits on it. An offer still open for the Session is replaced.
 */
export async function offerControl(client: PoppyClient, company: Company, label: string, step: string, snapshot: Pick<PageSnapshot, "url">): Promise<string> {
  const session = client.session(company.issuer, label);
  for (const earlier of rows(client.sql, handoversTable.row, "SELECT * FROM poppy_handovers WHERE issuer = ? AND label = ? AND state = 'offered'", company.issuer, label)) {
    client.sql.exec("UPDATE poppy_handovers SET state = 'ended', ended_at = ? WHERE id = ?", client.host.now(), earlier.id);
    await client.host.showCard(card(company, { ...earlier, state: "ended" }, "A newer step replaced this one."));
  }
  const id = randomId("hnd_");
  const binding = sessionAuthority(session);
  client.sql.exec(
    `INSERT INTO poppy_handovers (id, issuer, label, url, step, state, browser, binding, looked, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, 'offered', NULL, ?, 1, ?, NULL, NULL)`,
    id, company.issuer, label, snapshot.url, step, JSON.stringify(binding), client.host.now()
  );
  await client.host.showCard(card(company, row(client, id)!));
  return id;
}

/** Joined cookies and the page, from the fetch browser's context (browser.ts). */
export type HandoverStart = (company: Company, label: string) => Promise<{ readonly cookies: readonly BrowserCookie[]; readonly binding: Authority }>;

function companyOf(client: PoppyClient, value: HandoverRow): Company {
  return client.companyByIssuer(value.issuer);
}

function launcherOf(client: PoppyClient): HandoverLauncher {
  const launcher = client.host.handover?.();
  if (!launcher) throw new PoppyError("refused", "This agent can't hand over a browser: Browser Run is off here.", 0);
  return launcher;
}

/** The handover's browser: already connected, connected again (and `navigator.poppy` restored), or null once gone. */
async function connected(client: PoppyClient, value: HandoverRow): Promise<HandoverBrowser | null> {
  const browsers = browsersOf(client);
  const open = browsers.get(value.id);
  if (open) return open;
  if (!value.browser) return null;
  const found = await launcherOf(client).connect(value.browser);
  if (!found) {
    client.sql.exec("UPDATE poppy_handovers SET browser = NULL WHERE id = ?", value.id);
    return null;
  }
  await found.restore(companyOf(client, value).domain);
  browsers.set(value.id, found);
  return found;
}

async function closeBrowser(client: PoppyClient, value: HandoverRow): Promise<string | null> {
  const browser = await connected(client, value).catch(() => null);
  browsersOf(client).delete(value.id);
  client.sql.exec("UPDATE poppy_handovers SET browser = NULL WHERE id = ?", value.id);
  if (!browser) return null;
  const url = await browser.currentUrl().catch(() => null);
  await browser.close().catch(() => undefined);
  return url;
}

/** The Session the offer was made in, unchanged: no sign-out, sign-in or new Session since. */
function sameSession(client: PoppyClient, value: HandoverRow): boolean {
  return sameAuthority(bindingOf(value), sessionAuthority(client.session(value.issuer, value.label)));
}

/** End a handover whose Session changed (a sign-out, or a new Session): its browser's cookie no longer acts for it. */
async function endChanged(client: PoppyClient, value: HandoverRow): Promise<void> {
  await closeBrowser(client, value);
  client.sql.exec("UPDATE poppy_handovers SET state = 'ended', ended_at = ? WHERE id = ?", client.host.now(), value.id);
  const company = companyOf(client, value);
  await client.host.showCard(card(company, { ...value, state: "ended" }, "The Session at this Company changed, so this browser closed."));
  if (value.state === "user") {
    await client.host.notifyModel(`The browser you handed to the User at ${company.name} closed because the Session there changed (a sign-in or sign-out). Open the page again before continuing on the website.`, `handover-${value.id}-ended`);
  }
}

/**
 * The User takes control (5): from their page only. A browser starts for
 * the same Session, with the fetch browser's cookies, at the page with the
 * step, or at the last page the User was on when a closed one is opened
 * again. Returns the live view for that page alone.
 */
export async function takeControl(client: PoppyClient, start: HandoverStart, id: string): Promise<{ readonly url: string; readonly expiresAt: number }> {
  // Checked and claimed before the first await, so two Takes can't both start a browser.
  const starting = startingOf(client);
  const earlier = starting.get(id);
  if (earlier) {
    await earlier.catch(() => undefined);
    return takeControl(client, start, id);
  }
  const startup = startControl(client, start, id);
  starting.set(id, startup);
  try {
    return await startup;
  } finally {
    if (starting.get(id) === startup) starting.delete(id);
  }
}

async function startControl(client: PoppyClient, start: HandoverStart, id: string): Promise<{ readonly url: string; readonly expiresAt: number }> {
  const value = row(client, id);
  if (!value || (value.state !== "offered" && value.state !== "user")) throw new PoppyError("invalid_request", "That browser step is no longer open.", 0);
  if (!sameSession(client, value)) {
    await endChanged(client, value);
    throw new PoppyError("approval_changed", "The Session changed since the step was offered, so the browser wasn't opened.", 0);
  }
  const company = companyOf(client, value);
  const existing = value.state === "user" ? await connected(client, value) : null;
  if (existing) return existing.liveView(client.host.now());
  const now = client.host.now();
  const started = one(client.sql, object({ count: integer }), "SELECT COUNT(*) AS count FROM poppy_handovers WHERE started_at > ?", now - 3_600_000)?.count ?? 0;
  if (started >= HANDOVER_LIMITS.perHour) {
    throw new PoppyError("rate_limited", `This agent has opened ${HANDOVER_LIMITS.perHour} browsers in the last hour. Take the step on ${company.domain} yourself, or try again later.`, 0);
  }
  const { cookies, binding } = await start(company, value.label);
  if (!sameAuthority(bindingOf(value), binding)) {
    await endChanged(client, value);
    throw new PoppyError("approval_changed", "The Session changed while opening the browser, so it wasn't opened.", 0);
  }
  const failed = new PoppyError("refused", `Couldn't start a browser for this step. Try again, or take it on ${company.domain} yourself.`, 0);
  const launcher = launcherOf(client);
  let browser: HandoverBrowser;
  try {
    browser = await launcher.launch(company.domain);
  } catch {
    throw failed;
  }
  try {
    await browser.open(value.url, cookies, company.domain);
  } catch {
    await browser.close().catch(() => undefined);
    throw failed;
  }
  // The User may have cancelled, or the Session changed, while the browser started; then it closes unused.
  const current = row(client, id);
  if (!current || (current.state !== "offered" && current.state !== "user")) {
    await browser.close().catch(() => undefined);
    throw new PoppyError("invalid_request", "That browser step ended while its browser was starting.", 0);
  }
  if (!sameSession(client, current)) {
    await browser.close().catch(() => undefined);
    await endChanged(client, current);
    throw new PoppyError("approval_changed", "The Session changed while opening the browser, so it wasn't opened.", 0);
  }
  browsersOf(client).set(id, browser);
  client.sql.exec("UPDATE poppy_handovers SET state = 'user', browser = ?, started_at = ? WHERE id = ?", browser.sessionId, now, id);
  await client.host.schedule("poppy-handover", now + HANDOVER_LIMITS.heartbeatMs, { id }, `handover-${id}`);
  await client.host.showCard(card(company, row(client, id)!));
  return browser.liveView(now);
}

/**
 * A fresh live view link for the User's page, the old one having expired
 * (5 minutes): only while they hold control. A browser that has closed
 * starts again at the last page known.
 */
export async function liveView(client: PoppyClient, start: HandoverStart, id: string): Promise<{ readonly url: string; readonly expiresAt: number }> {
  const value = row(client, id);
  if (!value || value.state !== "user") throw new PoppyError("invalid_request", "You don't have control of that browser.", 0);
  return takeControl(client, start, id);
}

/**
 * The User hands control back, or cancels (5): the only ways it ends. The
 * browser closes, and the agent is told, and must open the page again
 * before acting on the website. An offer the User turns down ends the same
 * way, with the step left undone.
 */
export async function endControl(client: PoppyClient, id: string, how: "returned" | "cancelled"): Promise<void> {
  const value = row(client, id);
  if (!value || (value.state !== "offered" && value.state !== "user")) return;
  const company = companyOf(client, value);
  if (value.state === "offered") {
    client.sql.exec("UPDATE poppy_handovers SET state = 'declined', ended_at = ? WHERE id = ?", client.host.now(), id);
    await client.host.showCard(card(company, { ...value, state: "declined" }));
    await client.host.notifyModel(`The User chose not to ${value.step} at ${company.name} now. The step stays undone; don't take it yourself.`, `handover-${id}-declined`);
    return;
  }
  const last = await closeBrowser(client, value);
  // Where the User left it, if that is still a page of the Company's; otherwise the page the step was on.
  const at = last && isCompanyPage(company, last) ? last : value.url;
  client.sql.exec("UPDATE poppy_handovers SET state = ?, url = ?, looked = 0, ended_at = ? WHERE id = ?", how, at, client.host.now(), id);
  await client.host.showCard(card(company, { ...row(client, id)! }));
  const done = how === "returned" ? "handed control of the browser back" : "cancelled their control of the browser";
  await client.host.notifyModel(
    `The User ${done} at ${company.name} (the step: ${value.step}). The browser was last at ${at}. Open that page again with poppy_browse before doing anything else on the website, and don't assume the step was or wasn't taken.`,
    `handover-${id}-${how}`
  );
}

function isCompanyPage(company: Company, url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === company.domain || host.endsWith(`.${company.domain}`));
  } catch {
    return false;
  }
}

/**
 * The `poppy-handover` job, every 30 seconds while the User holds control:
 * the browser stays connected with `navigator.poppy` in place, closes if its
 * Session changed, and closes after 30 minutes to bound its cost, the User
 * keeping control until they end it. Returns when to run again, or null.
 */
export async function heartbeat(client: PoppyClient, id: string): Promise<number | null> {
  const value = row(client, id);
  if (!value || value.state !== "user") return null;
  if (!sameSession(client, value)) {
    await endChanged(client, value);
    return null;
  }
  const now = client.host.now();
  if (value.browser && value.started_at !== null && now - value.started_at >= HANDOVER_LIMITS.browserMs) {
    const last = await closeBrowser(client, value);
    const company = companyOf(client, value);
    if (last && isCompanyPage(company, last)) client.sql.exec("UPDATE poppy_handovers SET url = ? WHERE id = ?", last, id);
    await client.host.showCard(card(company, row(client, id)!, "The browser closed after 30 minutes. You still have control: open it again to carry on, or hand back."));
    return null;
  }
  const browser = await connected(client, value).catch(() => null);
  if (browser) {
    const at = await browser.currentUrl().catch(() => null);
    if (at && isCompanyPage(companyOf(client, value), at)) client.sql.exec("UPDATE poppy_handovers SET url = ? WHERE id = ?", at, id);
  }
  return browser ? now + HANDOVER_LIMITS.heartbeatMs : null;
}

/** After a sign-out or anything else that can change a Session: end the handovers it voided. */
export async function endChangedHandovers(client: PoppyClient): Promise<void> {
  for (const value of rows(client.sql, handoversTable.row, "SELECT * FROM poppy_handovers WHERE state IN ('offered', 'user')")) {
    if (!sameSession(client, value)) await endChanged(client, value);
  }
}
