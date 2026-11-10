/**
 * Task coverage (spec 9): the tasks a Company chose not to offer through
 * the protocol, which the agent reads before a task (9.1), and feedback
 * about a task that couldn't be done, which the Company may answer with
 * another way to do it (9.3). Both bring the Company's words, which are
 * content for the model, never instructions (9.2, 10.1). Under 0.3 they
 * come from `poppy.json`; under 0.4 from the tasks endpoint, per Session.
 */
import { PoppyClient, PoppyError } from "./client";
import { boundedCacheSeconds, type Company } from "./discovery";
import { cacheSeconds, fetchJson } from "./fetch";
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
      // 9.2: a web alternative can point to any HTTPS website or app. It is a link for the User, and never a
      // destination for the Session header or a token (5.2).
      const url = new URL(entry.url);
      if (url.protocol === "https:" && !url.username && !url.password) references.push({ type: "web", url: url.href });
    }
  }
  if (!instructions && references.length === 0) return null;
  return { ...(instructions ? { instructions } : {}), references: references.slice(0, MOST_REFERENCES) };
}

/** Raw excluded-task documents by URL, per agent; references are filtered for each Company on every read. */
const caches = new WeakMap<PoppyClient, Map<string, { readonly tasks: readonly Json[]; readonly expiresAt: number }>>();

/** What 0.4's tasks endpoint said to one Session (9): its excluded tasks, as sent, and its feedback endpoint. */
type TasksAnswer = { readonly excluded: readonly Json[] | null; readonly feedback: string | null };

/** Tasks responses by Company and Session, per agent; never used in another Session (9). */
const answers = new WeakMap<PoppyClient, Map<string, { readonly answer: TasksAnswer; readonly expiresAt: number }>>();

/**
 * `GET {tasks.endpoint}` for this Session (0.4 9): with the Session header
 * and no access token, even signed in. Kept for the Session as its caching
 * headers allow, within discovery's bounds. Unavailable when it couldn't be
 * read, so the agent carries on as if the Company listed nothing and took
 * no feedback, and the model is told why.
 */
async function tasksAnswer(client: PoppyClient, company: Company, label: string): Promise<TasksAnswer | "unavailable"> {
  const endpoint = company.tasks!.endpoint;
  const session = client.session(company.issuer, label);
  let cache = answers.get(client);
  if (!cache) answers.set(client, (cache = new Map()));
  const key = session ? `${company.issuer}|${session.session_id}` : null;
  const cached = key ? cache.get(key) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.answer;
  let body: Json;
  let seconds: number | null;
  try {
    const response = await client.resource(company, EndpointRequest.to(company, { method: "GET", url: endpoint }), { label, noToken: true });
    if (response.status !== 200) {
      await response.body?.cancel();
      return "unavailable";
    }
    seconds = cacheSeconds(response);
    body = await client.readJson(response);
  } catch {
    return "unavailable";
  }
  if (!isObject(body)) return "unavailable";
  const feedback = isObject(body.feedback) && typeof body.feedback.endpoint === "string" && URL.canParse(body.feedback.endpoint) && new URL(body.feedback.endpoint).protocol === "https:"
    ? body.feedback.endpoint : null;
  const answer: TasksAnswer = { excluded: Array.isArray(body.excluded_tasks) ? body.excluded_tasks.slice(0, MOST_TASKS) : null, feedback };
  // The Session the request went in, which a first request may have started.
  const sent = client.session(company.issuer, label);
  if (sent && seconds !== 0) cache.set(`${company.issuer}|${sent.session_id}`, { answer, expiresAt: Date.now() + boundedCacheSeconds(seconds) * 1000 });
  return answer;
}

/** Where this Session sends feedback (9.3): `poppy.json`'s endpoint under 0.3, the tasks response's under 0.4. */
export async function feedbackEndpoint(client: PoppyClient, company: Company, label: string): Promise<string | null> {
  if (!company.tasks) return company.feedback?.endpoint ?? null;
  const answer = await tasksAnswer(client, company, label);
  return answer === "unavailable" ? null : answer.feedback;
}

/**
 * The Company's excluded tasks (9.1). Under 0.3, a document fetched with a
 * GET and no token, as discovery fetches, and kept as long as its caching
 * headers say within discovery's bounds; under 0.4, the tasks response for
 * this Session. Null when it lists none; `unavailable` when it couldn't be
 * read, which the model is told, so it doesn't take the silence for
 * "everything is offered".
 */
export async function excludedTasks(client: PoppyClient, company: Company, label = "main"): Promise<readonly ExcludedTask[] | "unavailable" | null> {
  if (company.tasks) {
    const answer = await tasksAnswer(client, company, label);
    if (answer === "unavailable") return answer;
    return answer.excluded === null ? null : readTasks(company, answer.excluded);
  }
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
  return readTasks(company, entries);
}

/** Excluded-task entries as the Company sent them, keeping a task phrase and a usable alternative (9.1, 9.2). */
function readTasks(company: Company, entries: readonly Json[]): ExcludedTask[] {
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

/** Concurrent attempts queue by this User's Company/task; only acknowledged reports become durable. */
const feedbackInFlight = new WeakMap<PoppyClient, Map<string, Promise<FeedbackAnswer>>>();

/**
 * Report a task the User couldn't do (9.3): with the Session header, and no
 * scope. Not sent for a task the Company lists as excluded (9.3 SHOULD NOT),
 * nor twice for the same task at the same Company (9.3: one report for each
 * task, not each attempt). The Company answers 202, or 200 with an
 * alternative; either is accepted (9.3 MUST).
 */
export async function sendFeedback(client: PoppyClient, company: Company, label: string, task: string, description: string): Promise<FeedbackAnswer> {
  const endpoint = await feedbackEndpoint(client, company, label);
  if (!endpoint) throw new PoppyError("no_feedback", `${company.name} takes no feedback through the protocol`, 0);
  const trimmed = task.trim();
  if (trimmed === "" || trimmed.length > TASK_LIMIT) throw new PoppyError("invalid_request", `task must be a short phrase, at most ${TASK_LIMIT} characters`, 0);
  if (description.trim() === "" || description.length > INSTRUCTIONS_LIMIT) throw new PoppyError("invalid_request", `description must be at most ${INSTRUCTIONS_LIMIT} characters`, 0);
  if (feedbackHasPersonalData(task, description)) {
    throw new PoppyError("invalid_request", "Feedback was not sent. Describe the task in general terms without secrets, contact details or personal identifiers.", 0);
  }
  const excluded = await excludedTasks(client, company, label);
  const listed = Array.isArray(excluded) ? excluded.find((entry) => phrase(entry.task) === phrase(trimmed)) : undefined;
  if (listed) {
    await showAlternative(client, company, `This task is excluded: ${listed.task}`, listed.alternative);
    return { kind: "excluded", task: listed };
  }
  // Remembered once the Company has it, so a report that failed can be sent again.
  const key = `feedback|${company.issuer}|${phrase(trimmed)}`;
  const pending = feedbackInFlight.get(client) ?? new Map<string, Promise<FeedbackAnswer>>();
  feedbackInFlight.set(client, pending);
  const send = async (): Promise<FeedbackAnswer> => {
    if (one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", key)) return { kind: "already_sent" };
    const init = { method: "POST", url: endpoint, body: { task: trimmed, description: description.trim() } };
    // 0.4's endpoint comes from the tasks response, so it is named for this Session only (5.2, 9.3).
    const request = company.tasks ? EndpointRequest.listed(endpoint, init) : EndpointRequest.to(company, init);
    const response = await client.resource(company, request, { label });
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
  };
  const queued = (pending.get(key) ?? Promise.resolve()).then(send, send);
  pending.set(key, queued);
  try { return await queued; }
  finally { if (pending.get(key) === queued) pending.delete(key); }

}
