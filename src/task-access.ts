import { isPublicHost } from "./validator/fetch";

/** Authority selected in the authenticated composer, never inferred from prose or model arguments. */
export type TaskAccess = {
  readonly companies: readonly string[];
  readonly uploads: readonly { readonly company: string; readonly files: readonly string[] }[];
};

export const NO_TASK_ACCESS: TaskAccess = { companies: [], uploads: [] };
const ATTACHMENT = /^att_[A-Za-z0-9_-]{22}$/;

/** Explicit host/origin input only; paths, credentials and queries cannot hide another destination. */
export function companyDomain(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !isPublicHost(url)) {
    throw new Error("Choose a public HTTPS Company domain, without a path, query or credentials.");
  }
  return url.host.toLowerCase().replace(/\.(?=:|$)/, "");
}

export function companyDomains(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean).map(companyDomain))].sort();
}

export function readTaskAccess(value: unknown): TaskAccess {
  if (value === undefined) return NO_TASK_ACCESS;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task access.");
  const access = value as Record<string, unknown>;
  if (Object.keys(access).some(key => key !== "companies" && key !== "uploads") || !Array.isArray(access.companies) || access.companies.length > 8 || !Array.isArray(access.uploads) || access.uploads.length > 8) throw new Error("Invalid task access.");
  const companies = [...new Set(access.companies.map(value => {
    if (typeof value !== "string" || value.length > 300) throw new Error("Invalid Company domain.");
    return companyDomain(value);
  }))].sort();
  const uploads = access.uploads.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid photo selection.");
    const upload = value as Record<string, unknown>;
    if (Object.keys(upload).some(key => key !== "company" && key !== "files") || typeof upload.company !== "string" || !Array.isArray(upload.files) || upload.files.length > 20 || upload.files.some(id => typeof id !== "string" || !ATTACHMENT.test(id))) throw new Error("Invalid photo selection.");
    const company = companyDomain(upload.company);
    if (!companies.includes(company)) throw new Error("Photo uploads must name a selected Company.");
    return { company, files: [...new Set(upload.files as string[])].sort() };
  }).sort((a, b) => a.company.localeCompare(b.company));
  if (new Set(uploads.map(upload => upload.company)).size !== uploads.length) throw new Error("Duplicate photo destination.");
  return { companies, uploads };
}
