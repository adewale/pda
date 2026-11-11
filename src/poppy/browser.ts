import { answerOf, hasCode, PoppyClient, PoppyError, scopeSet, withAnswer } from "./client";
import { BROWSER_SIGN_IN, type Company } from "./discovery";
import { assertPublicHost, PoppyFetchError } from "./fetch";
import { isObject, parseStrictJson, toJson, type Json } from "./json";
import { randomId } from "./jwt";
import { sameAuthority, sessionAuthority } from "./authority";
import { OperationOutcomeUnknown, proposeLocal, registerExecutor, TermsRequested } from "./operations";
import { EndpointRequest } from "./outgoing";
import { expired, proposeApproval, unusableApproval } from "./api-approvals";
import { approvable, approvalHeader, operationsVersion, parseOperationHeader, parseOperationV2, toSend, type SentApproval } from "./operations-v2";
import { readDecline } from "./declines";
import { companyErrorCode } from "./error-codes";

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
  /** 0.4: the final response's `Poppy-Operation` field, as received (Ops 4). Read by our own code, never shown to the model. */
  readonly operationHeader?: string;
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
  joinCode(endpoint: string): Promise<{ readonly status: number; readonly code?: string; readonly action?: string; readonly retryAfter?: string }>;
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
/** Headers a page request carries besides the browser's own, for its URL and method; null for none (0.4 5.2). */
export type PageHeaders = (url: URL, method: string) => Promise<Headers | null>;

export interface PoppyBrowser {
  /** `cookieDomains`: the Company's own domain, which a cookie's `Domain` may name to cover its hosts (0.4, 6). */
  newContext(guard: PageGuard, pageHeaders?: PageHeaders, cookieDomains?: readonly string[]): Promise<BrowserContextHandle>;
}

type ContextEntry = {
  readonly id: string;
  readonly context: Promise<BrowserContextHandle>;
  /** The Session the context joined; a context never outlives it. */
  sessionId: string | null;
  account: string | null;
  /** Invalidated by sign-out, even when the same account and SID are used again. */
  authorityGeneration: number;
  /** The cookie was authorized for these scopes and this sign-in's refresh-token family. */
  readonly scope: string;
  readonly accountGeneration: number;
  joined: boolean;
  /**
   * 0.4: joined signed out though the Session is signed in, because its
   * access doesn't include `poppy:browser-sign-in` (6).
   */
  websiteSignedOut?: boolean;
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
  if (contextsOf(client).get(JSON.stringify([company.issuer, label])) !== entry || !sameContextSession(client, company, entry, session)) {
    throw new PoppyError("approval_changed", "The account, Session or access changed. Open a fresh page.", 0);
  }
}

function canonicalScope(scope = ""): string {
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort().join(" ");
}

function accountGeneration(client: PoppyClient, company: Company, account: string | null): number {
  return account === null ? 0 : client.accountGeneration(company.issuer, account);
}

function sameContextSession(client: PoppyClient, company: Company, entry: ContextEntry, session: ReturnType<PoppyClient["session"]>): boolean {
  return sameAuthority(entry, sessionAuthority(session))
    && entry.scope === canonicalScope(session?.scope)
    && entry.accountGeneration === accountGeneration(client, company, session?.account ?? null);
}

async function dropContext(contexts: Map<string, ContextEntry>, key: string, expected?: ContextEntry): Promise<void> {
  const entry = expected ?? contexts.get(key);
  if (contexts.get(key) === entry) contexts.delete(key);
  if (entry) await (await entry.context).close().catch(() => undefined);
}

/**
 * A host on the Company's domain: the domain itself or a host under it. A
 * domain that begins with `www.` is compared as it is, so `www.example.com`
 * browses its own pages; `www.example.com` under `example.com` is already a
 * host under it.
 */
export function onCompanyDomain(company: Pick<Company, "domain">, url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const domain = company.domain.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

/** A host without a leading `www.`, for telling whether an issuer is the Company's own website. */
const site = (host: string) => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/**
 * The Company's sign-in pages, which are the User's alone (spec 4.4): its
 * authorization, device and Mediated Sign-In endpoints and anything under
 * them, and the whole of its issuer's host when that host is a sign-in host
 * of its own (`auth.example.com`). A Company whose issuer is its website's
 * own origin (`https://example.com`) keeps its website browsable.
 */
export function isSignInPage(company: Company, url: URL): boolean {
  const endpoints = [company.endpoints?.authorization, company.endpoints?.deviceAuthorization, company.signIn.mediated?.endpoint]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value));
  const under = (endpoint: URL) => {
    const path = endpoint.pathname.replace(/\/+$/, "");
    return url.origin === endpoint.origin && (url.pathname === path || url.pathname.startsWith(`${path}/`));
  };
  if (endpoints.some(under)) return true;
  const issuer = new URL(company.issuer);
  const website = site(issuer.hostname) === site(company.domain);
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
      context: browser.newContext(
        (url) => { guard(url); checkContext(client, company, label, fresh); },
        (url, method) => client.pageHeaders(company, label, { method, url: url.href }),
        [company.domain]
      ),
      sessionId: session?.session_id ?? null, account: session?.account ?? null, authorityGeneration: session?.authority_generation ?? 0,
      scope: canonicalScope(session?.scope), accountGeneration: accountGeneration(client, company, session?.account ?? null), joined: false
    };
    contexts.set(key, fresh);
    return fresh;
  };
  // Signed pages name the Session, so it exists, as its pages will declare it, before the context binds to it.
  if (client.signsPages(company)) client.preparedSession(company, label);
  let entry = contexts.get(key);
  const before = client.session(company.issuer, label);
  if (entry && !sameContextSession(client, company, entry, before)) {
    await dropContext(contexts, key);
    entry = undefined;
  }
  entry ??= open();
  if (endpoint && (!entry.joined || rejoin)) {
    if (!entry.joining) {
      await client.token(company, { label });
      const session = client.session(company.issuer, label)!;
      // Preparation may have signed the Session out, or started a new one.
      if (!sameContextSession(client, company, entry, session)) {
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
    await client.pageLimited(company, page.status, page.retryAfter);
    throw new PoppyError("browser_join_failed", `${company.name} asked us to wait before joining the browser to the Session`, page.status);
  }
  if (!page.code || !page.action) throw new PoppyError("browser_join_failed", `${company.name}'s browser-session page didn't give a code to join with`, page.status);
  const { code } = page;
  const authorize = `${endpoint.replace(/\/+$/, "")}/authorize`;
  let authorized: { readonly sessionId: string; readonly account: string | null; readonly authorityGeneration: number; readonly scope: string; readonly accountGeneration: number } | undefined;
  // 0.4: the website acts with the token only when it has poppy:browser-sign-in (6), so without it the
  // code is authorized signed out; a Company that refuses the token anyway gets the same code again without it.
  const signsInWebsite = company.protocolVersion === "0.3" || scopeSet(entry.scope).has(BROWSER_SIGN_IN);
  const authorizeCode = (noToken: boolean) => client.resourceJson(company, EndpointRequest.to(company, { method: "POST", url: authorize, body: { code } }), {
    label,
    ...(noToken ? { noToken: true } : {}),
    beforeDispatch: () => {
      const session = client.session(company.issuer, label);
      if (!session || session.account !== entry.account || session.authority_generation !== entry.authorityGeneration
        || canonicalScope(session.scope) !== entry.scope || accountGeneration(client, company, session.account) !== entry.accountGeneration
        || contextsOf(client).get(JSON.stringify([company.issuer, label])) !== entry) {
        throw new PoppyError("approval_changed", "The account or browser changed while joining. Open a fresh page.", 0);
      }
      // resource() may have retried session_ended with a fresh SID. Its
      // dispatch guard makes this the binding actually sent on that attempt.
      authorized = { sessionId: session.session_id, account: session.account, authorityGeneration: session.authority_generation, scope: entry.scope, accountGeneration: entry.accountGeneration };
      entry.sessionId = authorized.sessionId;
      check();
    }
  });
  try {
    await authorizeCode(!signsInWebsite);
    entry.websiteSignedOut = !signsInWebsite && entry.account !== null;
  } catch (error) {
    if (!signsInWebsite || entry.account === null || company.protocolVersion === "0.3" || !hasCode(error, "insufficient_scope")) throw error;
    await authorizeCode(true);
    entry.websiteSignedOut = true;
  }
  const checkAuthorized = () => {
    check();
    if (!authorized || !sameAuthority(entry, authorized) || entry.scope !== authorized.scope || entry.accountGeneration !== authorized.accountGeneration) {
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

/** Why a signed-in Session's browser is signed out on the website (0.4 6), and what would change it. */
function websiteSignedOutNote(company: Company): string {
  const unscoped = company.web?.unscoped ? `; on this website it gives everything the account can do there, so ask the User first` : "";
  return `The website sees this browser signed out: the sign-in at ${company.name} doesn't include ${BROWSER_SIGN_IN}, which the website needs to act for the account. Call poppy_sign_in with that scope if the task needs the website signed in${unscoped}.`;
}

function snapshotForModel(snapshot: PageSnapshot): { [key: string]: Json } {
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
/**
 * 0.4's `web.disabled` (6): the Company asks agents not to use a browser on
 * its website. Pages may still be read, as 5.2 allows a page fetched without
 * a browser, but a form is a browser's work, so none is filled or sent
 * ([reading](../../docs/readings.md#v04-web-disabled)).
 */
function refuseFormsIfDisabled(company: Company): void {
  if (company.web?.disabled) {
    throw new PoppyError("refused", `${company.name} asks agents not to use its website in a browser, so its forms aren't filled or sent; pages can still be read. Use its Company Agent or APIs instead (poppy_discover lists them).`, 0);
  }
}

export async function browse(
  client: PoppyClient,
  browser: PoppyBrowser,
  company: Company,
  label: string,
  action: BrowseAction
): Promise<Json> {
  if (action.kind !== "open" && action.kind !== "click") refuseFormsIfDisabled(company);
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
    if (!active.entry.websiteSignedOut) return snapshotForModel(snapshot);
    return { ...snapshotForModel(snapshot), note: websiteSignedOutNote(company) };
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

type BrowserBinding = { readonly account: string | null; readonly sessionId: string | null; readonly contextId: string; readonly authorityGeneration: number };

/**
 * The context an approved submission was prepared in, still open and bound
 * to the same account and Session, and only where the browser may go for
 * the Company now (its page and action checked again; the browser checks
 * every hop too).
 */
async function approvedContext(client: PoppyClient, company: Company, label: string, submission: FormSubmission, binding: BrowserBinding | undefined) {
  // The Company may have set web.disabled since the User approved.
  refuseFormsIfDisabled(company);
  const guard = pageGuard(company);
  guard(new URL(submission.from));
  guard(new URL(submission.action));
  const entry = contextsOf(client).get(JSON.stringify([company.issuer, label]));
  if (!entry) throw new Error("The page is no longer open");
  if (!binding || binding.contextId !== entry.id || !sameAuthority(binding, entry)) throw new PoppyError("approval_changed", "The account, Session or page context changed. Review a fresh form.", 0);
  checkContext(client, company, label, entry);
  return { entry, handle: await entry.context };
}

/**
 * 0.4 Ops 4: the operation a website returned to our browser, taken only
 * from the final response's own `Poppy-Operation`, never from anything a
 * page says, and only when `sid` names the Session this browser joined at a
 * Company that lists its operations endpoint. Any other header is ignored.
 */
function websiteOperation(company: Company, entry: ContextEntry, snapshot: PageSnapshot): { readonly ref: string; readonly endpoint: string } | null {
  const endpoint = company.extensions.operationsEndpoint;
  if (snapshot.operationHeader === undefined || !endpoint || operationsVersion(company) !== "3" || !company.web?.browserSessionEndpoint) return null;
  if (!entry.joined || entry.sessionId === null) return null;
  const header = parseOperationHeader(snapshot.operationHeader);
  return header && header.sid === entry.sessionId ? { ref: header.ref, endpoint } : null;
}

/**
 * Our own request to the Company's operations endpoint with a reference
 * (0.4 Ops 4, 6): in the browser's Session, never another, with the
 * Session header and, signed in, the access token; with the approval when
 * sending one.
 */
async function atOperationsEndpoint(
  client: PoppyClient, company: Company, label: string, entry: ContextEntry, endpoint: string, ref: string, approval: SentApproval | null, beforeDispatch: () => void
): Promise<{ readonly status: number; readonly body: Json }> {
  const request = EndpointRequest.to(company, { method: "POST", url: endpoint, body: { ref }, ...(approval ? { headers: { "Poppy-Approval": approvalHeader(approval) } } : {}) });
  const response = await client.resource(company, request, {
    label,
    beforeDispatch: () => {
      beforeDispatch();
      if (client.session(company.issuer, label)?.session_id !== entry.sessionId) {
        throw new PoppyError("approval_changed", "The Session changed since the website returned this operation. Open the page and submit again.", 0);
      }
    }
  });
  const text = await client.readBody(response);
  let body: Json = null;
  try {
    body = text ? parseStrictJson(text) : null;
  } catch {
    body = text.slice(0, 2_000);
  }
  return { status: response.status, body };
}

/** The values the User could see in the form, which the operation's terms are compared with (0.4 Ops 8.2). */
function formAsked(submission: FormSubmission): Json {
  return Object.fromEntries(submission.fields.filter((field) => !field.hidden).map((field) => [field.name, field.value]));
}

/**
 * The card for the operation the endpoint returned for a reference (0.4
 * Ops 4, 5): the Company's terms, exactly, approved by the User or by the
 * agent on the User's standing instruction. Throws for any other answer.
 */
async function proposeWebOperation(
  client: PoppyClient, company: Company, label: string, ref: string, submission: FormSubmission, binding: BrowserBinding,
  answer: { readonly status: number; readonly body: Json }, executingApproval: string
): Promise<string> {
  const { status, body } = answer;
  if (status === 403 && isObject(body) && body.error === "approval_required") {
    const operation = parseOperationV2(body.operation, "3");
    if ("problem" in operation) {
      await unusableApproval(client, company, operation.problem);
      throw withAnswer(new PoppyError("unusable_proposal", `${company.name} asked for approval of an operation the agent can't use, so nothing was done`, 403), 403);
    }
    const approval = { operation_id: operation.operation_id, revision: operation.revision, expires_at: operation.expires_at };
    return proposeApproval(client, company, label, operation, formAsked(submission), { kind: "web-operation", ref, approval, submission, binding }, executingApproval);
  }
  // The reference expired, or the Session can't use it (Ops 4): the browser has to make the request again.
  if (status === 400) {
    throw withAnswer(new PoppyError("invalid_request", `${company.name} no longer has the operation its website returned, so nothing was done. Submit the form again for current terms.`, 400), 400);
  }
  const code = companyErrorCode(isObject(body) ? body.error : undefined, status);
  throw withAnswer(new PoppyError(code, `${company.name}'s operations endpoint answered ${status}: ${JSON.stringify(body).slice(0, 500)}`, status), status);
}

const ASKS_FOR_TERMS = (company: Company) => `${company.name}'s website asks you to approve its exact terms first, on the next card. Nothing has happened yet.`;

/**
 * An approved form submit: exactly the fields the User approved, in the same
 * Session's context. Under 0.4 the website may answer with an operation
 * instead of doing it (Ops 4), which then waits on its own card.
 */
registerExecutor("browse-submit", async (client, company, { submission, binding }, label, execution) => {
  const { entry, handle } = await approvedContext(client, company, label, submission, binding);
  await client.beforeRequest(company);
  const check = () => { execution.beforeDispatch(); checkContext(client, company, label, entry); };
  const snapshot = await handle.submit(submission, check);
  const operation = websiteOperation(company, entry, snapshot);
  if (operation) {
    const answer = await atOperationsEndpoint(client, company, label, entry, operation.endpoint, operation.ref, null, check);
    throw new TermsRequested(ASKS_FOR_TERMS(company), await proposeWebOperation(client, company, label, operation.ref, submission, binding, answer, execution.approvalId));
  }
  return `Now at ${snapshot.url} (HTTP ${snapshot.status}): ${snapshot.title}`;
});

/**
 * An approved operation of the website's (0.4 Ops 6): the approval goes to
 * the operations endpoint, never through the browser, and is recorded
 * there; then the browser makes the same request again, which performs it.
 * A new reference, or no answer, means looking the earlier one up before
 * anything else (Ops 7): performed is done, performing is unknown, and an
 * approval still waiting did nothing.
 */
registerExecutor("web-operation", async (client, company, approval, label, execution) => {
  if (!approvable(approval.approval, Date.now())) throw expired(company);
  const { entry, handle } = await approvedContext(client, company, label, approval.submission, approval.binding);
  const endpoint = company.extensions.operationsEndpoint;
  if (!endpoint || operationsVersion(company) !== "3") {
    throw new PoppyError("approval_changed", `${company.name} no longer lists where its website's operations are approved, so the approval wasn't sent.`, 0);
  }
  const check = () => { execution.beforeDispatch(); checkContext(client, company, label, entry); };
  const recorded = await atOperationsEndpoint(client, company, label, entry, endpoint, approval.ref, toSend(company, approval.approval, execution), check);
  if (recorded.status === 403) {
    const declined = readDecline(company, recorded.body, approval.approval, true);
    if (declined) throw withAnswer(declined, 403);
    const operation = isObject(recorded.body) ? parseOperationV2(recorded.body.operation, "3") : null;
    // An approved revision returned unchanged is a refusal, never a new card (Ops 6).
    if (operation && !("problem" in operation) && operation.operation_id === approval.approval.operation_id && operation.revision === approval.approval.revision) {
      throw withAnswer(new PoppyError("approval_required", `${company.name} asks for approval of new terms first; nothing was done`, 403), 403);
    }
    throw new TermsRequested(ASKS_FOR_TERMS(company), await proposeWebOperation(client, company, label, approval.ref, approval.submission, approval.binding, recorded, execution.approvalId));
  }
  if (recorded.status !== 204) {
    const code = companyErrorCode(isObject(recorded.body) ? recorded.body.error : undefined, recorded.status);
    const why = recorded.status === 400 ? "the operation expired or can't be approved in this Session" : JSON.stringify(recorded.body).slice(0, 500);
    throw withAnswer(new PoppyError(code, `${company.name} didn't take the approval (${why}), so nothing was done`, recorded.status), recorded.status);
  }
  // Recorded, and nothing performed yet: the browser makes the request again, and once more if no answer came (Ops 7).
  let snapshot: PageSnapshot | undefined;
  for (let attempt = 0; attempt < 2 && !snapshot; attempt++) {
    try {
      await client.beforeRequest(company);
      snapshot = await handle.submit(approval.submission, check);
    } catch (error) {
      if (answerOf(error) !== "none" || attempt === 1) break;
    }
  }
  if (snapshot && snapshot.status < 400 && snapshot.operationHeader === undefined) {
    return `Now at ${snapshot.url} (HTTP ${snapshot.status}): ${snapshot.title}`;
  }
  let state: Json | undefined;
  try {
    const looked = await atOperationsEndpoint(client, company, label, entry, endpoint, approval.ref, null, check);
    if (looked.status === 200 && isObject(looked.body) && looked.body.operation_id === approval.approval.operation_id) state = looked.body.status;
  } catch {
    // Unknown below.
  }
  const page = snapshot ? ` The website now shows ${snapshot.url} (HTTP ${snapshot.status}).` : "";
  if (state === "performed") return `${company.name} says it performed the operation.${page}`;
  if (state === "approved") {
    const why = `${company.name}'s website didn't use the recorded approval for the repeated request, so nothing was done. Open the page and submit the form again before it expires.`;
    throw snapshot ? withAnswer(new PoppyError("approval_changed", why, snapshot.status), snapshot.status) : new PoppyError("approval_changed", why, 0);
  }
  throw new OperationOutcomeUnknown(`${company.name} recorded the approval, but whether its website performed the operation isn't known yet.${page} Check with ${company.name} before approving it again.`);
});
