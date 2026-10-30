/** Outer locators are opaque: their path/query must never be scanned again. */
const URL_START = /(?<![\p{L}\p{N}_.@-])https?:\/\/|(?<![\p{L}\p{N}_.@-])(?:localhost|(?:[\p{L}\p{N}_-]+\.)+[\p{L}\p{N}_-]+\.?)(?::[0-9]+|[\\/?#])/iu;
const EMAIL_START = /[^\s@<>"'()]+@(?:[\p{L}\p{N}_-]+\.)+[\p{L}\p{N}_-]+/iu;

export function recipient(value: string): string {
  try {
    const clean = value.replace(/[\])},.;!?]+$/, "");
    return new URL(clean.startsWith("//") ? `https:${clean}` : clean.includes("://") ? clean : `https://${clean}`).host.toLowerCase().replace(/\.(?=:|$)/, "");
  } catch { return ""; }
}

export function recipientCue(text: string, at: number): boolean {
  return /\b(?:at|to|with|company|shop|store)\s+$/iu.test(text.slice(Math.max(0, at - 100), at));
}

export function taskText(text: string): { narrative: string; locators: readonly { host: string; qualified: boolean; start: number; named: boolean }[] } {
  const locators: { host: string; qualified: boolean; start: number; named: boolean }[] = [];
  const narrative = text.replace(/\S+/gu, (token, offset: number) => {
    // Unknown schemes and relative URL queries are data, not nested recipients.
    const scheme = /^[\[('"“‘<]*([a-z][a-z0-9+.-]*):/i.exec(token)?.[1]?.toLowerCase();
    const barePort = /^[\[('"“‘<]*(?:localhost|(?:[\p{L}\p{N}_-]+\.)+[\p{L}\p{N}_-]+\.?):[0-9]+/iu.test(token);
    if (scheme && scheme !== "http" && scheme !== "https" && !barePort) return " ".repeat(token.length);
    if (/^[\[('"“‘<]*[\\/]/.test(token) && !token.startsWith("//")) {
      return /[?#]|:\/\//.test(token) ? " ".repeat(token.length) : token; // Plain file paths remain usable filename references.
    }
    const url = URL_START.exec(token);
    const email = EMAIL_START.exec(token);
    if (email && (!url || email.index < url.index)) return " ".repeat(token.length);
    if (!url) return token;
    const prefix = token.slice(0, url.index);
    if (!/[?#]/.test(prefix)) {
      const value = token.slice(url.index);
      const host = recipient(value);
      locators.push({ host, qualified: /^https?:\/\//i.test(value), start: offset + url.index, named: recipientCue(text, offset + url.index) });
    }
    return prefix + " ".repeat(token.length - prefix.length);
  });
  return { narrative, locators };
}
