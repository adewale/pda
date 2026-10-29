import { PoppyClient, PoppyError } from "./client";
import type { Company } from "./discovery";
import { assertPublicHost, PoppyFetchError } from "./fetch";
import { toJson, type Json } from "./json";
import { randomId } from "./jwt";
import { sameAuthority, sessionAuthority } from "./authority";
import { proposeLocal, registerExecutor } from "./operations";
import { EndpointRequest } from "./outgoing";

/** What the model gets from a page: text, links and forms, never cookies (Guides, "Web browsing"). */
export type PageSnapshot = {
  readonly url: string;
  readonly status: number;
  readonly title: string;
  readonly text: string;
  /** `selector` is what `click` takes. */
  readonly links: readonly { text: string; href: string; selector: string }[];
  /** `selector` is what `submit` takes; `fields` are the names `fill` takes. */
  readonly forms: readonly { selector: string; action: string; method: string; fields: readonly string[] }[];
  /** The response's `Retry-After`, if any, which a 429 must be waited out by (spec 4.3, MUST) and a 503 too (Guides, "Retries"). */
  readonly retryAfter?: string;
};

/** Exactly what a form submit sends, worked out before the User approves it. */
export type FormSubmission = {
  /** The page the form is on. */
  readonly from: string;
  readonly method: "GET" | "POST";
  readonly action: string;
  readonly enctype: "application/x-www-form-urlencoded" | "multipart/form-data";
  /** In order; `hidden` ones (hidden inputs, password fields) are sent but not shown on the approval card. */
  readonly fields: readonly { readonly name: string; readonly value: string; readonly hidden: boolean }[];
};

/** Throws for a URL the browser must not request; called for every request and every redirect. */
export type PageGuard = (url: URL) => void;

/** One isolated browser context: its own cookies, for one Session of one User. */
export interface BrowserContextHandle {
  /** A top-level form POST, as a browser submitting a form makes it: the browser join's step 3 (6). */
  postForm(action: string, fields: Readonly<Record<string, string>>): Promise<{ url: string; status: number; retryAfter?: string }>;
  goto(url: string): Promise<PageSnapshot>;
  /**
   * 0.3: load the browser-session page (6, step 1) and read its one-time
   * code, in software the model never sees: the hidden `code` of the form
   * that posts back to it. Nothing when the page isn't that.
   */
  joinCode(endpoint: string): Promise<{ readonly status: number; readonly code?: string; readonly action?: string }>;
  /** Follows a link; never sends a form. */
  click(selector: string): Promise<PageSnapshot>;
  fill(selector: string, value: string): Promise<PageSnapshot>;
  /** What submitting a form would send now, for the User to approve. */
  prepareSubmit(selector: string): Promise<FormSubmission>;
  /** Sends an approved submission, as it was approved. */
  submit(submission: FormSubmission, beforeDispatch?: () => void): Promise<PageSnapshot>;
  close(): Promise<void>;
}

/** Starts browser contexts (`FetchBrowser` in production), each held to `guard`. */
export interface PoppyBrowser {
  newContext(guard: PageGuard): Promise<BrowserContextHandle>;
}

type ContextEntry = {
  readonly id: string;
  readonly context: Promise<BrowserContextHandle>;
  /** The Session the context joined; a context never outlives it. */
  sessionId: string | null;
  account: string | null;
  /** Invalidated by sign-out, even when the same account and SID are used again. */
  authorityGeneration: number;
  joined: boolean;
  /** At most one join may use this context's one-time cookie at once. */
  joining?: Promise<void>;
};

/**
 * Each agent's open contexts, by Company issuer and Session label. Keyed by
 * the agent's own client, never shared at module level: Durable Objects of
 * one class can share an isolate, and a context holds a User's Session cookie.
 */
const openContexts = new WeakMap<PoppyClient, Map<string, ContextEntry>>();
const MAX_CONTEXTS = 20;

function contextsOf(client: PoppyClient): Map<string, ContextEntry> {
  let contexts = openContexts.get(client);
  if (!contexts) {
    contexts = new Map();
    openContexts.set(client, contexts);
  }
  return contexts;
}

function checkContext(client: PoppyClient, company: Company, label: string, entry: ContextEntry): void {
  const session = client.session(company.issuer, label);
  if (contextsOf(client).get(JSON.stringify([company.issuer, label])) !== entry || !sameAuthority(entry, sessionAuthority(session))) {
    throw new PoppyError("approval_changed", "The open page belongs to an earlier account or Session. Open a fresh page.", 0);
  }
}

async function dropContext(contexts: Map<string, ContextEntry>, key: string, expected?: ContextEntry): Promise<void> {
  const entry = expected ?? contexts.get(key);
  if (contexts.get(key) === entry) contexts.delete(key);
  if (entry) await (await entry.context).close().catch(() => undefined);
}

function onCompanyDomain(company: Company, url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return host === company.domain || host.endsWith(`.${company.domain}`);
}

/**
 * The Company's sign-in pages, which are the User's alone (spec 4.4): its
 * authorization, device and Mediated Sign-In endpoints and anything under
 * them, and the whole of its issuer's host when that host is a sign-in host
 * of its own (`auth.example.com`). A Company whose issuer is its website's
 * own origin (`https://example.com`) keeps its website browsable.
 */
export function isSignInPage(company: Company, url: URL): boolean {
  const endpoints = [company.endpoints.authorization, company.endpoints.deviceAuthorization, company.signIn.mediated?.endpoint]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value));
  const under = (endpoint: URL) => {
    const path = endpoint.pathname.replace(/\/+$/, "");
    return url.origin === endpoint.origin && (url.pathname === path || url.pathname.startsWith(`${path}/`));
  };
  if (endpoints.some(under)) return true;
  const issuer = new URL(company.issuer);
  const website = issuer.hostname.toLowerCase().replace(/^www\./, "") === company.domain;
  return !website && url.origin === issuer.origin;
}

/**
 * Where the browser may go for a Company, checked on every request and
 * redirect: HTTPS, a public host, the Company's own domain, and never its
 * sign-in pages. `endpoint`, the browser-session endpoint, is allowed even
 * on a sign-in host: the join must reach it.
 */
function pageGuard(company: Company, endpoint?: string): PageGuard {
  return (url) => {
    if (url.protocol !== "https:" || !onCompanyDomain(company, url)) {
      throw new PoppyError("refused", `Browsing is limited to ${company.domain} over HTTPS; not ${url.href}`, 0);
    }
    try {
      assertPublicHost(url);
    } catch (error) {
      if (error instanceof PoppyFetchError) throw new PoppyError("refused", error.message, 0);
      throw error;
    }
    if (url.href === endpoint) return;
    if (isSignInPage(company, url)) {
      throw new PoppyError("refused", "The agent never opens a company's sign-in pages; the User signs in themselves (use poppy_sign_in)", 0);
    }
  };
}

/**
 * The Session's browser context, joined to the Session first when the
 * Company has `web.browser_session_endpoint` (6, `join`). A new Session, or
 * an account signed in or out, gets a new context, so no cookie crosses
 * Sessions or accounts.
 */
async function sessionContext(
  client: PoppyClient,
  browser: PoppyBrowser,
  company: Company,
  label: string,
  rejoin = false
): Promise<{ readonly entry: ContextEntry; readonly context: BrowserContextHandle }> {
  const key = JSON.stringify([company.issuer, label]);
  const contexts = contextsOf(client);
  const endpoint = company.web?.browserSessionEndpoint;
  const open = (): ContextEntry => {
    if (contexts.size >= MAX_CONTEXTS) void dropContext(contexts, contexts.keys().next().value!);
    const session = client.session(company.issuer, label);
    const guard = pageGuard(company, endpoint);
    const fresh: ContextEntry = {
      id: randomId("ctx_"),
      context: browser.newContext((url) => { guard(url); checkContext(client, company, label, fresh); }),
      sessionId: session?.session_id ?? null, account: session?.account ?? null, authorityGeneration: session?.authority_generation ?? 0, joined: false
    };
    contexts.set(key, fresh);
    return fresh;
  };
  let entry = contexts.get(key);
  const before = client.session(company.issuer, label);
  if (entry && !sameAuthority(entry, sessionAuthority(before))) {
    await dropContext(contexts, key);
    entry = undefined;
  }
  entry ??= open();
  if (endpoint && (!entry.joined || rejoin)) {
    if (!entry.joining) {
      await client.token(company, { label });
      const session = client.session(company.issuer, label)!;
      // Preparation may have signed the Session out, or started a new one.
      if (!sameAuthority(entry, sessionAuthority(session))) {
        await dropContext(contexts, key, entry);
        entry = open();
      }
      if ((!entry.joined || rejoin) && !entry.joining) {
        const joining = entry;
        joining.joined = false;
        joining.joining = (async () => {
          try {
            const context = await joining.context;
            checkContext(client, company, label, joining);
            await join(client, company, label, context, endpoint, joining);
            checkContext(client, company, label, joining);
            joining.joined = true;
          } catch (error) {
            await dropContext(contexts, key, joining);
            throw error;
          } finally {
            joining.joining = undefined;
          }
        })();
      }
    }
    await entry.joining;
  }
  const context = await entry.context;
  checkContext(client, company, label, entry);
  return { entry, context };
}

/**
 * The browser join (6): the browser loads the page and gets a one-time
 * code and a cookie; we authorize the code in a request of our own, with
 * the Session header and, signed in, the access token, which so never
 * reaches the browser; then the browser submits the form, with the code
 * only, and the Company sets the Session's cookie. The code is taken from
 * our own browser's page and nowhere else (10.6).
 */
async function join(client: PoppyClient, company: Company, label: string, context: BrowserContextHandle, endpoint: string, entry: ContextEntry): Promise<void> {
  const check = () => checkContext(client, company, label, entry);
  await client.beforeRequest(company);
  check();
  const page = await context.joinCode(endpoint);
  check();
  if (page.status === 429 || page.status === 503) {
    await client.pageLimited(company, page.status, undefined);
    throw new PoppyError("browser_join_failed", `${company.name} asked us to wait before joining the browser to the Session`, page.status);
  }
  if (!page.code || !page.action) throw new PoppyError("browser_join_failed", `${company.name}'s browser-session page didn't give a code to join with`, page.status);
  const authorize = `${endpoint.replace(/\/+$/, "")}/authorize`;
  let authorized: { readonly sessionId: string; readonly account: string | null; readonly authorityGeneration: number } | undefined;
  await client.resourceJson(company, EndpointRequest.to(company, { method: "POST", url: authorize, body: { code: page.code } }), {
    label,
    beforeDispatch: () => {
      const session = client.session(company.issuer, label);
      if (!session || session.account !== entry.account || session.authority_generation !== entry.authorityGeneration || contextsOf(client).get(JSON.stringify([company.issuer, label])) !== entry) {
        throw new PoppyError("approval_changed", "The account or browser changed while joining. Open a fresh page.", 0);
      }
      // resource() may have retried invalid_session with a fresh SID. Its
      // dispatch guard makes this the binding actually sent on that attempt.
      authorized = { sessionId: session.session_id, account: session.account, authorityGeneration: session.authority_generation };
      entry.sessionId = authorized.sessionId;
      check();
    }
  });
  const checkAuthorized = () => {
    check();
    if (!authorized || !sameAuthority(entry, authorized)) {
      throw new PoppyError("approval_changed", "The browser join no longer belongs to the authorized Session. Open a fresh page.", 0);
    }
  };
  checkAuthorized();
  await client.beforeRequest(company);
  checkAuthorized();
  const result = await context.postForm(page.action, { code: page.code });
  checkAuthorized();
  // A refused submit is answered with an error page, and no redirect (6, step 3).
  if (result.url === page.action && result.status >= 400) {
    throw new PoppyError("browser_join_failed", `${company.name} didn't accept the browser into the Session`, result.status);
  }
  if (result.status === 429 || result.status === 503) await client.pageLimited(company, result.status, result.retryAfter);
}

export type BrowseAction =
  | { readonly kind: "open"; readonly url: string }
  | { readonly kind: "click"; readonly selector: string }
  | { readonly kind: "fill"; readonly selector: string; readonly value: string }
  | { readonly kind: "submit"; readonly selector: string };

/** Fields that look like credentials are never filled by the agent (Guides); the browser also checks the field itself. */
const CREDENTIAL = /pass(word)?|pin\b|otp|one.?time|verification.?code|cvv|cvc|card.?number|security.?code/i;

function snapshotForModel(snapshot: PageSnapshot): Json {
  return {
    url: snapshot.url,
    status: snapshot.status,
    title: snapshot.title,
    text: snapshot.text.slice(0, 8_000),
    links: toJson(snapshot.links.slice(0, 50)),
    forms: toJson(snapshot.forms)
  };
}

/**
 * Load a page within the Company's rate limits (spec 4.3): after any shared
 * `Retry-After`, and again after a short one on 429 or 503, at most three times.
 */
async function load(client: PoppyClient, company: Company, context: BrowserContextHandle, url: URL, check: () => void): Promise<PageSnapshot> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.beforeRequest(company);
    check();
    const snapshot = await context.goto(url.href);
    check();
    const limited = await client.pageLimited(company, snapshot.status, snapshot.retryAfter);
    check();
    if (!limited) return snapshot;
  }
  throw new PoppyError("rate_limited", `${company.name}'s website kept refusing the page`, 429);
}

/** The approval card's words: where the form goes, and every value the User can see on the page. */
function describeSubmission(company: Company, selector: string, submission: FormSubmission): string {
  const action = new URL(submission.action);
  const shown = submission.fields.filter((field) => !field.hidden);
  const clip = (value: string) => (value.length > 80 ? `${value.slice(0, 79)}…` : value);
  const values = shown.slice(0, 12).map((field) => `${field.name}: ${JSON.stringify(clip(field.value))}`);
  if (shown.length > 12) values.push(`and ${shown.length - 12} more`);
  return `${company.name}: submit the form ${selector} on the website (${submission.method} ${action.host}${action.pathname})${values.length > 0 ? `, sending ${values.join(", ")}` : ""}`;
}

/**
 * Browse a Company's website in the Session (6). Only the Company's own
 * domains; never sign-in pages or credential fields. Only links are
 * followed; a form is sent only after the User approves exactly what it sends.
 */
export async function browse(
  client: PoppyClient,
  browser: PoppyBrowser,
  company: Company,
  label: string,
  action: BrowseAction
): Promise<Json> {
  if (action.kind === "open") {
    const url = new URL(action.url, `https://${company.domain}/`);
    pageGuard(company)(url);
    let active = await sessionContext(client, browser, company, label);
    const check = () => checkContext(client, company, label, active.entry);
    let snapshot = await load(client, company, active.context, url, check);
    // The website stopped recognising the Session: join again (6: "MAY join again at any time").
    if ((snapshot.status === 401 || snapshot.status === 403) && company.web?.browserSessionEndpoint) {
      active = await sessionContext(client, browser, company, label, true);
      snapshot = await load(client, company, active.context, url, check);
    }
    return snapshotForModel(snapshot);
  }
  const entry = contextsOf(client).get(JSON.stringify([company.issuer, label]));
  if (!entry || entry.joining) throw new PoppyError("invalid_request", "Open a page first, and wait for its browser join to finish", 0);
  checkContext(client, company, label, entry);
  const handle = await entry.context;
  checkContext(client, company, label, entry);
  if (action.kind === "click") {
    await client.beforeRequest(company);
    checkContext(client, company, label, entry);
    let snapshot = await handle.click(action.selector);
    checkContext(client, company, label, entry);
    const limited = await client.pageLimited(company, snapshot.status, snapshot.retryAfter);
    checkContext(client, company, label, entry);
    if (limited) {
      snapshot = await load(client, company, handle, new URL(snapshot.url), () => checkContext(client, company, label, entry));
    }
    return snapshotForModel(snapshot);
  }
  if (action.kind === "fill") {
    if (CREDENTIAL.test(action.selector)) {
      throw new PoppyError("refused", "The agent never types credentials or codes into a website; sign in with poppy_sign_in instead", 0);
    }
    const snapshot = await handle.fill(action.selector, action.value);
    checkContext(client, company, label, entry);
    return snapshotForModel(snapshot);
  }
  const submission = await handle.prepareSubmit(action.selector);
  checkContext(client, company, label, entry);
  const id = await proposeLocal(client, company, label, describeSubmission(company, action.selector, submission), { kind: "browse-submit", submission, binding: { account: entry.account, sessionId: entry.sessionId, contextId: entry.id, authorityGeneration: entry.authorityGeneration } });
  return { proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

/**
 * An approved form submit: exactly the fields the User approved, in the same
 * Session's context, and only where the browser may go for the Company now
 * (its page and action checked again; the browser checks every hop too).
 */
registerExecutor("browse-submit", async (client, company, { submission, binding }, label, execution) => {
  const guard = pageGuard(company);
  guard(new URL(submission.from));
  guard(new URL(submission.action));
  const entry = contextsOf(client).get(JSON.stringify([company.issuer, label]));
  if (!entry) throw new Error("The page is no longer open");
  if (!binding || binding.contextId !== entry.id || !sameAuthority(binding, entry)) throw new PoppyError("approval_changed", "The account, Session or page context changed. Review a fresh form.", 0);
  checkContext(client, company, label, entry);
  await client.beforeRequest(company);
  const handle = await entry.context;
  const snapshot = await handle.submit(submission, () => { execution.beforeDispatch(); checkContext(client, company, label, entry); });
  return `Now at ${snapshot.url} (HTTP ${snapshot.status}): ${snapshot.title}`;
});
