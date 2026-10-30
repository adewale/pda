/**
 * One readable line for each Poppy tool call and each general tool call
 * (read_url, memory, time and maths) in the transcript: what the agent did,
 * where, how and with what access, in the words the rest of the page uses.
 * Pure, so it is tested on its own (test/ui/tool-line.test.ts).
 */
import { isApprovalId, isDiagnosticFlowId, type ApprovalResult } from "../poppy/approval-outcome";
import { messageDelivery } from "../poppy/message-result";

export type ToolHow = "API" | "their agent" | "website" | "sign-in" | "web page" | "memory" | "clock" | "calculator" | "schedule";
export type ToolAccess = "view" | "view and change";
export type ToolState = "running" | "done" | "failed" | "waiting" | "unknown";

export type ToolLine = {
  /** What the agent did, in the past tense. */
  readonly text: string;
  /** Words quoted verbatim after the text, such as a message to a Company's agent. */
  readonly quote?: string;
  readonly how: ToolHow | null;
  readonly access: ToolAccess | null;
  readonly state: ToolState;
  /** An affirmative action outcome, when the tool supplies one without a card. */
  readonly result?: ApprovalResult;
};

/** What the page knows about a call's result. */
export type ToolOutcome = {
  readonly error: boolean;
  /** A stopped call has no recorded result; never manufacture success. */
  readonly missing?: true;
  /** The tool's structured result, where it has one. */
  readonly details?: unknown;
  /** Its text, for results that are only text. */
  readonly text?: string;
};

/**
 * How the request a call put on a card ended, once the User decided: from
 * the card while the agent keeps it, then from Activity's log. A call that
 * asked for approval reads "Waiting for you" until this says otherwise.
 */
export type ToolDecision = {
  readonly result: ApprovalResult;
  /** The User's photos it sends, by name, when the card still says. */
  readonly photos?: readonly string[];
};

/** The approval a call asked for, by its card's id. */
export function proposedBy(outcome: ToolOutcome | undefined): { approvalId: string } | null {
  if (!outcome || outcome.error || !isRecord(outcome.details)) return null;
  const proposed = outcome.details.proposed;
  // Our own card ids: `apr_` for a request we hold, `apr2_` for an operation a Company returned (operations-v2.ts).
  if (isApprovalId(proposed)) return { approvalId: proposed };
  return null;
}

/** A safe lifecycle reference written by our task dispatcher, including failures. */
export function taskBy(outcome: ToolOutcome | undefined, name: string): { approvalId: string; result: ApprovalResult } | null {
  if (name !== "poppy_api_call") return null; // Raw MCP successes are Company data, not application metadata.
  const task = isRecord(outcome?.details) ? outcome.details.poppyTask : undefined;
  if (!isRecord(task) || typeof task.id !== "string" || !isDiagnosticFlowId(task.id)) return null;
  switch (task.result) {
    case "waiting": case "in_progress": case "done": case "declined": case "failed": case "unknown":
      return { approvalId: task.id, result: task.result };
    default: return null;
  }
}

export function requestBy(outcome: ToolOutcome | undefined, name: string): { approvalId: string } | null { return proposedBy(outcome) ?? taskBy(outcome, name); }

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

function proposed(outcome: ToolOutcome | undefined): boolean {
  if (!outcome || outcome.error) return false;
  if (isRecord(outcome.details) && outcome.details.proposed !== undefined) return true;
  return typeof outcome.text === "string" && /"proposed"\s*:/.test(outcome.text);
}

function stateOf(outcome: ToolOutcome | undefined, name: string): ToolState {
  if (!outcome) return "running";
  if (outcome.missing || taskBy(outcome, name)?.result === "unknown") return "unknown";
  if (outcome.error) return "failed";
  return proposed(outcome) ? "waiting" : "done";
}

/** The page on a Company's site, short: `https://acme.example/orders?x=1` → "/orders". */
function pageOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (URL.canParse(url)) return new URL(url).pathname;
  return url.startsWith("/") ? url.split(/[?#]/)[0] : undefined;
}

/** A short address for a page: host and path, without the scheme or query. */
function shortUrl(url: string | undefined): string {
  if (!url) return "a web page";
  if (!URL.canParse(url)) return clip(url, 60);
  const parsed = new URL(url);
  return clip(`${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`, 60);
}

function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The lines for the general tools (src/tools/): read_url, memory, time and maths. Null for any other name. */
function generalLine(name: string, a: Args, outcome: ToolOutcome | undefined): ToolLine | null {
  const state = stateOf(outcome, name);
  const details = isRecord(outcome?.details) ? outcome.details : {};
  const line = (text: string, how: ToolHow, quote?: string): ToolLine => ({ text, ...(quote ? { quote } : {}), how, access: null, state });
  switch (name) {
    case "read_url": {
      const page = shortUrl(str(a.url));
      if (state === "failed") return line(`Couldn't read ${page}`, "web page");
      if (state === "running") return line(`Reading ${page}`, "web page");
      // Where it was read from, its status and its size: never what it says.
      const status = typeof details.status === "number" ? details.status : null;
      const bytes = typeof details.bytes === "number" ? details.bytes : null;
      const facts = [
        status !== null ? `HTTP ${status}` : null,
        bytes !== null ? size(bytes) : null,
        details.via === "browser" ? "rendered in Browser Run" : null,
        details.truncated === true ? "cut short" : null
      ].filter(Boolean);
      return line(`Read ${page}${facts.length ? ` (${facts.join(", ")})` : ""}`, "web page");
    }
    case "remember": {
      const text = str(a.text);
      if (state === "failed") return line("Didn't save a note", "memory", text ? clip(text) : undefined);
      return line(details.saved === "already saved" ? "Already had this note" : "Saved a note", "memory", text ? clip(text) : undefined);
    }
    case "recall": {
      const query = str(a.query);
      return line(query ? "Looked through its notes for" : "Looked through its notes", "memory", query ? clip(query) : undefined);
    }
    case "forget":
      return line(typeof a.id === "number" ? `Forgot note ${a.id}` : "Forgot a note", "memory");
    case "now":
      return line(str(a.time_zone) ? `Checked the time in ${clip(str(a.time_zone)!, 40)}` : "Checked the date and time", "clock");
    case "date_math": {
      const result = isRecord(details.result) ? details.result : isRecord(details.until) ? details.until : null;
      const date = result && typeof result.date === "string" ? result.date : null;
      const weekday = result && typeof result.weekday === "string" ? result.weekday : null;
      return line(date && state === "done" ? `Worked out a date: ${weekday ? `${weekday} ` : ""}${date}` : "Worked out a date", "clock");
    }
    case "calculate": {
      const expression = str(a.expression);
      const result = typeof details.result === "string" ? details.result : null;
      if (expression && result && state === "done") return line(`Calculated ${clip(expression, 60)} = ${clip(result, 40)}`, "calculator");
      return line("Did a calculation", "calculator", expression ? clip(expression) : undefined);
    }
    case "remind_me":
    case "schedule_task": {
      const reminder = name === "remind_me";
      const text = str(reminder ? a.text : a.instruction);
      const quote = text ? clip(text) : undefined;
      if (state === "failed") return line(reminder ? "Didn't set a reminder" : "Didn't schedule a task", "schedule", quote);
      if (state === "running") return line(reminder ? "Setting a reminder" : "Scheduling a task", "schedule", quote);
      const repeats = str(details.repeats);
      const next = str(details.next_run);
      const when = repeats && repeats !== "once" ? ` ${repeats}` : next ? ` for ${next.slice(0, 16).replace("T", " ")}` : "";
      return line(`${reminder ? "Set a reminder" : "Scheduled a task"}${when}`, "schedule", quote);
    }
    case "list_scheduled":
      return line("Listed reminders and scheduled tasks", "schedule");
    case "cancel_scheduled":
      return line(state === "failed" ? "Didn't cancel a reminder or task" : "Cancelled a reminder or task", "schedule", str(details.text) ? clip(str(details.text)!) : undefined);
    default:
      return null;
  }
}

/**
 * The line for one tool call, or null for tools that are neither Poppy's
 * nor the general tools, which keep their compact card. `companies` maps a domain to the Company's name,
 * where the transcript has seen it.
 */
export function describeToolCall(
  name: string,
  args: unknown,
  outcome?: ToolOutcome,
  companies: ReadonlyMap<string, string> = new Map(),
  decision?: ToolDecision
): ToolLine | null {
  if (!name.startsWith("poppy_")) return generalLine(name, isRecord(args) ? args : {}, outcome);
  const a: Args = isRecord(args) ? args : {};
  const domain = str(a.domain);
  const company = domain ? (companies.get(domain.toLowerCase()) ?? domain) : "the Company";
  const state = stateOf(outcome, name);
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
      // 0.3 defines no scopes: each Company's are its own (spec 4.7), so a sign-in names no access level.
      return line(granted ? `Used the access you gave ${company} before` : `Asked you to sign in at ${company}`, "sign-in");
    }
    case "poppy_status":
      return line(domain ? `Checked your accounts and conversations at ${company}` : "Checked what's open at every Company", null);
    case "poppy_message": {
      const delivery = messageDelivery(outcome?.details);
      if (delivery === "authorization_requested") return line(`Kept verification details private and asked ${company}'s agent for sign-in`, "their agent");
      if (delivery === "withheld") return line(`Kept verification details private; sign-in was already requested from ${company}'s agent`, "their agent");
      if (outcome?.error) return line(`Couldn't confirm sending a message to ${company}'s agent`, "their agent");
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
      // An upload may run for the task, wait for disclosure consent, or wait for Company terms.
      const files = isRecord(a.files) ? Object.keys(a.files).length : 0;
      if (files) {
        const photos = decision?.photos?.length ? clip(decision.photos.map((photo) => `“${photo}”`).join(", "), 80) : files === 1 ? "your photo" : "your photos";
        const upload = (text: string, state: ToolState = "done"): ToolLine => ({ text, how: "API", access: "view and change", state, result: decision?.result ?? (state === "done" ? "done" : state === "running" ? "in_progress" : state) });
        switch (decision?.result) {
          case "in_progress":
            return upload(`Sending ${photos} to ${company}`, "running");
          case "done":
            return upload(`Sent ${photos} to ${company}`);
          case "declined":
            return upload(`You declined sending ${photos} to ${company}`);
          case "failed":
            return upload(`Couldn't send ${photos} to ${company}`, "failed");
          case "unknown":
            return upload(`Couldn't confirm sending ${photos} to ${company}`, "unknown");
          default:
            if (state === "waiting") return line(`Asked you to approve sending ${photos} to ${company}`, "API", "view and change");
            if (state === "failed") return upload(`Couldn't confirm sending ${photos} to ${company}`, "failed");
            if (state === "running" || (isRecord(outcome?.details) && outcome.details.status === "in_progress")) return upload(`Sending ${photos} to ${company}`, "running");
            const status = isRecord(outcome?.details) ? outcome.details.status : undefined;
            if (state !== "unknown" && (taskBy(outcome, name)?.result === "done" || (typeof status === "number" && status >= 200 && status < 300 && status !== 202))) return upload(`Sent ${photos} to ${company}`);
            return upload(`Couldn't confirm sending ${photos} to ${company}`, "unknown");
        }
      }
      if (match && match[1]!.toUpperCase() === "GET") return line(`Read ${noun(match[2]!)} at ${company}`, "API", "view");
      if (state === "waiting") {
        const where = match ? `: ${noun(match[2]!)}` : "";
        switch (decision?.result) {
          case "in_progress":
            return { ...line(`Making the change you approved at ${company}${where}`, "API", "view and change"), state: "running" };
          case "done":
            return { ...line(`Made the change you approved at ${company}${where}`, "API", "view and change"), state: "done" };
          case "declined":
            return { ...line(`You declined a change at ${company}${where}`, "API", "view and change"), state: "done" };
          case "failed":
            return { ...line(`The change you approved at ${company}${where} didn't go through`, "API", "view and change"), state: "failed" };
          case "unknown":
            return { ...line(`The outcome of the change you approved at ${company}${where} is unknown`, "API", "view and change"), state: "failed" };
          default:
            return line(`Asked you to approve a change at ${company}`, "API", "view and change");
        }
      }
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
