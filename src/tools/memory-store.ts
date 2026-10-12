/**
 * The agent's memory: short notes in the person's own Durable Object SQLite,
 * kept until they forget them in Settings or ask the agent to. Each note is
 * one fact, at most 500 characters, with when it was saved and whose it is:
 * something the User said, or something the agent concluded. Nothing that
 * looks like a credential is kept. No Worker APIs beyond `SqlStorage`'s
 * shape, so the checks run anywhere.
 */

/** Longest note, in characters. */
export const MAX_MEMORY_CHARS = 500;
/** Most notes an agent keeps. When full, a new one is refused rather than an old one dropped. */
export const MAX_MEMORIES = 200;
/** What the prompt section shows: the newest notes, up to this many, within this many characters. */
export const PROMPT_MEMORIES = 50;
export const PROMPT_MEMORY_CHARS = 2000;

export type MemorySource = "user" | "agent";

export type Memory = {
  readonly id: number;
  readonly text: string;
  readonly source: MemorySource;
  readonly createdAt: number;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'agent')),
    created_at INTEGER NOT NULL
  )`
];

export function migrateMemories(sql: SqlStorage): void {
  for (const statement of SCHEMA) sql.exec(statement);
}

/** A refusal, worded for the model or the page. */
export class MemoryError extends Error {
  override name = "MemoryError";
}

// ---------------------------------------------------------------- What isn't kept

/** Luhn's check, as payment card numbers pass it. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const KEY_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, "an API key"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/, "an API key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bxox[abpors]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "a Google API key"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, "a token (a JWT)"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}=*/i, "an Authorization header's credentials"],
  [/\b(?:acct|ses|tok|at|rt)_[A-Za-z0-9_-]{20,}/, "a token"]
];

/** A secret named, then given: "my password is hunter2", "PIN: 4821", "api key = …". */
const NAMED_SECRET =
  /\b(?:pass(?:word|phrase|code)|passwd|pwd|pin|otp|one[- ]?time (?:pass)?code|verification code|security code|2fa code|mfa code|auth(?:entication)? code|cvv|cvc|csc|secret(?: key)?|api[- ]?key|access key|private key|(?:access|refresh|session|bearer|auth) token|token|recovery code|backup code|seed phrase|recovery phrase)\b\s*(?:is|was|=|:|-)\s*\S/i;

/** A code: "code 482913", "the code was 4829", but not a postcode or area code. */
const CODE = /(?<!\b(?:zip|post|postal|area|country|dial(?:l)?ing|sort|promo|discount|voucher|coupon|bar|qr|source|dress|colou?r|error|status|tax|product|style)\s?)\bcode\b\D{0,12}\d{4,8}\b/i;

/**
 * Why `text` isn't kept, or null. Errs on refusing: the agent says why, and
 * the User can say the fact without the secret.
 */
export function secretProblem(text: string): string | null {
  for (const [pattern, what] of KEY_PATTERNS) if (pattern.test(text)) return `It looks like ${what}`;
  if (NAMED_SECRET.test(text)) return "It looks like a password, code, key or token";
  if (CODE.test(text)) return "It looks like a one-time or security code";
  for (const match of text.matchAll(/(?<![\d+])\d(?:[ -]?\d){12,18}(?!\d)/g)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "It looks like a payment card number";
  }
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]{32,}={0,2}/g)) {
    const run = match[0];
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) return "It looks like a key, token or encoded secret";
  }
  if (/\b[0-9a-f]{32,}\b/i.test(text)) return "It looks like a key or hash";
  return null;
}

// ---------------------------------------------------------------- The store

type Row = { id: number; text: string; source: string; created_at: number };

function toMemory(row: Row): Memory {
  return { id: Number(row.id), text: String(row.text), source: row.source === "user" ? "user" : "agent", createdAt: Number(row.created_at) };
}

/** Collapse whitespace, so a note is one line, and the same fact said twice is one note. */
export function normalizeNote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class MemoryStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    migrateMemories(sql);
    this.#sql = sql;
    this.#now = now;
  }

  count(): number {
    return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM memories").toArray()[0]?.n ?? 0);
  }

  /** Every note, newest first. */
  all(): Memory[] {
    return (this.#sql.exec("SELECT id, text, source, created_at FROM memories ORDER BY id DESC").toArray() as Row[]).map(toMemory);
  }

  get(id: number): Memory | undefined {
    const row = this.#sql.exec("SELECT id, text, source, created_at FROM memories WHERE id = ?", id).toArray()[0] as Row | undefined;
    return row ? toMemory(row) : undefined;
  }

  /**
   * Keep a note. The same text again returns the note already kept, so a
   * repeated call (a replay) saves nothing new. Refuses, saying why, a note
   * that is empty, too long or secret-looking, and any note once full.
   */
  add(raw: string, source: MemorySource): { memory: Memory; created: boolean } {
    const text = normalizeNote(typeof raw === "string" ? raw : "");
    if (!text) throw new MemoryError("A note needs some text");
    if (text.length > MAX_MEMORY_CHARS) throw new MemoryError(`A note is at most ${MAX_MEMORY_CHARS} characters; this one is ${text.length}. Keep one short fact per note`);
    const problem = secretProblem(text);
    if (problem) {
      throw new MemoryError(`Not saved: ${problem}. Your agent never keeps passwords, codes, keys, tokens or card numbers. Say the fact without the secret`);
    }
    const existing = this.#sql.exec("SELECT id, text, source, created_at FROM memories WHERE text = ?", text).toArray()[0] as Row | undefined;
    if (existing) return { memory: toMemory(existing), created: false };
    if (this.count() >= MAX_MEMORIES) {
      throw new MemoryError(`Memory is full (${MAX_MEMORIES} notes). Nothing was dropped to make room: forget a note first, or ask the User which to remove`);
    }
    const row = this.#sql
      .exec("INSERT INTO memories (text, source, created_at) VALUES (?, ?, ?) RETURNING id, text, source, created_at", text, source, this.#now())
      .toArray()[0] as Row;
    return { memory: toMemory(row), created: true };
  }

  /** Forget one note; false if there was none. */
  forget(id: number): boolean {
    if (!Number.isSafeInteger(id)) return false;
    const found = this.get(id);
    if (!found) return false;
    this.#sql.exec("DELETE FROM memories WHERE id = ?", id);
    return true;
  }

  /** Forget every note; how many there were. */
  forgetAll(): number {
    const count = this.count();
    this.#sql.exec("DELETE FROM memories");
    return count;
  }

  /**
   * Notes matching `query`: each word of it (case ignored) found in the note,
   * best matches first, then newest. No query: every note, newest first.
   */
  search(query: string | undefined, limit = MAX_MEMORIES): Memory[] {
    const all = this.all();
    const words = normalizeNote(query ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1);
    if (words.length === 0) return all.slice(0, limit);
    return all
      .map((memory) => {
        const text = memory.text.toLowerCase();
        return { memory, score: words.filter((word) => text.includes(word)).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.id - a.memory.id)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** One note as the model reads it. */
export function noteLine(memory: Memory): string {
  return `- [${memory.id}] ${memory.source === "user" ? "User said" : "Agent noted"}, ${day(memory.createdAt)}: ${memory.text}`;
}

/** The newest notes for the prompt, bounded, with how many more `recall` can find. */
export function promptNotes(memories: readonly Memory[]): string {
  if (memories.length === 0) return "No notes saved yet.";
  const lines: string[] = [];
  let size = 0;
  for (const memory of memories.slice(0, PROMPT_MEMORIES)) {
    const line = noteLine(memory);
    if (size + line.length > PROMPT_MEMORY_CHARS && lines.length > 0) break;
    lines.push(line);
    size += line.length + 1;
  }
  const more = memories.length - lines.length;
  return `Saved notes, newest first:\n${lines.join("\n")}${more > 0 ? `\n(${more} older note${more === 1 ? "" : "s"} not shown: use recall to search them.)` : ""}`;
}
