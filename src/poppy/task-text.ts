/** Compare URI authorities with the same WHATWG parser used for transport. */
export function recipient(value: string): string {
  try {
    let clean = value.replace(/[)},.;!?]+$/, "");
    if (!/^(?:https?:\/\/|\/\/)?\[[^\]]*:[^\]]*\]$/i.test(clean)) clean = clean.replace(/\]+$/, "");
    return new URL(clean.startsWith("//") ? `https:${clean}` : clean.includes("://") ? clean : `https://${clean}`).host.toLowerCase().replace(/\.(?=:|$)/, "");
  } catch { return ""; }
}
