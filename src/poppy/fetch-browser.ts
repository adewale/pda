import type { BrowserContextHandle, FormSubmission, PageGuard, PageSnapshot, PoppyBrowser } from "./browser";
import { PoppyError, unreadableAnswerOf, withAnswer, withUnreadableAnswer } from "./client";
import { assertPublicHost, PoppyFetchError, readLimitedBytes, type Fetcher } from "./fetch";

/**
 * Poppy web browsing without a real browser (spec 5): plain HTTPS requests
 * with a cookie jar per context, pages read with `HTMLRewriter`. No
 * JavaScript runs, so a page that builds itself with scripts shows nothing,
 * and only links can be clicked: a form goes only through `submit`, after
 * the User's approval.
 */

export type FetchBrowserOptions = {
  /** Largest page, in bytes. */
  readonly maxBytes?: number;
  /** Time for one navigation, redirects included, in ms. */
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** For cookie expiry. */
  readonly now?: () => number;
};

const DEFAULTS = { maxBytes: 1_000_000, timeoutMs: 15_000, maxRedirects: 5 } as const;

// ---------------------------------------------------------------- Cookies

type Cookie = {
  readonly name: string;
  readonly value: string;
  /** Host-only: sent back to exactly this host, never its subdomains or parent. */
  readonly host: string;
  readonly path: string;
  readonly secure: boolean;
  /** Epoch ms; undefined lasts as long as the context. */
  readonly expires: number | undefined;
};

const MAX_COOKIE_BYTES = 4096;
const MAX_COOKIES_PER_HOST = 50;

/** RFC 6265 5.1.4: the directory of the request path. */
function defaultPath(url: URL): string {
  const path = url.pathname;
  if (!path.startsWith("/") || path.lastIndexOf("/") === 0) return "/";
  return path.slice(0, path.lastIndexOf("/"));
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/**
 * One context's cookies. Simpler than a browser's on purpose: every cookie
 * is host-only (`Domain` never widens it), and cookies go only over HTTPS.
 */
export class CookieJar {
  #cookies: Cookie[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Keep the `Set-Cookie` headers of a response from `url`. */
  store(url: URL, setCookies: readonly string[]): void {
    if (url.protocol !== "https:") return;
    for (const header of setCookies) this.#storeOne(url, header);
  }

  #storeOne(url: URL, header: string): void {
    if (header.length > MAX_COOKIE_BYTES) return;
    const [pair = "", ...attributes] = header.split(";");
    const equals = pair.indexOf("=");
    if (equals <= 0) return;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!name) return;
    const host = url.hostname.toLowerCase();
    let path: string | undefined;
    let secure = false;
    let maxAge: number | undefined;
    let expires: number | undefined;
    let domain: string | undefined;
    for (const attribute of attributes) {
      const at = attribute.indexOf("=");
      const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
      const raw = at === -1 ? "" : attribute.slice(at + 1).trim();
      if (key === "secure") secure = true;
      else if (key === "path" && raw.startsWith("/")) path = raw;
      else if (key === "max-age" && /^-?\d+$/.test(raw)) maxAge = Number(raw);
      else if (key === "expires") {
        const at = Date.parse(raw);
        if (!Number.isNaN(at)) expires = at;
      } else if (key === "domain" && raw) domain = raw.replace(/^\./, "").toLowerCase();
    }
    // A Domain this host couldn't set is refused (RFC 6265 5.3); one it could set still stays host-only.
    if (domain && domain !== host && !host.endsWith(`.${domain}`)) return;
    if (name.startsWith("__Secure-") && !secure) return;
    if (name.startsWith("__Host-") && (!secure || domain || path !== "/")) return;
    const now = this.#now();
    // Max-Age wins over Expires; zero or less, or a past date, deletes it.
    const expiry = maxAge !== undefined ? now + maxAge * 1000 : expires;
    const cookie: Cookie = { name, value, host, path: path ?? defaultPath(url), secure, expires: expiry };
    this.#cookies = this.#cookies.filter(
      (old) => !(old.name === cookie.name && old.host === cookie.host && old.path === cookie.path)
    );
    if (expiry !== undefined && expiry <= now) return;
    this.#cookies.push(cookie);
    const forHost = this.#cookies.filter((old) => old.host === host);
    if (forHost.length > MAX_COOKIES_PER_HOST) {
      const oldest = forHost[0]!;
      this.#cookies = this.#cookies.filter((old) => old !== oldest);
    }
  }

  /** The `Cookie` header for a request to `url`, or "" for none. Never over plain HTTP. */
  header(url: URL): string {
    if (url.protocol !== "https:") return "";
    const now = this.#now();
    this.#cookies = this.#cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now);
    const host = url.hostname.toLowerCase();
    return this.#cookies
      .filter((cookie) => cookie.host === host && pathMatches(url.pathname, cookie.path))
      .sort((a, b) => b.path.length - a.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  clear(): void {
    this.#cookies = [];
  }
}

// ---------------------------------------------------------------- Parsing

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•",
  middot: "·", pound: "£", euro: "€", yen: "¥", cent: "¢", times: "×", divide: "÷", deg: "°"
};

/** `HTMLRewriter` hands over text and attributes as written: decode their character references. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

type Control = {
  readonly tag: "input" | "select" | "textarea" | "button";
  readonly type: string;
  readonly name: string;
  readonly id: string;
  /** The value attribute, or a textarea's text. */
  value: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly readonly: boolean;
  readonly autocomplete: string;
  readonly multiple: boolean;
  readonly options: { value: string; label: string; selected: boolean; disabled: boolean; explicitValue: boolean }[];
  readonly formAction?: string;
  readonly formMethod?: string;
  readonly formEnctype?: string;
};

type ParsedForm = {
  readonly index: number;
  readonly id: string;
  readonly action: string;
  readonly method: string;
  readonly enctype: string;
  readonly controls: Control[];
};

type ParsedLink = { readonly id: string; readonly href: string; text: string };

type ParsedPage = {
  readonly title: string;
  readonly text: string;
  readonly base: string | undefined;
  readonly links: readonly ParsedLink[];
  readonly forms: readonly ParsedForm[];
  readonly scripts: number;
};

const BLOCK = new Set(
  "address article aside blockquote br dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr label legend li main nav ol p pre section summary table tbody td tfoot th thead tr ul option button".split(" ")
);
/** Inline elements that don't separate words. */
const TIGHT = new Set("b i em strong small code sub sup u s mark abbr span kbd var q cite".split(" "));
const MAX_LINKS = 200;
const MAX_FORMS = 20;
const MAX_CONTROLS = 200;

/** Read a page with `HTMLRewriter`: visible text, links and forms. Scripts, styles and templates are skipped. */
async function parseHtml(html: string): Promise<ParsedPage> {
  const text: string[] = [];
  let title = "";
  let titleState: "before" | "in" | "done" = "before";
  let base: string | undefined;
  let hiddenDepth = 0;
  let scripts = 0;
  const links: ParsedLink[] = [];
  const forms: ParsedForm[] = [];
  let link: ParsedLink | undefined;
  let form: ParsedForm | undefined;
  let select: Control | undefined;
  let option: Control["options"][number] | undefined;
  let textarea: Control | undefined;
  const attr = (element: Element, name: string) => decodeEntities(element.getAttribute(name) ?? "");
  const onEnd = (element: Element, handler: () => void) => {
    try {
      element.onEndTag(handler);
    } catch {
      // A void element has no end tag.
    }
  };
  const addControl = (control: Control) => {
    if (form && form.controls.length < MAX_CONTROLS) form.controls.push(control);
  };
  const common = (element: Element) => ({
    name: attr(element, "name"),
    id: attr(element, "id"),
    disabled: element.hasAttribute("disabled"),
    readonly: element.hasAttribute("readonly"),
    autocomplete: attr(element, "autocomplete").toLowerCase(),
    multiple: element.hasAttribute("multiple"),
    checked: element.hasAttribute("checked"),
    options: [] as Control["options"]
  });

  /** One handler for every element, so each registers at most one end-tag handler. */
  const element = (element: Element) => {
    const tag = element.tagName;
    const ends: (() => void)[] = [];
    if (BLOCK.has(tag)) {
      text.push("\n");
      ends.push(() => text.push("\n"));
    } else if (!TIGHT.has(tag)) {
      text.push(" ");
      ends.push(() => text.push(" "));
    }
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") {
      if (tag === "script") scripts++;
      hiddenDepth++;
      ends.push(() => hiddenDepth--);
    } else if (hiddenDepth > 0) {
      // Inside a template: not part of the page.
    } else if (tag === "title") {
      if (titleState === "before") {
        titleState = "in";
        ends.push(() => (titleState = "done"));
      }
    } else if (tag === "base") {
      if (element.hasAttribute("href")) base ??= attr(element, "href");
    } else if ((tag === "a" || tag === "area") && element.hasAttribute("href")) {
      if (links.length < MAX_LINKS) {
        const current: ParsedLink = { id: attr(element, "id"), href: attr(element, "href"), text: tag === "area" ? attr(element, "alt") : "" };
        links.push(current);
        if (tag === "a") {
          link = current;
          ends.push(() => (link = undefined));
        }
      }
    } else if (tag === "form") {
      // Forms don't nest: an inner <form> tag is ignored, as browsers do.
      if (!form && forms.length < MAX_FORMS) {
        const current: ParsedForm = {
          index: forms.length,
          id: attr(element, "id"),
          action: attr(element, "action"),
          method: attr(element, "method").toLowerCase() || "get",
          enctype: attr(element, "enctype").toLowerCase(),
          controls: []
        };
        forms.push(current);
        form = current;
        ends.push(() => (form = undefined));
      }
    } else if (!form) {
      // Controls outside a form aren't sent anywhere.
    } else if (tag === "input" || tag === "button") {
      addControl({
        tag,
        type: attr(element, "type").toLowerCase() || (tag === "button" ? "submit" : "text"),
        value: attr(element, "value"),
        ...common(element),
        ...(element.hasAttribute("formaction") ? { formAction: attr(element, "formaction") } : {}),
        ...(element.hasAttribute("formmethod") ? { formMethod: attr(element, "formmethod").toLowerCase() } : {}),
        ...(element.hasAttribute("formenctype") ? { formEnctype: attr(element, "formenctype").toLowerCase() } : {})
      });
    } else if (tag === "select") {
      const control: Control = { tag: "select", type: "select", value: "", ...common(element) };
      addControl(control);
      select = control;
      ends.push(() => {
        select = undefined;
        option = undefined;
      });
    } else if (tag === "option" && select) {
      // An option's end tag is often left out: the next option ends it.
      option = {
        value: attr(element, "value"),
        label: "",
        selected: element.hasAttribute("selected"),
        disabled: element.hasAttribute("disabled"),
        explicitValue: element.hasAttribute("value")
      };
      select.options.push(option);
    } else if (tag === "textarea") {
      const control: Control = { tag: "textarea", type: "textarea", value: "", ...common(element) };
      addControl(control);
      textarea = control;
      ends.push(() => (textarea = undefined));
    }
    if (ends.length > 0) {
      onEnd(element, () => {
        for (const end of ends) end();
      });
    }
  };

  const rewriter = new HTMLRewriter()
    .on("*", { element })
    .onDocument({
      text(chunk) {
        const piece = chunk.text;
        if (!piece) return;
        if (titleState === "in") {
          title += piece;
          return;
        }
        if (textarea) {
          textarea.value += piece;
          return;
        }
        if (hiddenDepth > 0) return;
        if (option) option.label += piece;
        if (link) link.text += piece;
        text.push(piece);
      }
    });
  await rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).arrayBuffer();

  const clean = (value: string) => decodeEntities(value).replace(/[\s\u00a0]+/g, " ").trim();
  for (const parsed of links) parsed.text = clean(parsed.text);
  for (const parsedForm of forms) {
    for (const control of parsedForm.controls) {
      if (control.tag === "textarea") control.value = decodeEntities(control.value).replace(/^\r?\n/, "");
      for (const choice of control.options) {
        choice.label = clean(choice.label);
        if (!choice.explicitValue) choice.value = choice.label;
      }
    }
  }
  const body = decodeEntities(text.join(""))
    .split("\n")
    .map((line) => line.replace(/[\s\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return { title: clean(title), text: body, base, links, forms, scripts };
}

// ---------------------------------------------------------------- Selectors

/** The selectors snapshots give out, and the few plain CSS forms the model may write instead. */
type Selector =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "href"; readonly href: string }
  | { readonly kind: "nth"; readonly tag: string; readonly n: number };

function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

function parseSelector(raw: string): Selector | undefined {
  const selector = raw.trim();
  const id = /^(?:[a-z]+)?#((?:[\w-]|\\.)+)$/i.exec(selector);
  if (id) return { kind: "id", id: id[1]!.replace(/\\(.)/g, "$1") };
  const attribute = /^(?:[a-z]+)?\[\s*(name|href)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]\s]+))\s*\]$/i.exec(selector);
  if (attribute) {
    const value = (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").replace(/\\(.)/g, "$1");
    return attribute[1]!.toLowerCase() === "name" ? { kind: "name", name: value } : { kind: "href", href: value };
  }
  const nth = /^([a-z]+):nth-of-type\((\d+)\)$/i.exec(selector);
  if (nth) return { kind: "nth", tag: nth[1]!.toLowerCase(), n: Number(nth[2]) };
  if (/^[\w-]+$/.test(selector)) return { kind: "name", name: selector };
  return undefined;
}

// ---------------------------------------------------------------- The context

type Page = {
  readonly url: URL;
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly parsed: ParsedPage;
  /** What `fill` set, by control. */
  readonly filled: Map<Control, string>;
};

type Fetched = { url: URL; status: number; retryAfter: string | undefined; contentType: string; body: Uint8Array };

const CREDENTIAL_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?)$/;
const CREDENTIAL_NAME = /pass(word|code)?|\bpin\b|otp|one.?time|verification.?code|cvv|cvc|card.?number|security.?code/i;
const NOT_FILLABLE = new Set(["hidden", "submit", "image", "reset", "button", "file"]);

function isCredential(control: Control): boolean {
  return (
    control.type === "password" ||
    CREDENTIAL_AUTOCOMPLETE.test(control.autocomplete.split(/\s+/).at(-1) ?? "") ||
    CREDENTIAL_NAME.test(control.name) ||
    CREDENTIAL_NAME.test(control.id)
  );
}

function isSubmitter(control: Control): boolean {
  return (control.tag === "button" && control.type === "submit") || (control.tag === "input" && (control.type === "submit" || control.type === "image"));
}

const SUBMIT_ADVICE = "This browser only follows links: fill the form's fields with fill, then send it with submit, which waits for the User's approval";

class FetchContext implements BrowserContextHandle {
  readonly #fetcher: Fetcher;
  readonly #guard: PageGuard;
  readonly #options: Required<Omit<FetchBrowserOptions, "now">>;
  readonly #jar: CookieJar;
  #page: Page | undefined;
  #closed = false;

  constructor(fetcher: Fetcher, guard: PageGuard, options: FetchBrowserOptions) {
    this.#fetcher = fetcher;
    this.#guard = guard;
    this.#options = {
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      maxRedirects: options.maxRedirects ?? DEFAULTS.maxRedirects
    };
    this.#jar = new CookieJar(options.now);
  }

  /** Every request and every redirect: HTTPS, a public host, and whatever the Company's rules allow. */
  #check(url: URL): void {
    if (url.protocol !== "https:") throw new PoppyError("refused", `The browser only loads HTTPS pages, not ${url.protocol.replace(/:$/, "")}`, 0);
    try {
      assertPublicHost(url);
    } catch (error) {
      if (error instanceof PoppyFetchError) throw new PoppyError("refused", error.message, 0);
      throw error;
    }
    this.#guard(url);
  }

  async #navigate(
    start: URL,
    init: { method: "GET" | "POST"; body?: URLSearchParams | FormData; origin?: string; discardBody?: boolean; beforeDispatch?: () => void }
  ): Promise<Fetched> {
    if (this.#closed) throw new PoppyError("invalid_request", "The page is no longer open", 0);
    const signal = AbortSignal.timeout(this.#options.timeoutMs);
    let current = start;
    let method = init.method;
    let body = init.body;
    let sent = false;
    let answered: number | undefined;
    try {
      for (let hop = 0; ; hop++) {
        this.#check(current);
        const headers = new Headers({ Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5,*/*;q=0.1" });
        // The Session's cookies, to this host only. Nothing else of ours goes with a page request.
        const cookie = this.#jar.header(current);
        if (cookie) headers.set("Cookie", cookie);
        if (body instanceof URLSearchParams) headers.set("Content-Type", "application/x-www-form-urlencoded");
        if (hop === 0 && init.origin && method === "POST") headers.set("Origin", init.origin);
        const outbound = new Request(current.href, { method, headers, redirect: "manual", signal, ...(body ? { body } : {}) });
        init.beforeDispatch?.();
        sent = true;
        answered = undefined;
        const response = await this.#fetcher(outbound);
        answered = response.status;
        this.#jar.store(current, response.headers.getSetCookie());
        const location = response.headers.get("Location");
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel();
          if (hop >= this.#options.maxRedirects) throw new PoppyError("refused", `Too many redirects from ${start.href}`, 0);
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new PoppyError("refused", `${current.href} redirected to something that isn't a URL`, 0);
          }
          // 303, and 301 or 302 after a POST, continue as a GET (Fetch, "HTTP-redirect fetch").
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
          }
          current = next;
          continue;
        }
        let bytes: Uint8Array = new Uint8Array(0);
        try {
          if (init.discardBody) await response.body?.cancel();
          else bytes = await readLimitedBytes(response, this.#options.maxBytes, signal);
        } catch (error) {
          const failure = error instanceof PoppyFetchError ? new PoppyError("too_large", `${current.href} is larger than ${this.#options.maxBytes} bytes`, 0) : error;
          throw init.method === "POST" ? withUnreadableAnswer(failure, response.status) : failure;
        }
        return {
          url: current,
          status: response.status,
          retryAfter: response.headers.get("Retry-After") ?? undefined,
          contentType: (response.headers.get("Content-Type") ?? "").toLowerCase(),
          body: bytes
        };
      }
    } catch (error) {
      const failure = signal.aborted ? new PoppyError("timeout", `${current.host} took longer than ${this.#options.timeoutMs / 1000} s`, 0) : error;
      const unreadable = unreadableAnswerOf(error);
      if (unreadable !== undefined) throw withUnreadableAnswer(failure, unreadable);
      if (init.method === "POST" && sent) throw withAnswer(failure, answered ?? "none");
      throw failure;
    }
  }

  async #load(fetched: Fetched): Promise<PageSnapshot> {
    const charset = /charset=["']?([\w-]+)/.exec(fetched.contentType)?.[1] ?? "utf-8";
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset);
    } catch {
      decoder = new TextDecoder("utf-8");
    }
    const source = decoder.decode(fetched.body);
    const mime = fetched.contentType.split(";")[0]!.trim();
    let parsed: ParsedPage;
    if (mime === "" || mime === "text/html" || mime === "application/xhtml+xml") {
      parsed = await parseHtml(source);
    } else if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
      parsed = { title: "", text: source, base: undefined, links: [], forms: [], scripts: 0 };
    } else {
      parsed = { title: "", text: `(A ${mime} file, which this browser doesn't show.)`, base: undefined, links: [], forms: [], scripts: 0 };
    }
    this.#page = { url: fetched.url, status: fetched.status, retryAfter: fetched.retryAfter, parsed, filled: new Map() };
    return this.#snapshot();
  }

  #baseUrl(page: Page): URL {
    try {
      return page.parsed.base ? new URL(page.parsed.base, page.url) : page.url;
    } catch {
      return page.url;
    }
  }

  #resolve(page: Page, href: string): URL | undefined {
    try {
      return new URL(href, this.#baseUrl(page));
    } catch {
      return undefined;
    }
  }

  #linkSelector(page: Page, link: ParsedLink): string {
    const unique = link.id && page.parsed.links.filter((other) => other.id === link.id).length === 1;
    return unique ? `#${link.id}` : `a[href=${cssString(link.href)}]`;
  }

  #formSelector(page: Page, form: ParsedForm): string {
    const unique = form.id && page.parsed.forms.filter((other) => other.id === form.id).length === 1;
    return unique ? `#${form.id}` : `form:nth-of-type(${form.index + 1})`;
  }

  #snapshot(): PageSnapshot {
    const page = this.#current();
    const { parsed } = page;
    const text =
      parsed.text || (parsed.scripts > 0 ? "(This page shows nothing without JavaScript, which this browser doesn't run.)" : "");
    return {
      url: page.url.href,
      status: page.status,
      title: parsed.title,
      text,
      links: parsed.links.flatMap((link) => {
        const url = this.#resolve(page, link.href);
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return [];
        return [{ text: link.text, href: url.href, selector: this.#linkSelector(page, link) }];
      }),
      forms: parsed.forms.map((form) => ({
        selector: this.#formSelector(page, form),
        action: (this.#resolve(page, form.action) ?? page.url).href,
        method: form.method.toUpperCase(),
        fields: [
          ...new Set(
            form.controls.filter((control) => control.name && !NOT_FILLABLE.has(control.type) && !control.disabled).map((control) => control.name)
          )
        ]
      })),
      ...(page.retryAfter ? { retryAfter: page.retryAfter } : {})
    };
  }

  #current(): Page {
    if (!this.#page) throw new PoppyError("invalid_request", "Open a page first", 0);
    return this.#page;
  }

  #findForm(page: Page, selector: Selector | undefined): ParsedForm | undefined {
    if (!selector) return undefined;
    const forms = page.parsed.forms;
    if (selector.kind === "id") return forms.find((form) => form.id === selector.id);
    if (selector.kind === "nth" && selector.tag === "form") return forms[selector.n - 1];
    return undefined;
  }

  /** Controls a selector names: by id or name, optionally after a form's selector and a space. */
  #findControls(page: Page, raw: string): { form: ParsedForm; control: Control }[] {
    const trimmed = raw.trim();
    const space = trimmed.search(/\s+(?=[^\s]+$)/);
    let forms = page.parsed.forms;
    let fieldPart = trimmed;
    const scoped = space > 0 ? this.#findForm(page, parseSelector(trimmed.slice(0, space))) : undefined;
    if (scoped) {
      forms = [scoped];
      fieldPart = trimmed.slice(space).trim();
    }
    const selector = parseSelector(fieldPart);
    if (!selector) return [];
    return forms.flatMap((form) =>
      form.controls
        .filter((control) =>
          selector.kind === "id" ? control.id === selector.id : selector.kind === "name" ? control.name === selector.name : false
        )
        .map((control) => ({ form, control }))
    );
  }

  async postForm(action: string, fields: Readonly<Record<string, string>>) {
    // The browser assertion, in the body of a top-level POST, never in a URL (spec 5).
    // Where it lands is loaded again by `goto`, so its body isn't read here.
    const fetched = await this.#navigate(new URL(action), { method: "POST", body: new URLSearchParams(fields), discardBody: true });
    return { url: fetched.url.href, status: fetched.status, ...(fetched.retryAfter ? { retryAfter: fetched.retryAfter } : {}) };
  }

  async goto(url: string): Promise<PageSnapshot> {
    return this.#load(await this.#navigate(new URL(url), { method: "GET" }));
  }

  async joinCode(endpoint: string): Promise<{ status: number; code?: string; action?: string }> {
    // A top-level GET of the browser-session page, keeping the cookie it sets (0.3 6, step 1).
    const fetched = await this.#navigate(new URL(endpoint), { method: "GET" });
    await this.#load(fetched);
    const page = this.#current();
    // Its own page, and nowhere a redirect took us.
    if (page.url.href !== new URL(endpoint).href || fetched.status !== 200) return { status: fetched.status };
    for (const form of page.parsed.forms) {
      const action = this.#resolve(page, form.action) ?? page.url;
      if (form.method !== "post" || `${action.origin}${action.pathname}` !== `${page.url.origin}${page.url.pathname}`) continue;
      const code = form.controls.find((control) => control.name === "code" && control.type === "hidden" && !control.disabled);
      if (code && code.value !== "") return { status: fetched.status, code: code.value, action: action.href };
    }
    return { status: fetched.status };
  }

  /** Follows a link. Never a form: clicking a button would send it without the User's approval. */
  async click(raw: string): Promise<PageSnapshot> {
    const page = this.#current();
    const selector = parseSelector(raw);
    const links = page.parsed.links;
    const link = !selector
      ? undefined
      : links.find((candidate) => this.#linkSelector(page, candidate) === raw.trim()) ??
        (selector.kind === "id"
          ? links.find((candidate) => candidate.id === selector.id)
          : selector.kind === "href"
            ? links.find((candidate) => candidate.href === selector.href || this.#resolve(page, candidate.href)?.href === selector.href)
            : selector.kind === "nth" && selector.tag === "a"
              ? links[selector.n - 1]
              : undefined);
    if (!link) {
      const formish =
        /\b(button|input|select|textarea|form|submit)\b/i.test(raw) ||
        this.#findForm(page, selector) !== undefined ||
        this.#findControls(page, raw).length > 0;
      if (formish) throw new PoppyError("refused", `${raw} is part of a form, not a link. ${SUBMIT_ADVICE}.`, 0);
      throw new PoppyError("invalid_request", `No link ${raw} on this page; use a selector from the page's links`, 0);
    }
    const url = this.#resolve(page, link.href);
    if (!url) throw new PoppyError("invalid_request", `The link ${raw} doesn't go anywhere`, 0);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new PoppyError("refused", `The link ${raw} needs JavaScript or another app (${url.protocol}), which this browser doesn't have`, 0);
    }
    // A link within the page: nothing to load.
    if (url.href.split("#")[0] === page.url.href.split("#")[0] && url.hash) return this.#snapshot();
    return this.goto(url.href);
  }

  async fill(raw: string, value: string): Promise<PageSnapshot> {
    const page = this.#current();
    const found = this.#findControls(page, raw);
    if (found.length === 0) throw new PoppyError("invalid_request", `No field ${raw} on this page`, 0);
    const forms = new Set(found.map((match) => match.form));
    if (forms.size > 1) {
      throw new PoppyError("invalid_request", `${raw} is in more than one form; put the form's selector first, as in "${this.#formSelector(page, found[0]!.form)} ${raw}"`, 0);
    }
    const controls = found.map((match) => match.control);
    const first = controls[0]!;
    if (controls.some(isCredential)) {
      throw new PoppyError("refused", "The agent never types credentials or codes into a website; sign in with poppy_sign_in instead", 0);
    }
    if (isSubmitter(first)) throw new PoppyError("refused", `${raw} is a button. ${SUBMIT_ADVICE}.`, 0);
    if (NOT_FILLABLE.has(first.type)) throw new PoppyError("refused", `${raw} is a ${first.type} field, which the website sets itself`, 0);
    if (first.disabled || first.readonly) throw new PoppyError("refused", `${raw} can't be changed`, 0);
    if (first.type === "radio") {
      const choice = controls.find((control) => control.type === "radio" && (control.value || "on") === value);
      if (!choice) throw new PoppyError("invalid_request", `${raw} has no choice ${JSON.stringify(value)}; the choices are ${controls.map((control) => JSON.stringify(control.value || "on")).join(", ")}`, 0);
      for (const control of controls) page.filled.set(control, control === choice ? "checked" : "");
    } else if (first.type === "checkbox") {
      page.filled.set(first, /^(|false|off|no|0|unchecked)$/i.test(value.trim()) ? "" : "checked");
    } else if (first.tag === "select") {
      const choice = first.options.find((option) => !option.disabled && (option.value === value || option.label === value));
      if (!choice) throw new PoppyError("invalid_request", `${raw} has no option ${JSON.stringify(value)}; the options are ${first.options.map((option) => JSON.stringify(option.label)).join(", ")}`, 0);
      page.filled.set(first, choice.value);
    } else {
      page.filled.set(first, value);
    }
    return this.#snapshot();
  }

  async prepareSubmit(raw: string): Promise<FormSubmission> {
    const page = this.#current();
    const selector = parseSelector(raw);
    let form = this.#findForm(page, selector);
    let submitter: Control | undefined;
    if (!form) {
      const buttons = this.#findControls(page, raw).filter((match) => isSubmitter(match.control));
      if (buttons.length === 1) ({ form, control: submitter } = buttons[0]!);
    }
    if (!form) throw new PoppyError("invalid_request", `No form ${raw} on this page; use a selector from the page's forms`, 0);
    const fields: { name: string; value: string; hidden: boolean }[] = [];
    for (const control of form.controls) {
      if (!control.name || control.disabled) continue;
      const filled = page.filled.get(control);
      if (isSubmitter(control) || control.tag === "button") {
        if (control === submitter && control.type !== "image") fields.push({ name: control.name, value: control.value, hidden: false });
        continue;
      }
      if (control.type === "reset" || control.type === "file") continue;
      if (control.type === "checkbox" || control.type === "radio") {
        const checked = filled !== undefined ? filled === "checked" : control.checked;
        if (checked) fields.push({ name: control.name, value: control.value || "on", hidden: false });
        continue;
      }
      if (control.tag === "select") {
        if (filled !== undefined) {
          fields.push({ name: control.name, value: filled, hidden: false });
          continue;
        }
        const selected = control.options.filter((option) => option.selected && !option.disabled);
        const chosen = control.multiple ? selected : [selected.at(-1) ?? control.options.find((option) => !option.disabled)].filter((option) => option !== undefined);
        for (const option of chosen) fields.push({ name: control.name, value: option.value, hidden: false });
        continue;
      }
      // A password field's value, the page's own, is sent but never shown on the approval card.
      fields.push({ name: control.name, value: filled ?? control.value, hidden: control.type === "hidden" || control.type === "password" });
    }
    const method = (submitter?.formMethod ?? form.method) === "post" ? "POST" : "GET";
    if ((submitter?.formMethod ?? form.method) === "dialog") throw new PoppyError("refused", `The form ${raw} only closes a dialog, which needs JavaScript`, 0);
    const actionAttribute = submitter?.formAction ?? form.action;
    const action = actionAttribute ? this.#resolve(page, actionAttribute) : page.url;
    if (!action) throw new PoppyError("invalid_request", `The form ${raw} has an action that isn't a URL`, 0);
    // Checked now, so an approval card never names somewhere the browser won't go.
    this.#check(action);
    const enctype = (submitter?.formEnctype ?? form.enctype) === "multipart/form-data" && method === "POST" ? "multipart/form-data" : "application/x-www-form-urlencoded";
    return { from: page.url.href, method, action: action.href, enctype, fields };
  }

  async submit(submission: FormSubmission, beforeDispatch?: () => void): Promise<PageSnapshot> {
    const action = new URL(submission.action);
    if (submission.method === "GET") {
      // A GET form replaces the action's query with its fields (HTML, "mutate action URL").
      action.search = new URLSearchParams(submission.fields.map((field) => [field.name, field.value])).toString();
      action.hash = "";
      return this.#load(await this.#navigate(action, { method: "GET", beforeDispatch }));
    }
    let body: URLSearchParams | FormData;
    if (submission.enctype === "multipart/form-data") {
      body = new FormData();
      for (const field of submission.fields) body.append(field.name, field.value);
    } else {
      body = new URLSearchParams(submission.fields.map((field) => [field.name, field.value]));
    }
    return this.#load(await this.#navigate(action, { method: "POST", body, origin: new URL(submission.from).origin, beforeDispatch }));
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#jar.clear();
    this.#page = undefined;
  }
}

/** The production browser: one fetch-based context, with its own cookie jar, per Session. */
export class FetchBrowser implements PoppyBrowser {
  readonly #fetcher: Fetcher;
  readonly #options: FetchBrowserOptions;

  constructor(fetcher: Fetcher, options: FetchBrowserOptions = {}) {
    this.#fetcher = fetcher;
    this.#options = options;
  }

  async newContext(guard: PageGuard): Promise<BrowserContextHandle> {
    return new FetchContext(this.#fetcher, guard, this.#options);
  }
}
