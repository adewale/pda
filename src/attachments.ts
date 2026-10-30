import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { base64url } from "./base64url";
import { SUMMARY_MESSAGE_PREFIX } from "./summary-format";

/**
 * Photos the User attaches to a chat message, kept in their own agent's
 * SQLite and nowhere else.
 *
 * - **Where.** The bytes are split into 1 MiB rows (`attachment_chunks`),
 *   under the 2 MB a Durable Object's SQLite allows in one row. No R2: one
 *   person's few photos fit the object's own storage, and keeping them there
 *   means they live and die with the agent, under the same access as the rest
 *   of its state.
 * - **What.** JPEG, PNG, WebP or GIF, by their first bytes (the type the
 *   browser declared is ignored), at most 10 MiB each, which also keeps them
 *   under the 20 MB print-with-poppy takes. An agent holds at most 100 MiB of
 *   them, files and the model's copies together.
 * - **How long.** 30 days from when it was attached (`KEEP_MS`). Every read
 *   takes the agent's clock and first deletes whatever is past its 30 days,
 *   so an older photo is never served, shown to the model or sent to a
 *   Company; the agent's `attachments` job (`src/attachment-images.ts`)
 *   deletes each one when its time comes, whether or not anything reads it.
 * - **Who sees them.** The User, on their own page (`GET /api/attachments/<id>`).
 *   The model sees a preview, or the small original when no preview exists,
 *   in the message it was attached to (`src/attachment-images.ts`), never
 *   the bytes in a tool argument: tools name
 *   an attachment by its id. A Company gets one in an upload for the User's
 *   task using a photo they selected; a different saved photo still needs
 *   disclosure consent (`src/poppy/apis.ts`, `task-files.ts`). Nothing logs them.
 */

export const ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** The largest file the User can attach. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** The largest copy the model is shown: the page's preview, or the file itself when that is small enough. */
export const MAX_PREVIEW_BYTES = 1024 * 1024;
/** Everything one agent keeps. */
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** How long an attachment is kept. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Images the model is shown in one request: those of the most recent attachments. */
export const MODEL_IMAGES = 4;

const CHUNK_BYTES = 1024 * 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    preview_type TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS attachment_chunks (
    id TEXT NOT NULL,
    part TEXT NOT NULL,
    seq INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (id, part, seq)
  )`
];

export function migrateAttachments(sql: SqlStorage): void {
  for (const statement of SCHEMA) sql.exec(statement);
}

/** What the page, the model and an approval card are told about an attachment: never its bytes. */
export type AttachmentInfo = {
  readonly id: string;
  readonly name: string;
  readonly type: AttachmentType;
  readonly size: number;
};

/** A refusal to keep an attachment, worded for the User, with the HTTP status the page gets. */
export class AttachmentError extends Error {
  override name = "AttachmentError";
  constructor(
    readonly status: 400 | 413 | 415 | 507,
    message: string
  ) {
    super(message);
  }
}

/** The image type of `bytes`, from their first bytes, or null for anything else. */
export function sniffImage(bytes: Uint8Array): AttachmentType | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

const EXTENSION: Record<AttachmentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

/**
 * A file name safe to show and to send: the last path segment, without
 * control characters, brackets or quotes (it goes in the model's marker and a
 * multipart header), at most 100 characters, and a plain name when nothing is left.
 */
export function cleanName(name: string | null | undefined, type: AttachmentType): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>"[\]·]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return cleaned || `photo.${EXTENSION[type]}`;
}

/** "2.4 MB", "820 KB": how big, for people. */
export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function writeChunks(sql: SqlStorage, id: string, part: "file" | "preview", bytes: Uint8Array): void {
  for (let seq = 0, offset = 0; offset < bytes.byteLength; seq++, offset += CHUNK_BYTES) {
    const chunk = bytes.slice(offset, offset + CHUNK_BYTES);
    sql.exec("INSERT INTO attachment_chunks (id, part, seq, bytes) VALUES (?, ?, ?, ?)", id, part, seq, chunk.buffer);
  }
}

function readChunks(sql: SqlStorage, id: string, part: "file" | "preview"): Uint8Array<ArrayBuffer> | null {
  const rows = sql.exec("SELECT bytes FROM attachment_chunks WHERE id = ? AND part = ? ORDER BY seq", id, part).toArray();
  if (rows.length === 0) return null;
  const chunks = rows.map((row) => new Uint8Array(row.bytes as ArrayBuffer));
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function deleteAttachment(sql: SqlStorage, id: string): boolean {
  const found = sql.exec("SELECT id FROM attachments WHERE id = ?", id).toArray().length > 0;
  sql.exec("DELETE FROM attachment_chunks WHERE id = ?", id);
  sql.exec("DELETE FROM attachments WHERE id = ?", id);
  return found;
}

/** Attachments past their 30 days at `now`, bytes and preview, gone. Returns how many. */
export function pruneAttachments(sql: SqlStorage, now: number): number {
  const expired = sql.exec("SELECT id FROM attachments WHERE created_at <= ?", now - KEEP_MS).toArray();
  for (const row of expired) deleteAttachment(sql, String(row.id));
  return expired.length;
}

/** When the oldest attachment kept reaches its 30 days, or null when there is none. */
export function nextExpiry(sql: SqlStorage): number | null {
  const oldest = sql.exec("SELECT MIN(created_at) AS oldest FROM attachments").one().oldest;
  return oldest === null ? null : Number(oldest) + KEEP_MS;
}

/** Every byte the agent keeps of its attachments: files and the model's copies. */
function heldBytes(sql: SqlStorage): number {
  return Number(sql.exec("SELECT COALESCE(SUM(length(bytes)), 0) AS total FROM attachment_chunks").one().total);
}

/**
 * Keep a file the User attached, and the smaller copy the page made of it
 * for the model, if any. Refuses anything that isn't an image of a type we
 * take, an empty or oversized file, and a file that, with its preview, would
 * take the agent past what it keeps.
 */
export function saveAttachment(
  sql: SqlStorage,
  input: { readonly name?: string | null; readonly bytes: Uint8Array; readonly preview?: Uint8Array | null; readonly now?: number }
): AttachmentInfo {
  const now = input.now ?? Date.now();
  if (input.bytes.byteLength === 0) throw new AttachmentError(400, "The file is empty.");
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(413, `That photo is ${humanSize(input.bytes.byteLength)}; the most your agent takes is ${humanSize(MAX_ATTACHMENT_BYTES)}.`);
  }
  const type = sniffImage(input.bytes);
  if (!type) throw new AttachmentError(415, "Attach a photo: JPEG, PNG, WebP or GIF.");
  pruneAttachments(sql, now);
  const offered = input.preview && input.preview.byteLength <= MAX_PREVIEW_BYTES ? input.preview : null;
  const previewType = offered ? sniffImage(offered) : null;
  const preview = previewType ? offered : null;
  const held = heldBytes(sql);
  if (held + input.bytes.byteLength + (preview?.byteLength ?? 0) > MAX_TOTAL_BYTES) {
    throw new AttachmentError(507, `Your agent already keeps ${humanSize(held)} of photos, the most it holds; older ones are deleted 30 days after you attached them.`);
  }
  const id = `att_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;
  const name = cleanName(input.name, type);
  sql.exec(
    "INSERT INTO attachments (id, name, type, size, preview_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    name,
    type,
    input.bytes.byteLength,
    previewType,
    now
  );
  writeChunks(sql, id, "file", input.bytes);
  if (preview) writeChunks(sql, id, "preview", preview);
  return { id, name, type, size: input.bytes.byteLength };
}

/** An attachment kept at `now`: one past its 30 days is deleted first, and undefined. */
export function attachmentInfo(sql: SqlStorage, id: string, now: number): AttachmentInfo | undefined {
  pruneAttachments(sql, now);
  const row = sql.exec("SELECT id, name, type, size FROM attachments WHERE id = ?", id).toArray()[0];
  if (!row) return undefined;
  return { id: String(row.id), name: String(row.name), type: String(row.type) as AttachmentType, size: Number(row.size) };
}

/** The file as the User attached it. */
export function readAttachment(sql: SqlStorage, id: string, now: number): { info: AttachmentInfo; bytes: Uint8Array<ArrayBuffer> } | undefined {
  const info = attachmentInfo(sql, id, now);
  const bytes = info ? readChunks(sql, id, "file") : null;
  return info && bytes ? { info, bytes } : undefined;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** What the model is shown of an attachment: the page's preview, else the file if it is small enough, else nothing. */
export function modelImage(sql: SqlStorage, id: string, now: number): ImageContent | null {
  pruneAttachments(sql, now);
  const row = sql.exec("SELECT type, size, preview_type FROM attachments WHERE id = ?", id).toArray()[0];
  if (!row) return null;
  if (row.preview_type) {
    const preview = readChunks(sql, id, "preview");
    if (preview) return { type: "image", data: base64(preview), mimeType: String(row.preview_type) };
  }
  if (Number(row.size) > MAX_PREVIEW_BYTES) return null;
  const file = readChunks(sql, id, "file");
  return file ? { type: "image", data: base64(file), mimeType: String(row.type) } : null;
}

// ---------------------------------------------------------------- In the conversation

/**
 * How an attachment appears in the User's message: a marker the page adds
 * when it sends the message, which the model reads and the page shows as the
 * photo. The model names the attachment by its id.
 */
export function attachmentMarker(info: AttachmentInfo): string {
  return `[attachment ${info.id} · ${info.name} · ${info.type} · ${humanSize(info.size)}]`;
}

export const MARKER = /\[attachment (att_[A-Za-z0-9_-]{22})(?: · [^\]\n]*)?\]/g;

/** The attachment ids a message's text names, in order. */
export function markersIn(text: string): string[] {
  return [...text.matchAll(MARKER)].map((match) => match[1]!);
}

function textOf(message: Message): string {
  if (message.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Text that starts with a marker: a message the User sent with photos and no words. */
const STARTS_WITH_MARKER = new RegExp(`^${MARKER.source}`);

/**
 * The messages a request sends, with each recent attachment shown to the
 * model as an image in the User's message that names it, words or none. Only
 * the User's own messages count: a Company's text or one of our notices (both
 * start with a `[` label of ours, never a marker) can't make the model look at
 * a photo. Only the `MODEL_IMAGES` most
 * recent attachments are shown, to keep requests small; older markers stay
 * as text. An attachment since deleted is just text.
 */
export function withAttachmentImages(messages: readonly Message[], image: (id: string) => ImageContent | null): readonly Message[] {
  const wanted: { index: number; id: string }[] = [];
  messages.forEach((message, index) => {
    const text = textOf(message);
    const lead = text.trimStart();
    if (!lead || lead.startsWith(SUMMARY_MESSAGE_PREFIX) || (lead.startsWith("[") && !STARTS_WITH_MARKER.test(lead))) return;
    for (const id of markersIn(text)) wanted.push({ index, id });
  });
  const shown = wanted.slice(-MODEL_IMAGES);
  if (shown.length === 0) return messages;
  const images = new Map<number, ImageContent[]>();
  for (const { index, id } of shown) {
    const found = image(id);
    if (found) images.set(index, [...(images.get(index) ?? []), found]);
  }
  if (images.size === 0) return messages;
  return messages.map((message, index) => {
    const extra = images.get(index);
    if (!extra || message.role !== "user") return message;
    const parts: (TextContent | ImageContent)[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
    return { ...message, content: [...parts, ...extra] };
  });
}
