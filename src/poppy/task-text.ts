/** Compare URI authorities with the same WHATWG parser used for transport. */
export function recipient(value: string): string {
  try {
    let clean = value.replace(/[)},.;!?]+$/, "");
    if (!/^(?:https?:\/\/|\/\/)?\[[^\]]*:[^\]]*\]$/i.test(clean)) clean = clean.replace(/\]+$/, "");
    return new URL(clean.startsWith("//") ? `https:${clean}` : clean.includes("://") ? clean : `https://${clean}`).host.toLowerCase().replace(/\.(?=:|$)/, "");
  } catch { return ""; }
}

export function recipientCue(text: string, at: number): boolean {
  return /\b(?:at|to|with|company|shop|store)\s+[(\["'“‘«]*$/iu.test(text.slice(Math.max(0, at - 100), at));
}

type Locator = { host: string; qualified: boolean; start: number; named: boolean };
const DOTS = "[.\\u3002\\uff0e\\uff61]";
const BARE_PORT = new RegExp(`^(?:localhost|(?:[\\p{L}\\p{N}_-]+${DOTS})+[\\p{L}\\p{N}_-]+):[0-9]+`, "iu");

/** Consume each complete outer network token once; never rescan its data. */
export function taskText(text: string): { narrative: string; locators: readonly Locator[] } {
  const locators: Locator[] = [];
  const narrative = text.replace(/\S+/gu, (token, offset: number) => {
    let lead = 0;
    while (lead < token.length && /[\[('"“‘<]/u.test(token[lead]!)) {
      // A bracketed IPv6 authority is not a display wrapper.
      if (token[lead] === "[" && /^\[[^\]\s]*:[^\]\s]*\]/u.test(token.slice(lead))) break;
      lead++;
    }
    // A trailing question mark alone is sentence punctuation, not URL data.
    const raw = token.slice(lead).replace(/\?+[)"'”’\],.!;]*$/u, "");
    const opaque = () => " ".repeat(token.length);
    const emit = (at: number, qualified: boolean) => {
      const start = offset + lead + at;
      const host = recipient(raw.slice(at));
      // An opaque ID with a slash is not an inferred public Company hostname.
      if (qualified || host.includes(".") || host.startsWith("[")) locators.push({ host, qualified, start, named: recipientCue(text, start) });
      return opaque();
    };
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
    if (scheme && scheme !== "http" && scheme !== "https" && !BARE_PORT.test(raw)) return opaque();
    if (/^[\\/]/.test(raw) && !raw.startsWith("//")) {
      // An explicit plain file path remains a filename reference. A relative
      // URL's query/fragment or nested scheme is always opaque instead.
      return /[?#]|:\/\//.test(raw) ? opaque() : token;
    }
    const qualified = /(?<![\p{L}\p{N}_.@-])https?:\/\//iu.exec(raw);
    const boundary = raw.search(/[\\/?#]/u);
    const email = raw.indexOf("@");
    if (email >= 0 && (boundary < 0 || email < boundary) && (!qualified || email < qualified.index)) return opaque();
    // Parse the outer authority, including IPv6, numeric hosts and IDNA dot
    // variants, before considering a qualified URL farther inside its query.
    if (boundary >= 0 && (!qualified || boundary < qualified.index)) return emit(0, raw.startsWith("//"));
    if (qualified) return emit(qualified.index, true);
    if (BARE_PORT.test(raw) || /^\[[^\]\s]*:[^\]\s]*\]/u.test(raw) || /%[0-9a-f]{2}|[\u3002\uff0e\uff61]/iu.test(raw)) return emit(0, false);
    return token;
  });
  return { narrative, locators };
}
