/**
 * Long values in shown text, for the renderers that lay it out: the
 * validator's results page and its Markdown report. Text built with
 * src/diagnostic.ts holds each URL as `show.url` made it (no query, "?…"
 * where one was cut), so a renderer can find it, set it as a value, break it
 * between its segments instead of anywhere, and shorten a long segment for
 * the eye while keeping the whole in reach. Pure: no Worker, Node or DOM
 * APIs, so a page, a Markdown report or the app's UI can use it alike.
 */

/** A run of shown text: words, or a URL in them. */
export type Piece = { readonly kind: "text"; readonly text: string } | { readonly kind: "url"; readonly url: string };

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`]+/g;

/** Punctuation that ends the sentence around a URL rather than the URL; "?…", an elided query, stays. */
const TRAILING = /[.,;:)\]!*]+$/;

/** The text split into words and URLs, in order; joined back, the pieces are the text. */
export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(TRAILING, "");
    const start = match.index;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "url", url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** A URL in its parts: `https://`, the host, each path segment (without its slash), and what follows the path ("?…", or a query shown whole). */
export type UrlParts = { readonly scheme: string; readonly host: string; readonly segments: readonly string[]; readonly suffix: string };

export function urlParts(url: string): UrlParts | null {
  const match = /^(https?:\/\/)([^/?#]+)(\/[^?#]*)?(.*)$/.exec(url);
  if (!match) return null;
  const path = match[3] ?? "";
  return { scheme: match[1]!, host: match[2]!, segments: path === "" ? [] : path.slice(1).split("/"), suffix: match[4] ?? "" };
}

/** Segments longer than this are shortened for the eye: an id or a slug of 34 characters reads as noise in a sentence. */
export const SEGMENT_LIMIT = 24;

/** A segment shortened in its middle, keeping how it starts and ends: `example_idp_production_tenant_1` → `example_idp_prod…enant_1`. */
export function shortSegment(segment: string, limit = SEGMENT_LIMIT): string {
  if (segment.length <= limit) return segment;
  const tail = Math.floor((limit - 1) / 3);
  return `${segment.slice(0, limit - 1 - tail)}…${segment.slice(-tail)}`;
}

// Markdown, for reports people paste into an issue: nothing in shown text is trusted as Markdown.

/**
 * Text as Markdown that renders as itself: emphasis, code, link, table and
 * HTML punctuation escaped anywhere, and a heading, list or quote marker
 * escaped where it would start a line. Parentheses need none once square
 * brackets are escaped.
 */
export function markdownWords(text: string): string {
  return text
    .replace(/[\\`*_[\]<>|~]/g, (char) => `\\${char}`)
    .replace(/\n+/g, " ")
    .replace(/^(\s*)([#+\->=]|\d+[.)])/, (_, space: string, marker: string) => `${space}\\${marker}`);
}

/** A value as a code span, fenced with more backticks than it holds, so it can't close early. */
export function codeSpan(value: string): string {
  const run = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(run + 1);
  const pad = value.startsWith("`") || value.endsWith("`") || run > 0 ? " " : "";
  return `${fence}${pad}${value.replace(/\n+/g, " ")}${pad}${fence}`;
}

/**
 * What GitHub turns into a link or a notification in Markdown even without
 * an http(s) scheme: a `www.` name or an `ftp://` URL, an email address, and,
 * after a space or punctuation, an `@mention` (or `@org/team`) or a `#123`
 * reference. GitHub doesn't look inside code spans, so each becomes one. No
 * lookbehind, which not every browser the app supports has: the character
 * before a mention or a reference is matched as group 1 and kept as words.
 */
const AUTOLINK = /\b(?:www\.|ftp:\/\/)[^\s<>`"']+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(^|[^\w@./&])(@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][\w.-]*)?|#\d+\b)/g;

/** Words as Markdown, with each bare name GitHub would link set as a code span instead. */
function linklessWords(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(AUTOLINK)) {
    const before = match[1] ?? "";
    const start = match.index + before.length;
    const token = (match[2] ?? match[0]).replace(TRAILING, "");
    out += markdownWords(text.slice(last, start)) + codeSpan(token);
    last = start + token.length;
  }
  return out + markdownWords(text.slice(last));
}

/**
 * Shown text as Markdown that renders as itself and links nowhere: its words
 * escaped, and each URL, `www.` name, email address, mention or issue
 * reference in it a code span, since GitHub links those even bare.
 */
export function markdownText(value: string): string {
  return pieces(value)
    .map((piece) => (piece.kind === "url" ? codeSpan(piece.url) : linklessWords(piece.text)))
    .join("");
}
