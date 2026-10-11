import { PoppyClient, PoppyError } from "./client";
import type { Company } from "./discovery";
import { assertPublicHost } from "./fetch";
import type { Json } from "./json";
import { browserAssertion } from "./jwt";
import { currentKey } from "./keys";
import { proposeLocal, registerExecutor } from "./operations";

/** What the model gets from a page: text and links, never cookies (Guides, "Web browsing"). */
export type PageSnapshot = {
  readonly url: string;
  readonly status: number;
  readonly title: string;
  readonly text: string;
  readonly links: readonly { text: string; href: string }[];
  readonly forms: readonly { selector: string; action: string; method: string; fields: readonly string[] }[];
};

/** One isolated browser storage context: its own cookies and local storage. */
export interface BrowserContextHandle {
  /** A top-level form POST, as a page that submits itself would make (spec 5). */
  postForm(action: string, fields: Readonly<Record<string, string>>): Promise<{ url: string; status: number }>;
  goto(url: string): Promise<PageSnapshot>;
  click(selector: string): Promise<PageSnapshot>;
  fill(selector: string, value: string): Promise<PageSnapshot>;
  submit(selector: string): Promise<PageSnapshot>;
  close(): Promise<void>;
}

/** Starts browser contexts: Browser Rendering in production, a fetch-based fake in tests. */
export interface PoppyBrowser {
  newContext(): Promise<BrowserContextHandle>;
}

const contexts = new Map<string, { context: Promise<BrowserContextHandle>; joined: boolean }>();

function onCompanyDomain(company: Company, url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return host === company.domain || host.endsWith(`.${company.domain}`);
}

/**
 * The Session's browser context, joined to the Session first when the
 * Company has `web.browser_session_endpoint` (spec 5): a browser assertion
 * POSTed in the body as a top-level navigation, from our own browser only.
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
  let entry = contexts.get(key);
  if (!entry) {
    entry = { context: browser.newContext(), joined: false };
    contexts.set(key, entry);
  }
  const context = await entry.context;
  const endpoint = company.web?.browserSessionEndpoint;
  if (endpoint && (!entry.joined || rejoin)) {
    // `return_to` must be HTTPS on the Company's own domain (spec 5).
    if (returnTo.protocol !== "https:" || !onCompanyDomain(company, returnTo)) {
      throw new PoppyError("invalid_request", `return_to must be on ${company.domain}`, 0);
    }
    await client.token(company, { label });
    const session = client.session(company.issuer, label)!;
    const assertion = await browserAssertion(await currentKey(client.host.env), {
      clientId: client.identity.clientId,
      userId: client.userId(company.issuer),
      endpoint,
      sessionId: session.session_id,
      returnTo: returnTo.href
    });
    const result = await context.postForm(endpoint, { assertion });
    if (result.status >= 400) {
      throw new PoppyError("browser_join_failed", `${company.name} didn't accept the browser into the Session`, result.status);
    }
    entry.joined = true;
  }
  return context;
}

/** Close the Session's browser context; called when the Session ends. */
export async function closeBrowserSession(issuer: string, label: string): Promise<void> {
  const key = `${issuer}|${label}`;
  const entry = contexts.get(key);
  contexts.delete(key);
  if (entry) await (await entry.context).close().catch(() => undefined);
}

export type BrowseAction =
  | { readonly kind: "open"; readonly url: string }
  | { readonly kind: "click"; readonly selector: string }
  | { readonly kind: "fill"; readonly selector: string; readonly value: string }
  | { readonly kind: "submit"; readonly selector: string };

/** Fields that look like credentials are never filled by the agent (Guides). */
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
 * Browse a Company's website in the Session (spec 5). Only the Company's own
 * domains; never sign-in pages or credential fields. Form submits wait for
 * the User's approval, like other writes.
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
    if (url.protocol !== "https:" || !onCompanyDomain(company, url)) {
      throw new PoppyError("invalid_request", `Browsing is limited to ${company.domain}`, 0);
    }
    assertPublicHost(url);
    const context = await sessionContext(client, browser, company, label, url);
    let snapshot = await context.goto(url.href);
    // The website stopped recognising the Session: post a new assertion (Guides).
    if ((snapshot.status === 401 || snapshot.status === 403) && company.web?.browserSessionEndpoint) {
      const rejoined = await sessionContext(client, browser, company, label, url, true);
      snapshot = await rejoined.goto(url.href);
    }
    return snapshotForModel(snapshot);
  }
  const context = contexts.get(`${company.issuer}|${label}`);
  if (!context) throw new PoppyError("invalid_request", "Open a page first", 0);
  const handle = await context.context;
  if (action.kind === "click") return snapshotForModel(await handle.click(action.selector));
  if (action.kind === "fill") {
    if (CREDENTIAL.test(action.selector)) {
      throw new PoppyError("refused", "The agent never types credentials or codes into a website; sign in with poppy_sign_in instead", 0);
    }
    return snapshotForModel(await handle.fill(action.selector, action.value));
  }
  const id = await proposeLocal(
    client,
    company,
    label,
    "browse-submit",
    `${company.name}: submit the form ${action.selector} on the website`,
    { issuer: company.issuer, selector: action.selector }
  );
  return { proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

let activeBrowser: PoppyBrowser | undefined;

/** The browser this object uses, so approved form submits can find their context. */
export function setBrowser(browser: PoppyBrowser): void {
  activeBrowser = browser;
}

registerExecutor("browse-submit", async (client, request, label) => {
  const { issuer, selector } = request as unknown as { issuer: string; selector: string };
  const entry = contexts.get(`${issuer}|${label}`);
  if (!entry || !activeBrowser) throw new Error("The page is no longer open");
  const snapshot = await (await entry.context).submit(selector);
  return `Now at ${snapshot.url} (HTTP ${snapshot.status}): ${snapshot.title}`;
});
