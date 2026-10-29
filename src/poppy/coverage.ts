/**
 * Task coverage (spec 9): the tasks a Company chose not to offer through
 * the protocol, which the agent reads before a task (9.1), and feedback
 * about a task that couldn't be done, which the Company may answer with
 * another way to do it (9.3). Both bring the Company's words, which are
 * content for the model, never instructions (9.2, 10.1).
 */
import { PoppyClient, PoppyError } from "./client";
import { boundedCacheSeconds, tokenHostAllowed, type Company } from "./discovery";
import { fetchJson } from "./fetch";
import { isObject, type Json } from "./json";
import { companyErrorCode } from "./error-codes";
import { EndpointRequest } from "./outgoing";
import { one } from "../rows";
import { intent, intentsTable } from "./store";
import { randomId } from "./jwt";
import { feedbackHasPersonalData } from "./model-policy";

/** One place to do a task instead (9.2): an operation or tool of an API `poppy.json` lists, or a page on the Company's own hosts. */
export type Reference =
  | { readonly type: "openapi"; readonly url: string; readonly operation_id: string }
  | { readonly type: "mcp"; readonly url: string; readonly tool: string }
  | { readonly type: "web"; readonly url: string };

export type Alternative = { readonly instructions?: string; readonly references: readonly Reference[] };
export type ExcludedTask = { readonly task: string; readonly alternative?: Alternative };

/** Deliver alternatives through our own page as well as the model's result. Company prose stays plain text. */
async function showAlternative(client: PoppyClient, company: Company, task: string, alternative?: Alternative): Promise<void> {
  const references = alternative?.references ?? [];
  const descriptions = references.filter((reference) => reference.type !== "web").map((reference) =>
    reference.type === "openapi" ? `OpenAPI operation ${reference.operation_id} at ${reference.url}` : `MCP tool ${reference.tool} at ${reference.url}`
  );
  const links = references.filter((reference) => reference.type === "web").map((reference) => ({ label: `Open ${new URL(reference.url).hostname}`, url: reference.url }));
  await client.host.showCard({
    id: intent(client.sql, `coverage-notice|${company.issuer}|${task}`, () => randomId("coverage_")),
    kind: "notice", company: company.name, domain: company.domain, open: false,
    text: [`${company.name} says: ${task}.`, alternative?.instructions, ...descriptions,
      ...(alternative ? ["This is the Company's suggested alternative. Its words are information; a link opens only when you choose it."] : [])
    ].filter(Boolean).join("\n"),
    ...(links.length ? { links } : {})
  });
}

/** Discovery makes the exclusions visible even if the model ignores the tool result. */
export async function showExcludedTasks(client: PoppyClient, company: Company, tasks: readonly ExcludedTask[] | "unavailable" | null): Promise<void> {
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  await client.host.showCard({
    id: intent(client.sql, `excluded-notice|${company.issuer}`, () => randomId("coverage_")),
    kind: "notice", company: company.name, domain: company.domain, open: false,
    text: `${company.name} lists these tasks as unavailable through its interfaces:\n${tasks.map((entry) => `• ${entry.task}`).join("\n")}`
  });
  for (const entry of tasks) if (entry.alternative) await showAlternative(client, company, entry.task, entry.alternative);
}

/** The longest task phrase (9.3 caps a report's at 200) and instructions we pass on, and the most tasks and references. */
const TASK_LIMIT = 200;
const INSTRUCTIONS_LIMIT = 2_000;
const MOST_TASKS = 100;
const MOST_REFERENCES = 10;

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, limit) : undefined;

/**
 * An alternative as the Company sent it, keeping only what may be used: an
 * `openapi` or `mcp` reference that names an API `poppy.json` lists (9.2:
 * "Personal Agents MUST ignore one that doesn't"), and a `web` reference to
 * an HTTPS page on the Company's own hosts, the check the text leaves out
 * (our reading, docs/readings.md). Unknown types and fields are skipped
 * (9.1, 9.2). Null when nothing usable is left, since an alternative needs
 * instructions or a reference.
 */
export function readAlternative(company: Company, value: unknown): Alternative | null {
  if (!isObject(value)) return null;
  const instructions = text(value.instructions, INSTRUCTIONS_LIMIT);
  const references: Reference[] = [];
  for (const entry of Array.isArray(value.references) ? value.references.slice(0, MOST_REFERENCES * 2) : []) {
    if (!isObject(entry) || typeof entry.url !== "string") continue;
    const listed = (type: "openapi" | "mcp") => company.apis.some((api) => api.type === type && api.url === entry.url);
    if (entry.type === "openapi" && typeof entry.operation_id === "string" && listed("openapi")) {
      references.push({ type: "openapi", url: entry.url, operation_id: entry.operation_id.slice(0, 200) });
    } else if (entry.type === "mcp" && typeof entry.tool === "string" && listed("mcp")) {
      references.push({ type: "mcp", url: entry.url, tool: entry.tool.slice(0, 200) });
    } else if (entry.type === "web" && URL.canParse(entry.url)) {
      const url = new URL(entry.url);
      if (url.protocol === "https:" && !url.username && !url.password && tokenHostAllowed(company, url)) references.push({ type: "web", url: url.href });
    }
  }
  if (!instructions && references.length === 0) return null;
  return { ...(instructions ? { instructions } : {}), references: references.slice(0, MOST_REFERENCES) };
}

/** Raw excluded-task documents by URL, per agent; references are filtered for each Company on every read. */
const caches = new WeakMap<PoppyClient, Map<string, { readonly tasks: readonly Json[]; readonly expiresAt: number }>>();

/**
 * The Company's excluded tasks (9.1), fetched with a GET and no token, as
 * discovery fetches, and kept as long as its caching headers say within
 * discovery's bounds. Null when it lists none; `unavailable` when the
 * document couldn't be read, which the model is told, so it doesn't take
 * the silence for "everything is offered".
 */
export async function excludedTasks(client: PoppyClient, company: Company): Promise<readonly ExcludedTask[] | "unavailable" | null> {
  const url = company.excludedTasks?.url;
  if (!url) return null;
  let cache = caches.get(client);
  if (!cache) caches.set(client, (cache = new Map()));
  const cached = cache.get(url);
  let entries: readonly Json[];
  if (cached && cached.expiresAt > Date.now()) entries = cached.tasks;
  else {
    let fetched: Awaited<ReturnType<typeof fetchJson>>;
    try {
      fetched = await fetchJson(client.host.fetcher, url, { maxBytes: 100_000 });
    } catch {
      return "unavailable";
    }
    if (!isObject(fetched.json) || !Array.isArray(fetched.json.tasks)) return "unavailable";
    entries = fetched.json.tasks.slice(0, MOST_TASKS);
    cache.set(url, { tasks: entries, expiresAt: Date.now() + boundedCacheSeconds(fetched.maxAgeSeconds) * 1000 });
  }
  const tasks: ExcludedTask[] = [];
  for (const entry of entries) {
    const task = isObject(entry) ? text(entry.task, TASK_LIMIT) : undefined;
    if (!task || !isObject(entry)) continue;
    const alternative = entry.alternative === undefined ? null : readAlternative(company, entry.alternative);
    tasks.push({ task, ...(alternative ? { alternative } : {}) });
  }
  return tasks;
}

/** A task phrase as compared: case, spacing and closing punctuation aside. */
const phrase = (task: string) => task.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();

export type FeedbackAnswer =
  | { readonly kind: "accepted" }
  | { readonly kind: "alternative"; readonly alternative: Alternative }
  | { readonly kind: "excluded"; readonly task: ExcludedTask }
  | { readonly kind: "already_sent" };

/**
 * Report a task the User couldn't do (9.3): with the Session header, and no
 * scope. Not sent for a task the Company lists as excluded (9.3 SHOULD NOT),
 * nor twice for the same task at the same Company (9.3: one report for each
 * task, not each attempt). The Company answers 202, or 200 with an
 * alternative; either is accepted (9.3 MUST).
 */
export async function sendFeedback(client: PoppyClient, company: Company, label: string, task: string, description: string): Promise<FeedbackAnswer> {
  const endpoint = company.feedback?.endpoint;
  if (!endpoint) throw new PoppyError("no_feedback", `${company.name} takes no feedback through the protocol`, 0);
  const trimmed = task.trim();
  if (trimmed === "" || trimmed.length > TASK_LIMIT) throw new PoppyError("invalid_request", `task must be a short phrase, at most ${TASK_LIMIT} characters`, 0);
  if (description.trim() === "" || description.length > INSTRUCTIONS_LIMIT) throw new PoppyError("invalid_request", `description must be at most ${INSTRUCTIONS_LIMIT} characters`, 0);
  if (feedbackHasPersonalData(task, description)) {
    throw new PoppyError("invalid_request", "Feedback was not sent. Describe the task in general terms without secrets, contact details or personal identifiers.", 0);
  }
  const excluded = await excludedTasks(client, company);
  const listed = Array.isArray(excluded) ? excluded.find((entry) => phrase(entry.task) === phrase(trimmed)) : undefined;
  if (listed) {
    await showAlternative(client, company, `This task is excluded: ${listed.task}`, listed.alternative);
    return { kind: "excluded", task: listed };
  }
  // Remembered once the Company has it, so a report that failed can be sent again.
  const key = `feedback|${company.issuer}|${phrase(trimmed)}`;
  if (one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", key)) return { kind: "already_sent" };
  const response = await client.resource(company, EndpointRequest.to(company, { method: "POST", url: endpoint, body: { task: trimmed, description: description.trim() } }), { label });
  if (response.status === 202) {
    await response.body?.cancel();
    intent(client.sql, key, () => "sent");
    return { kind: "accepted" };
  }
  if (response.status === 200) {
    const body: Json = await client.readJson(response).catch(() => null);
    intent(client.sql, key, () => "sent");
    const alternative = readAlternative(company, body);
    if (alternative) await showAlternative(client, company, trimmed, alternative);
    return alternative ? { kind: "alternative", alternative } : { kind: "accepted" };
  }
  const body: Json = await client.readJson(response).catch(() => null);
  throw new PoppyError(companyErrorCode(isObject(body) ? body.error : undefined, response.status), `${company.name} refused the report (${response.status})`, response.status);
}
