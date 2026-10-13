import { literal } from "../decode";
import { integer, one, rows, table, text, textOf, type RowOf } from "../rows";
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

/** A word that names a credential: "password", "PIN", "pw", "OTP", "2FA code", "api key", "token". */
const CREDENTIAL = String.raw`\b(?:pass(?:word|phrase|code)s?|passwd|pwd|pw|pins?(?:\s+(?:code|number)s?)?|otps?|one[- ]?time\s+(?:pass)?codes?|(?:verification|security|2fa|mfa|auth(?:entication)?|login|access|recovery|backup)\s+codes?|2fa|mfa|cvv2?|cvc2?|csc|secret(?:\s+key)?s?|api[- ]?keys?|(?:access|private|wi-?fi|network|wpa2?)\s+keys?|(?:access|refresh|session|bearer|auth|api)\s+tokens?|tokens?|(?:seed|recovery)\s+phrases?|credentials?)\b`;

/** Credentials whose value is a few digits: a card's security code. */
const CARD_CODE = /^(?:cvv2?|cvc2?|csc|security\s+codes?)$/i;
/** Credentials whose value is never just a number, so digits near them are something else. */
const NOT_NUMERIC = /key|token|secret|credential|phrase/i;

/**
 * A credential named, then given: "my password is hunter2", "PIN: 4821",
 * "the password for the wifi: hunter2", "my password's hunter2".
 */
const NAMED = new RegExp(
  `${CREDENTIAL}(?:\\s+(?:for|to|on|of|at|from|with|in)\\s+(?:[^\\s:=]+\\s+){0,2}[^\\s:=]+)?` +
    String.raw`(?:\s+(?:is|was|are|were)(?:\s*[:=-])?\s+|\s*[:=]\s*|\s+[-–—]\s+|['’]s\s+)(\S+)`,
  "gi"
);

/** A value given, then named: "hunter2 is my password", "use hunter2 as the wifi password", "hunter2, my password", "482913 is the code". */
const REVERSED = new RegExp(
  String.raw`(\S+)(?:\s+(?:is|was|=|as)|,)\s+(?:(?:my|the|our|your|his|her|their|a|an)\s+)?(?:[\w-]+\s+)?(${CREDENTIAL}|\bcodes?\b)` +
    String.raw`(?=\s*(?:$|[.,;!?)]|(?:for|to|on|at|of|from|with|in|and|or|but|so)\b))`,
  "gi"
);
const CREDENTIAL_WORD = new RegExp(CREDENTIAL, "gi");
/** The credentials that are plainly the secret itself, so any word given as one is refused. */
const PASSWORD = /^(?:pass(?:word|phrase|code)s?|passwd|pwd|pw|pins?(?:\s+(?:code|number)s?)?)$/i;

/** Words that say something about a credential rather than give it: "the password is on the fridge". */
const NOT_A_VALUE = new Set(
  (
    "a an the my your his her their our its this that these those it what which who where how why there here mine yours " +
    "on in at under behind inside with by for from of to about as and or but if when not no never still now also too very so " +
    "same different new old wrong incorrect correct right required needed due set reset saved stored kept written lost missing " +
    "forgotten unknown long short weak strong secure safe valid invalid ok okay fine broken see ask somewhere below above attached"
  ).split(" ")
);

/** `raw` without the punctuation around it. */
function bare(raw: string): string {
  return raw.replace(/^[\s"'“”‘’`([{<.,;:!?—–-]+|[\s"'“”‘’`)\]}>.,;:!?—–-]+$/g, "");
}

/** A word that could be what a credential is: anything but a word about it, a verb form, or a digit or two. */
function anyValue(raw: string): boolean {
  const value = bare(raw);
  if (!value || NOT_A_VALUE.has(value.toLowerCase())) return false;
  if (/^[a-z]+(?:ing|ed)$/.test(value)) return false;
  return !/^\d{1,2}$/.test(value);
}

/**
 * A word shaped like a password or code, so it counts without "is" or ":"
 * between it and the credential: four or more digits, letters with digits
 * ("hunter2", not "4pm" or "2fa"), or letters with symbols ("p@ss").
 */
function codeLike(raw: string): boolean {
  const value = bare(raw);
  if (/^\d{4,}$/.test(value)) return true;
  if (/\d/.test(value) && /[A-Za-z]/.test(value)) {
    return value.length >= 4 && !/^\d+(?:st|nd|rd|th|am|pm|h|hrs?|m|mins?|s|secs?|d|days?|x|k|gb|mb|kb|fa)$/i.test(value);
  }
  return /[A-Za-z]/.test(value) && /[!@#$%^&*+=?~|<>]/.test(value);
}

/** A credential with what looks like its value beside it, in either order. */
function namedSecret(text: string): boolean {
  for (const match of text.matchAll(NAMED)) if (anyValue(match[1]!)) return true;
  for (const match of text.matchAll(REVERSED)) {
    if (codeLike(match[1]!) || (PASSWORD.test(match[2]!) && anyValue(match[1]!))) return true;
  }
  for (const match of text.matchAll(CREDENTIAL_WORD)) {
    const credential = match[0];
    const after = text.slice(match.index + credential.length);
    // "PIN-pad" and "password-protected" are words of their own.
    if (/^-\w/.test(after)) continue;
    const words = after.trim().split(/\s+/).slice(0, 4).map(bare);
    if (words[0] && codeLike(words[0])) return true;
    if (words[0] && CARD_CODE.test(credential) && /^\d{3,4}$/.test(words[0])) return true;
    // "the OTP from the bank 482913", but not "my PIN expires in 2027".
    if (!NOT_NUMERIC.test(credential) && words.some((word) => /^\d{4,8}$/.test(word) && !/^(?:19|20)\d\d$/.test(word))) return true;
  }
  return false;
}

/** A code: "code 482913", "the code was 4829", but not a postcode or area code. */
const CODE = /(?<!\b(?:zip|post|postal|area|country|dial(?:l)?ing|sort|promo|discount|voucher|coupon|bar|qr|source|dress|colou?r|error|status|tax|product|style)\s?)\bcode\b\D{0,12}\d{4,8}\b/i;

/**
 * Why `text` isn't kept, or null. Errs on refusing: the agent says why, and
 * the User can say the fact without the secret. The reason never repeats
 * the text.
 */
export function secretProblem(text: string): string | null {
  for (const [pattern, what] of KEY_PATTERNS) if (pattern.test(text)) return `It looks like ${what}`;
  if (namedSecret(text)) return "It looks like a password, code, key or token";
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

const memoriesTable = table("memories", { id: integer, text, source: textOf(literal("user", "agent")), created_at: integer });
const memoryRow = memoriesTable.row;
type Row = RowOf<typeof memoryRow>;

function toMemory(row: Row): Memory {
  return { id: row.id, text: row.text, source: row.source, createdAt: row.created_at };
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
    return rows(this.#sql, memoryRow, "SELECT id, text, source, created_at FROM memories ORDER BY id DESC").map(toMemory);
  }

  get(id: number): Memory | undefined {
    const row = one(this.#sql, memoryRow, "SELECT id, text, source, created_at FROM memories WHERE id = ?", id);
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
    const existing = one(this.#sql, memoryRow, "SELECT id, text, source, created_at FROM memories WHERE text = ?", text);
    if (existing) return { memory: toMemory(existing), created: false };
    if (this.count() >= MAX_MEMORIES) {
      throw new MemoryError(`Memory is full (${MAX_MEMORIES} notes). Nothing was dropped to make room: forget a note first, or ask the User which to remove`);
    }
    const row = one(this.#sql, memoryRow, "INSERT INTO memories (text, source, created_at) VALUES (?, ?, ?) RETURNING id, text, source, created_at", text, source, this.#now())!;
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
