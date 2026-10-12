/**
 * One readable line for each Poppy tool call in the transcript: what the
 * agent did, where, how and with what access, in the words the rest of the
 * page uses. Pure, so it is tested on its own (test/ui/tool-line.test.ts).
 */

export type ToolHow = "API" | "their agent" | "website" | "sign-in";
export type ToolAccess = "view" | "view and change";
export type ToolState = "running" | "done" | "failed" | "waiting";

export type ToolLine = {
  /** What the agent did, in the past tense. */
  readonly text: string;
  /** Words quoted verbatim after the text, such as a message to a Company's agent. */
  readonly quote?: string;
  readonly how: ToolHow | null;
  readonly access: ToolAccess | null;
  readonly state: ToolState;
};

/** What the page knows about a call's result. */
export type ToolOutcome = {
  readonly error: boolean;
  /** The tool's structured result, where it has one. */
  readonly details?: unknown;
  /** Its text, for results that are only text. */
  readonly text?: string;
};

type Args = Record<string, unknown>;

const QUOTE_LIMIT = 120;

function clip(text: string, limit = QUOTE_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Words from an identifier: `search_products` → "search products". */
function words(identifier: string): string {
  return identifier
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

/** The last fixed part of an API path: `GET /orders/{order_id}` → "orders". */
function noun(path: string): string {
  const parts = path
    .split(/[/?#]/)
    .filter((part) => part !== "" && !/^\{.*\}$/.test(part) && !/^:/.test(part));
  return parts.length ? words(parts.at(-1)!) : "the API";
}

function access(scopes: unknown): ToolAccess | null {
  if (!Array.isArray(scopes)) return null;
  if (scopes.includes("poppy:write")) return "view and change";
  if (scopes.includes("poppy:read")) return "view";
  return null;
}

function proposed(outcome: ToolOutcome | undefined): boolean {
  if (!outcome || outcome.error) return false;
  if (isRecord(outcome.details) && outcome.details.proposed !== undefined) return true;
  return typeof outcome.text === "string" && /"proposed"\s*:/.test(outcome.text);
}

function stateOf(outcome: ToolOutcome | undefined): ToolState {
  if (!outcome) return "running";
  if (outcome.error) return "failed";
  return proposed(outcome) ? "waiting" : "done";
}

/** The page on a Company's site, short: `https://acme.example/orders?x=1` → "/orders". */
function pageOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (URL.canParse(url)) return new URL(url).pathname;
  return url.startsWith("/") ? url.split(/[?#]/)[0] : undefined;
}

/**
 * The line for one tool call, or null for tools that aren't Poppy's, which
 * keep their compact card. `companies` maps a domain to the Company's name,
 * where the transcript has seen it.
 */
export function describeToolCall(
  name: string,
  args: unknown,
  outcome?: ToolOutcome,
  companies: ReadonlyMap<string, string> = new Map()
): ToolLine | null {
  if (!name.startsWith("poppy_")) return null;
  const a: Args = isRecord(args) ? args : {};
  const domain = str(a.domain);
  const company = domain ? (companies.get(domain.toLowerCase()) ?? domain) : "the Company";
  const state = stateOf(outcome);
  const line = (text: string, how: ToolHow | null, accessLevel: ToolAccess | null = null, quote?: string): ToolLine => ({
    text,
    ...(quote ? { quote } : {}),
    how,
    access: accessLevel,
    state
  });

  switch (name) {
    case "poppy_discover":
      return line(`Looked up what ${company} offers personal agents`, null);
    case "poppy_sign_in": {
      const granted = isRecord(outcome?.details) && typeof outcome.details.status === "string" && outcome.details.status.startsWith("signed in");
      return line(granted ? `Used the access you gave ${company} before` : `Asked you to sign in at ${company}`, "sign-in", access(a.scopes));
    }
    case "poppy_status":
      return line(domain ? `Checked your accounts and conversations at ${company}` : "Checked what's open at every company", null);
    case "poppy_message": {
      const text = str(a.text);
      if (!text) return line(`Sent details to ${company}'s agent`, "their agent");
      return line(a.conversation ? `Wrote to ${company}'s agent:` : `Asked ${company}'s agent:`, "their agent", null, clip(text));
    }
    case "poppy_read":
      return line("Read the latest replies from a Company's agent", "their agent");
    case "poppy_handoff":
      return line("Asked for a person at the Company to join the conversation", "their agent", null, str(a.summary) ? clip(str(a.summary)!) : undefined);
    case "poppy_invite_user":
      return line("Offered you a conversation with the Company yourself", "their agent");
    case "poppy_close":
      return line("Closed a conversation with a Company's agent", "their agent");
    case "poppy_api_describe":
      return line(`Looked at the API ${company} offers`, "API");
    case "poppy_api_call": {
      const operation = str(a.operation) ?? "";
      const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i.exec(operation);
      // An upload names the User's photos by attachment id; sending one always waits for their approval.
      const files = isRecord(a.files) ? Object.keys(a.files).length : 0;
      if (files) return line(`Asked you to approve sending ${files === 1 ? "your photo" : "your photos"} to ${company}`, "API", "view and change");
      if (match && match[1]!.toUpperCase() === "GET") return line(`Read ${noun(match[2]!)} at ${company}`, "API", "view");
      if (state === "waiting") return line(`Asked you to approve a change at ${company}`, "API", "view and change");
      if (match) return line(`Made a change at ${company}: ${noun(match[2]!)}`, "API", "view and change");
      return line(`Used “${words(operation || "an operation")}” at ${company}`, "API", null);
    }
    case "poppy_mcp_list":
      return line(`Listed the tools ${company} offers`, "API");
    case "poppy_mcp_call": {
      const tool = words(str(a.tool) ?? "a tool");
      if (state === "waiting") return line(`Asked you to approve “${tool}” at ${company}`, "API", "view and change");
      return line(`Used “${tool}” at ${company}`, "API", null);
    }
    case "poppy_browse": {
      const action = str(a.action);
      if (action === "open") {
        const page = pageOf(str(a.url));
        return line(page && page !== "/" ? `Opened ${page} on ${company}'s website` : `Opened ${company}'s website`, "website");
      }
      if (action === "click") return line(`Clicked on ${company}'s website`, "website");
      if (action === "fill") return line(`Filled in a field on ${company}'s website`, "website");
      if (action === "submit") return line(`Asked you to approve sending a form on ${company}'s website`, "website", "view and change");
      return line(`Used ${company}'s website`, "website");
    }
    case "poppy_operation":
      return line(`Checked on an operation at ${company}`, "API");
    default:
      return line(`Used ${words(name.slice("poppy_".length)) || "a Poppy tool"}`, null);
  }
}

/** Domain → Company name, from what `poppy_discover` returned. */
export function companyNames(results: Iterable<{ readonly name: string; readonly details?: unknown }>): Map<string, string> {
  const names = new Map<string, string>();
  for (const result of results) {
    if (result.name !== "poppy_discover" || !isRecord(result.details)) continue;
    const { company, domain } = result.details;
    if (typeof company === "string" && typeof domain === "string") names.set(domain.toLowerCase(), company);
  }
  return names;
}
