/**
 * The validator over HTTP, for anyone to use:
 *
 * - `GET /validator`: the form; with `?url=` it checks that and shows the results.
 * - `POST /validator`: the form's paste or URL submission, answered as HTML.
 * - `POST /validator/api`: JSON in (`{"url": …}` or `{"document": …, "kind": …}`), the JSON report out.
 * - `GET /validator/api?url=`: the same for a URL.
 * - `GET /validator/messages`: what every message means.
 *
 * The API allows any origin and sends no cookies. Callers can limit input
 * work separately from the quota for URL checks that fetch from the network.
 */
import type { Fetcher } from "./fetch.ts";
import { formPage, messagesPage, resultPage } from "./html.ts";
import type { DocumentKind } from "./primitives.ts";
import { validateTarget, validateText, type Report } from "./validate.ts";
import { checkJsonWork, HTTP_INPUT_LIMITS, InputError as BadInput, readInputBytes } from "./input.ts";

const MAX_INPUT_BYTES = 100_000;
const KINDS: readonly DocumentKind[] = ["poppy", "oauth-metadata", "client-metadata", "jwks"];

export type ValidatorHttpOptions = {
  readonly fetcher: Fetcher;
  /** General admission before consuming a body or doing validation; independent of fetch quota. */
  readonly allowRequest?: (request: Request) => Promise<boolean>;
  /** Whether this caller may fetch another URL now. */
  readonly allowFetch: (request: Request) => Promise<boolean>;
};

type Input = {
  url?: string;
  document?: string;
  kind?: string;
  domain?: string;
  fetchedFrom?: string;
  protocolVersion?: string;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
}

async function readInput(request: Request): Promise<Input> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const target = url.searchParams.get("url");
    return target ? { url: target } : {};
  }
  const bytes = await readInputBytes(request);
  const type = request.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) {
    let textBody: string;
    try {
      textBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new BadInput("The request body isn't UTF-8.");
    }
    // The envelope adds one level to a document supplied as an object.
    checkJsonWork(textBody, HTTP_INPUT_LIMITS.depth + 1);
    let body: unknown;
    try {
      body = JSON.parse(textBody);
    } catch {
      throw new BadInput('The request body isn\'t JSON. Send {"url": "example.com"} or {"document": "…", "kind": "poppy"}.');
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadInput("The request body must be a JSON object.");
    const b = body as Record<string, unknown>;
    const text = (key: string) => {
      const value = typeof b[key] === "string" ? b[key] : undefined;
      if (value !== undefined && value.length > 2048) throw new BadInput(`${key} is too long.`, 413);
      return value;
    };
    // A document may be sent as a JSON string (checked exactly as written) or as an object.
    const document = typeof b.document === "string" ? b.document : b.document !== undefined ? JSON.stringify(b.document) : undefined;
    return {
      ...(text("url") ? { url: text("url")! } : {}),
      ...(document !== undefined ? { document } : {}),
      ...(text("kind") ? { kind: text("kind")! } : {}),
      ...(text("domain") ? { domain: text("domain")! } : {}),
      ...(text("fetchedFrom") ? { fetchedFrom: text("fetchedFrom")! } : {}),
      ...(text("protocolVersion") ? { protocolVersion: text("protocolVersion")! } : {})
    };
  }
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "Content-Type": type } }).formData();
  } catch {
    throw new BadInput("Send JSON or a valid form.");
  }
  if ([...form.keys()].length > HTTP_INPUT_LIMITS.formFields) throw new BadInput("The form contains too many fields.", 413);
  const field = (key: string) => {
    const value = form.get(key);
    if (key !== "document" && typeof value === "string" && value.length > 2048) throw new BadInput(`${key} is too long.`, 413);
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  return {
    ...(field("url") ? { url: field("url")!.trim() } : {}),
    ...(field("document") ? { document: field("document")! } : {}),
    ...(field("kind") ? { kind: field("kind")! } : {}),
    ...(field("domain") ? { domain: field("domain")!.trim() } : {}),
    ...(field("fetched_from") ? { fetchedFrom: field("fetched_from")!.trim() } : {})
  };
}

async function run(input: Input, request: Request, options: ValidatorHttpOptions): Promise<Report> {
  if (input.document !== undefined) {
    if (new TextEncoder().encode(input.document).byteLength > MAX_INPUT_BYTES) {
      throw new BadInput("The document is larger than 100 KB, which agents won't read.", 413);
    }
    checkJsonWork(input.document);
    const kind = (input.kind ?? "poppy") as DocumentKind;
    if (!KINDS.includes(kind)) throw new BadInput(`kind must be one of ${KINDS.join(", ")}.`);
    const report = validateText(kind, input.document, {
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.fetchedFrom ? { fetchedFrom: input.fetchedFrom } : {}),
      ...(input.protocolVersion ? { protocolVersion: input.protocolVersion } : {})
    });
    if (report.messages.some(message => message.id === "json-resource-limit")) throw new BadInput("The document exceeds the validator's JSON location metadata allowance.", 413);
    return report;
  }
  if (input.url) {
    if (input.url.length > 2048) throw new BadInput("The URL is too long.");
    if (!(await options.allowFetch(request))) throw new BadInput("Too many checks from your address; wait a minute.", 429);
    return validateTarget(options.fetcher, input.url, {
      ...(input.protocolVersion ? { protocolVersion: input.protocolVersion } : {})
    });
  }
  throw new BadInput("Give a url to check, or a document.");
}

/** Handle `/validator` and below; null for other paths. */
export async function handleValidator(request: Request, options: ValidatorHttpOptions): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  const admit = async () => {
    if (options.allowRequest && !(await options.allowRequest(request))) {
      void request.body?.cancel().catch(() => undefined);
      throw new BadInput("Too many checks from your address; wait a minute.", 429);
    }
  };
  if (path === "/validator/messages") {
    return request.method === "GET" ? html(messagesPage()) : new Response("Method not allowed", { status: 405 });
  }
  if (path === "/validator/api") {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    try {
      await admit();
      return json(await run(await readInput(request), request, options));
    } catch (error) {
      if (error instanceof BadInput) return json({ error: error.message }, error.status);
      throw error;
    }
  }
  if (path === "/validator") {
    if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    // Serving the empty form does no validation work and consumes no quota.
    if (request.method === "GET" && !url.searchParams.get("url")) return html(formPage(url.origin));
    const input = await (async () => {
      await admit();
      return readInput(request);
    })().catch((error: unknown) => {
      if (error instanceof BadInput) return error;
      throw error;
    });
    if (input instanceof BadInput) return html(formPage(url.origin), input.status);
    if (request.method === "GET" && !input.url) return html(formPage(url.origin));
    try {
      return html(resultPage(await run(input, request, options), input));
    } catch (error) {
      if (error instanceof BadInput) {
        return html(formPage(url.origin).replace("</h1>", `</h1><p role="alert" class="outcome invalid"><strong>${error.message.replace(/[&<>"']/g, "")}</strong></p>`), error.status);
      }
      throw error;
    }
  }
  return null;
}
