import { PoppyClient, PoppyError } from "./client";
import type { Company } from "./discovery";
import { assertPublicHost, PoppyFetchError } from "./fetch";
import type { Json } from "./json";
import { browserAssertion } from "./jwt";
import { currentKey } from "./keys";
import { proposeLocal, registerExecutor } from "./operations";

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
  /** The response's `Retry-After`, if any, which a 429 or 503 must be waited out by (spec 4.3). */
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
  /** A top-level form POST, as a page that submits itself would make (spec 5). */
  postForm(action: string, fields: Readonly<Record<string, string>>): Promise<{ url: string; status: number; retryAfter?: string }>;
  goto(url: string): Promise<PageSnapshot>;
  /** Follows a link; never sends a form. */
  click(selector: string): Promise<PageSnapshot>;
  fill(selector: string, value: string): Promise<PageSnapshot>;
  /** What submitting a form would send now, for the User to approve. */
  prepareSubmit(selector: string): Promise<FormSubmission>;
  /** Sends an approved submission, as it was approved. */
  submit(submission: FormSubmission): Promise<PageSnapshot>;
  close(): Promise<void>;
}

/** Starts browser contexts (`FetchBrowser` in production), each held to `guard`. */
export interface PoppyBrowser {
  newContext(guard: PageGuard): Promise<BrowserContextHandle>;
}

type ContextEntry = {
  readonly context: Promise<BrowserContextHandle>;
  /** The Session the context joined; a context never outlives it. */
  sessionId?: string;
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

async function dropContext(contexts: Map<string, ContextEntry>, key: string): Promise<void> {
  const entry = contexts.get(key);
  contexts.delete(key);
  if (entry) await (await entry.context).close().catch(() => undefined);
}

function onCompanyDomain(company: Company, url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return host === company.domain || host.endsWith(`.${company.domain}`);
}

/** Origins of the Company's sign-in pages, which are the User's alone (spec 4.4). */
function signInOrigins(company: Company): string[] {
  return [company.issuer, company.endpoints.authorization, company.endpoints.deviceAuthorization]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value).origin);
}

/**
 * Where the browser may go for a Company, checked on every request and
 * redirect: HTTPS, a public host, the Company's own domain, and never its
 * sign-in pages. `endpoint`, the browser-session endpoint, is allowed even
 * on a sign-in host: the join must reach it.
 */
function pageGuard(company: Company, endpoint?: string): PageGuard {
  const signIn = signInOrigins(company);
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
    if (signIn.includes(url.origin)) {
      throw new PoppyError("refused", "The agent never opens a company's sign-in pages; the User signs in themselves (use poppy_sign_in)", 0);
    }
  };
}

/**
 * The Session's browser context, joined to the Session first when the
 * Company has `web.browser_session_endpoint` (spec 5): a browser assertion
 * POSTed in the body as a top-level navigation, from our own browser only.
 * A new Session gets a new context, so no cookie crosses Sessions.
 */
async function sessionContext(
  client: PoppyClient,
  browser: PoppyBrowser,
  company: Company,
  label: string,
  returnTo: URL,
  rejoin = false
): Promise<BrowserContextHandle> {
  const key = `${company.issuer}|${label}`;
  const contexts = contextsOf(client);
  const endpoint = company.web?.browserSessionEndpoint;
  const open = (): ContextEntry => {
    if (contexts.size >= MAX_CONTEXTS) void dropContext(contexts, contexts.keys().next().value!);
    const fresh: ContextEntry = { context: browser.newContext(pageGuard(company, endpoint)) };
    contexts.set(key, fresh);
    return fresh;
  };
  let entry = contexts.get(key);
  if (entry?.sessionId && entry.sessionId !== client.session(company.issuer, label)?.session_id) {
    await dropContext(contexts, key);
    entry = undefined;
  }
  entry ??= open();
  if (endpoint && (!entry.sessionId || rejoin)) {
    // `return_to` must be HTTPS on the Company's own domain (spec 5).
    if (returnTo.protocol !== "https:" || !onCompanyDomain(company, returnTo)) {
      throw new PoppyError("invalid_request", `return_to must be on ${company.domain}`, 0);
    }
    await client.token(company, { label });
    const session = client.session(company.issuer, label)!;
    // Rejoining may have needed a new Session: then a new context too.
    if (entry.sessionId && entry.sessionId !== session.session_id) {
      await dropContext(contexts, key);
      entry = open();
    }
    const context = await entry.context;
    const assertion = await browserAssertion(await currentKey(client.host.env), {
      clientId: client.identity.clientId,
      userId: client.userId(company.issuer),
      endpoint,
      sessionId: session.session_id,
      returnTo: returnTo.href
    });
    // The join's redirect loads `return_to` too, so it waits for the Company's limits (4.3).
    await client.beforeRequest(company);
    const result = await context.postForm(endpoint, { assertion });
    // Joined, but the page it landed on was rate-limited: `load` loads it again after the wait.
    const landed = result.url !== endpoint && (result.status === 429 || result.status === 503);
    if (result.status >= 400 && !landed) {
      throw new PoppyError("browser_join_failed", `${company.name} didn't accept the browser into the Session`, result.status);
    }
    entry.sessionId = session.session_id;
    if (landed) await client.pageLimited(company, result.status, result.retryAfter);
  }
  return entry.context;
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
    links: snapshot.links.slice(0, 50) as unknown as Json,
    forms: snapshot.forms as unknown as Json
  };
}

/**
 * Load a page within the Company's rate limits (spec 4.3): after any shared
 * `Retry-After`, and again after a short one on 429 or 503, at most three times.
 */
async function load(client: PoppyClient, company: Company, context: BrowserContextHandle, url: URL): Promise<PageSnapshot> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.beforeRequest(company);
    const snapshot = await context.goto(url.href);
    if (!(await client.pageLimited(company, snapshot.status, snapshot.retryAfter))) return snapshot;
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
 * Browse a Company's website in the Session (spec 5). Only the Company's own
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
    const context = await sessionContext(client, browser, company, label, url);
    let snapshot = await load(client, company, context, url);
    // The website stopped recognising the Session: post a new assertion (Guides).
    if ((snapshot.status === 401 || snapshot.status === 403) && company.web?.browserSessionEndpoint) {
      const rejoined = await sessionContext(client, browser, company, label, url, true);
      snapshot = await load(client, company, rejoined, url);
    }
    return snapshotForModel(snapshot);
  }
  const entry = contextsOf(client).get(`${company.issuer}|${label}`);
  if (!entry) throw new PoppyError("invalid_request", "Open a page first", 0);
  if (entry.sessionId && entry.sessionId !== client.session(company.issuer, label)?.session_id) {
    throw new PoppyError("invalid_request", "The Session this page was in has ended; open the page again", 0);
  }
  const handle = await entry.context;
  if (action.kind === "click") {
    await client.beforeRequest(company);
    let snapshot = await handle.click(action.selector);
    if (await client.pageLimited(company, snapshot.status, snapshot.retryAfter)) {
      snapshot = await load(client, company, handle, new URL(snapshot.url));
    }
    return snapshotForModel(snapshot);
  }
  if (action.kind === "fill") {
    if (CREDENTIAL.test(action.selector)) {
      throw new PoppyError("refused", "The agent never types credentials or codes into a website; sign in with poppy_sign_in instead", 0);
    }
    return snapshotForModel(await handle.fill(action.selector, action.value));
  }
  const submission = await handle.prepareSubmit(action.selector);
  const id = await proposeLocal(
    client,
    company,
    label,
    "browse-submit",
    describeSubmission(company, action.selector, submission),
    { issuer: company.issuer, submission: submission as unknown as Json }
  );
  return { proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

/** An approved form submit: exactly the fields the User approved, in the same Session's context. */
registerExecutor("browse-submit", async (client, request, label) => {
  const { issuer, submission } = request as unknown as { issuer: string; submission?: FormSubmission };
  const entry = contextsOf(client).get(`${issuer}|${label}`);
  if (!entry || !submission) throw new Error("The page is no longer open");
  if (entry.sessionId && entry.sessionId !== client.session(issuer, label)?.session_id) {
    throw new Error("The Session the form was in has ended; open the page again");
  }
  const company = client.companyByIssuer(issuer);
  await client.beforeRequest(company);
  const snapshot = await (await entry.context).submit(submission);
  return `Now at ${snapshot.url} (HTTP ${snapshot.status}): ${snapshot.title}`;
});
