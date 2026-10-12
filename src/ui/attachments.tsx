import { ImageIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { ATTACHMENT_TYPES, attachmentMarker, humanSize, MAX_ATTACHMENT_BYTES, MAX_PREVIEW_BYTES, type AttachmentInfo } from "../attachments";
import { IconAction } from "./controls";

/**
 * Photos in the chat (src/attachments.ts): attaching one in the composer,
 * and showing one where it was sent or where an approval card asks to send
 * it. The page sends the file to its own agent (`POST /api/attachments`),
 * with a smaller copy for the model when the browser can make one, and puts
 * a marker naming it in the message. The photo is shown from the agent
 * (`/api/attachments/<id>`), so it needs no `blob:` or remote image source.
 */

/** What the composer holds for each file: uploading, attached, or refused. */
export type PendingAttachment =
  | { readonly key: string; readonly name: string; readonly state: "uploading" }
  | { readonly key: string; readonly name: string; readonly state: "ready"; readonly info: AttachmentInfo }
  | { readonly key: string; readonly name: string; readonly state: "failed"; readonly error: string };

/** The longest side of the copy the model sees, in pixels. */
const PREVIEW_SIDE = 1568;

/** Why this file can't be attached, before sending it anywhere; null if it can. */
export function attachProblem(file: File): string | null {
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return `${file.name || "That file"} isn't a JPEG, PNG, WebP or GIF photo.`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name || "That photo"} is ${humanSize(file.size)}; the most your agent takes is ${humanSize(MAX_ATTACHMENT_BYTES)}.`;
  return null;
}

/**
 * A JPEG at most `PREVIEW_SIDE` pixels on its longer side, for the model to
 * look at; null where the browser can't draw the image (then the agent shows
 * the model the file itself if it is small, or only its name).
 */
async function previewOf(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PREVIEW_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob && blob.size <= MAX_PREVIEW_BYTES ? blob : null;
  } catch {
    return null;
  }
}

/** Send a photo to the User's own agent; its id, name, type and size, or the agent's reason for refusing it. */
export async function uploadAttachment(file: File): Promise<AttachmentInfo> {
  const form = new FormData();
  form.append("file", file, file.name);
  const preview = await previewOf(file);
  if (preview) form.append("preview", preview, "preview.jpg");
  const response = await fetch("/api/attachments", { method: "POST", credentials: "same-origin", body: form });
  const body = (await response.json().catch(() => null)) as (AttachmentInfo & { error?: string }) | null;
  if (!response.ok || !body?.id) throw new Error(body?.error ?? `Couldn't attach ${file.name || "the photo"} (${response.status}).`);
  return body;
}

/** Forget a photo the User removed before sending. */
export function removeAttachment(id: string): void {
  void fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
}

/** The message text with a marker for each attached photo, as the model and the transcript read it. */
export function withMarkers(text: string, attached: readonly AttachmentInfo[]): string {
  return [text.trim(), ...attached.map(attachmentMarker)].filter(Boolean).join("\n\n");
}

const SHOWN_MARKER = /\[attachment (att_[A-Za-z0-9_-]{22}) · ([^\]\n]*?) · (image\/[a-z]+) · ([^\]\n]*)\]/g;

/** A sent message's text without its markers, and the photos they name. */
export function splitMarkers(text: string): { text: string; photos: { id: string; name: string; size: string }[] } {
  const photos: { id: string; name: string; size: string }[] = [];
  const rest = text.replace(SHOWN_MARKER, (_match, id: string, name: string, _type: string, size: string) => {
    photos.push({ id, name, size });
    return "";
  });
  return { text: rest.trim(), photos };
}

/** One photo, from the User's agent: in a sent message, on an approval card, in the composer. */
export function AttachmentThumb({ id, name, detail, size = "md" }: { id: string; name: string; detail?: string; size?: "sm" | "md" }) {
  return (
    <figure className="inline-flex max-w-full flex-col gap-1">
      <img
        src={`/api/attachments/${encodeURIComponent(id)}`}
        alt={name}
        loading="lazy"
        className={size === "sm" ? "image-outline size-16 rounded-lg object-cover" : "image-outline max-h-48 max-w-full rounded-lg object-contain"}
      />
      <figcaption className="truncate text-[13px] text-kumo-subtle">
        {name}
        {detail ? ` · ${detail}` : ""}
      </figcaption>
    </figure>
  );
}

/** The composer's photos: each with its state and a way to take it out. */
export function PendingAttachments({ items, onRemove }: { items: readonly PendingAttachment[]; onRemove: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Photos to send" className="flex flex-wrap gap-2 px-1 pb-2">
      {items.map((item) => (
        <li key={item.key} className="flex max-w-full items-center gap-2 rounded-lg bg-kumo-recessed p-1.5 pr-1">
          {item.state === "ready" ? (
            <img src={`/api/attachments/${encodeURIComponent(item.info.id)}`} alt="" className="size-10 shrink-0 rounded-md object-cover" />
          ) : (
            <span aria-hidden className={item.state === "failed" ? "text-kumo-danger" : "text-kumo-subtle"}>
              {item.state === "failed" ? <WarningCircleIcon size={20} /> : <ImageIcon size={20} />}
            </span>
          )}
          <span className="min-w-0 text-[13px]">
            <span className="block truncate font-medium text-kumo-default">{item.name}</span>
            <span role={item.state === "failed" ? "alert" : undefined} className={item.state === "failed" ? "block text-kumo-danger" : "block text-kumo-subtle"}>
              {item.state === "uploading" ? "Attaching…" : item.state === "ready" ? humanSize(item.info.size) : item.error}
            </span>
          </span>
          <IconAction label={`Remove ${item.name}`} variant="ghost" icon={<XIcon size={16} />} onClick={() => onRemove(item.key)} />
        </li>
      ))}
    </ul>
  );
}
