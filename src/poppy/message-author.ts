/** Who wrote a conversation message, in any version's terms (0.3 8.4; 0.1 and 0.2 7.4). */

type Members = { readonly [key: string]: unknown };

const isMembers = (value: unknown): value is Members => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Who wrote a message: `author.type` (0.3 8.4) or `sender` (0.1, 0.2), read
 * from either so a Company that mixes them is still understood; null when
 * it names neither.
 */
export function writtenBy(message: Members): "agent" | "human" | null {
  const type = isMembers(message.author) ? message.author.type : message.sender;
  return type === "human" || type === "agent" ? type : null;
}

/** The author's display name a Company message gives (0.3 8.4): Company content, shown as text, never its picture. */
export function authorName(message: Members): string | null {
  const name = isMembers(message.author) ? message.author.name : undefined;
  return typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 80) : null;
}
