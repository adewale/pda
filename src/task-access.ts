import { departure, ours, ProblemError, sentence, show, shown, type Problem, type Shown } from "./diagnostic";
import { isPublicHost } from "./validator/fetch";

/** A selection the composer can't use; its message is a sentence, for the page, and `problem` keeps the parts for a tool that reports it. */
export class TaskAccessError extends ProblemError {
  override name = "TaskAccessError";
  constructor(problem: Problem) {
    super(problem);
    this.message = sentence(problem);
  }
}

/** Authority selected in the authenticated composer, never inferred from prose or model arguments. */
export type TaskAccess = {
  readonly companies: readonly string[];
  readonly uploads: readonly { readonly company: string; readonly files: readonly string[] }[];
};

export const NO_TASK_ACCESS: TaskAccess = { companies: [], uploads: [] };
const ATTACHMENT = /^att_[A-Za-z0-9_-]{22}$/;

/** An error the composer shows the User: the diagnostic as a sentence. */
function refused(problem: Problem): TaskAccessError {
  return new TaskAccessError(problem);
}

const DOMAIN = ours("a public HTTPS Company domain, without a path, query or credentials");

/** What an address the User typed was instead of a domain; never its credentials, path or query. */
function notADomain(url: URL): Shown {
  if (url.username || url.password) return ours("an address with credentials");
  if (url.protocol !== "https:") return shown`an address starting ${show.name(url.protocol)}`;
  if (url.pathname !== "/" || url.search || url.hash) return shown`${show.name(url.host)} with a path or query`;
  return shown`${show.name(url.hostname)}, which isn't public`;
}

/** Explicit host/origin input only; paths, credentials and queries cannot hide another destination. */
export function companyDomain(value: string): string {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw refused(departure(ours("the Company domain"), DOMAIN, ours("text that isn't an address")));
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !isPublicHost(url)) {
    throw refused(departure(ours("the Company domain"), DOMAIN, notADomain(url)));
  }
  return url.host.toLowerCase().replace(/\.(?=:|$)/, "");
}

export function companyDomains(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean).map(companyDomain))].sort();
}

/** A list's length, or its kind when it isn't a list. */
function listOf(value: unknown): Shown {
  return Array.isArray(value) ? show.count(value.length, ours("item"), ours("items")) : show.kind(value);
}

export function readTaskAccess(value: unknown): TaskAccess {
  if (value === undefined) return NO_TASK_ACCESS;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refused(departure(ours("the task access"), ours("an object of companies and uploads"), show.kind(value)));
  const access = value as Record<string, unknown>;
  const other = Object.keys(access).filter(key => key !== "companies" && key !== "uploads");
  if (other.length > 0) throw refused(departure(ours("the task access"), ours("companies and uploads only"), shown`also ${show.list(other.map(key => show.value(key)))}`));
  if (!Array.isArray(access.companies) || access.companies.length > 8) throw refused(departure(ours("the selected Companies"), ours("a list of at most 8"), listOf(access.companies)));
  if (!Array.isArray(access.uploads) || access.uploads.length > 8) throw refused(departure(ours("the photo selections"), ours("a list of at most 8"), listOf(access.uploads)));
  const companies = [...new Set(access.companies.map(value => {
    if (typeof value !== "string" || value.length > 300) throw refused(departure(ours("a Company domain"), ours("text of at most 300 characters"), typeof value === "string" ? show.count(value.length, ours("character"), ours("characters")) : show.kind(value)));
    return companyDomain(value);
  }))].sort();
  const uploads = access.uploads.map(value => {
    const selection = ours("a company and at most 20 attachment ids");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw refused(departure(ours("a photo selection"), selection, show.kind(value)));
    const upload = value as Record<string, unknown>;
    const extra = Object.keys(upload).filter(key => key !== "company" && key !== "files");
    if (extra.length > 0) throw refused(departure(ours("a photo selection"), selection, shown`also ${show.list(extra.map(key => show.value(key)))}`));
    if (typeof upload.company !== "string") throw refused(departure(ours("a photo selection's company"), ours("a Company domain"), show.kind(upload.company)));
    if (!Array.isArray(upload.files) || upload.files.length > 20) throw refused(departure(ours("a photo selection's files"), ours("a list of at most 20"), listOf(upload.files)));
    const file = upload.files.find(id => typeof id !== "string" || !ATTACHMENT.test(id));
    if (file !== undefined) throw refused(departure(ours("a photo selection's files"), ours("attachment ids"), show.value(file)));
    const company = companyDomain(upload.company);
    if (!companies.includes(company)) throw refused(departure(ours("a photo selection's company"), ours("one of the selected Companies"), show.name(company)));
    return { company, files: [...new Set(upload.files as string[])].sort() };
  }).sort((a, b) => a.company.localeCompare(b.company));
  const twice = uploads.find((upload, index) => uploads.findIndex(other => other.company === upload.company) !== index);
  if (twice) throw refused(departure(ours("the photo selections"), ours("one for each Company"), shown`two for ${show.name(twice.company)}`));
  return { companies, uploads };
}
