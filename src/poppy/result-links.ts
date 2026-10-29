import { isPublicHost } from "../validator/fetch";
import { isObject, type Json } from "./json";

/**
 * User-facing links from a successful API result, never from approval summaries.
 * APIs define their own fields, so retain URL/link fields without inventing a
 * checkout schema. The User opens them; the agent never fetches or pays here.
 */
export function resultLinks(value: Json): { label: string; url: string }[] {
  const found: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  const walk = (value: Json, path: string[], depth: number) => {
    if (depth > 8 || found.length >= 12) return;
    if (typeof value === "string") {
      if (!/(url|link)$/i.test(path.at(-1) ?? "") || /[\s\u0000-\u001f\u007f]/.test(value) || !URL.canParse(value)) return;
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || !isPublicHost(url) || seen.has(value)) return;
      seen.add(value);
      const words = path.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
      found.push({ label: `${words} · ${url.hostname}`, url: value });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index + 1)], depth + 1));
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        // Do not turn a credential field, including one nested in an object, into a link.
        if (/token|secret|password|credential|authorization|cookie/i.test(key)) continue;
        walk(item, [...path, key], depth + 1);
      }
    }
  };
  walk(value, [], 0);
  return found;
}
