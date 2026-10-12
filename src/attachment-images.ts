import { GenerationTask, hook, type Extension } from "@earendil-works/pi-durable";
import { modelImage, withAttachmentImages } from "./attachments";

/**
 * The pi extension that shows the model the User's attachments: on every
 * request, each recent attachment's preview goes in as an image in the
 * message that names it. The images are never stored in the transcript, so
 * the page's snapshots stay small and a deleted attachment stops being shown.
 * Apart from `src/attachments.ts` so the interop adapter, which bundles that
 * file without pi, can use it.
 */
export function attachmentsExtension(sql: () => SqlStorage): Extension {
  return {
    name: "attachments",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => ({ messages: withAttachmentImages(messages, (id) => modelImage(sql(), id)) })
      })
    ]
  };
}
