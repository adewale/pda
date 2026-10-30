import { isPublicHost } from "../validator/fetch";
import { isObject, type Json } from "./json";

export type ResultLinkRejection = "invalid_url" | "whitespace" | "not_https" | "url_credentials" | "private_host" | "credential_field" | "duplicate" | "depth_limit" | "link_limit";
export type ResultLinkReport = {
  readonly links: { label: string; url: string }[];
  /** Closed reason names and counts only: no Company field names or values. */
  readonly rejected: Partial<Record<ResultLinkRejection, number>>;
};

/** User-clicked result links, never approval-summary links or automatic requests. */
export function inspectResultLinks(value: Json): ResultLinkReport {
  const links: ResultLinkReport["links"] = [];
  const rejected: ResultLinkReport["rejected"] = {};
  const seen = new Set<string>();
  const reject = (reason: ResultLinkRejection) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  const walk = (value: Json, path: string[], depth: number) => {
    if (depth > 8) { reject("depth_limit"); return; }
    if (links.length >= 12) { reject("link_limit"); return; }
    if (typeof value === "string") {
      if (!/(url|link)$/i.test(path.at(-1) ?? "")) return;
      if (/[\s\u0000-\u001f\u007f]/.test(value)) { reject("whitespace"); return; }
      if (!URL.canParse(value)) { reject("invalid_url"); return; }
      const url = new URL(value);
      if (url.protocol !== "https:") { reject("not_https"); return; }
      if (url.username || url.password) { reject("url_credentials"); return; }
      if (!isPublicHost(url)) { reject("private_host"); return; }
      if (url.hostname.length > 253) { reject("invalid_url"); return; }
      if (seen.has(value)) { reject("duplicate"); return; }
      seen.add(value);
      // Bound each untrusted path part before joining it. Strip bidi formatting
      // before adding the independently derived destination; never change hrefs.
      const words = path.map(part => part.slice(0, 80)).join(" ")
        .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 128);
      links.push({ label: `${words} · ${url.hostname}`.slice(0, 256), url: value });
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (links.length >= 12) { reject("link_limit"); break; }
        walk(value[index]!, [...path, String(index + 1)], depth + 1);
      }
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (links.length >= 12) { reject("link_limit"); break; }
        if (/token|secret|password|credential|authorization|cookie/i.test(key)) { reject("credential_field"); continue; }
        walk(item, [...path, key], depth + 1);
      }
    }
  };
  walk(value, [], 0);
  return { links, rejected };
}

export function resultLinks(value: Json): ResultLinkReport["links"] {
  return inspectResultLinks(value).links;
}
