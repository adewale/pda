import { GenerationTask, hook, type Extension } from "@earendil-works/pi-durable";
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { modelImage, nextExpiry, pruneAttachments, withAttachmentImages } from "./attachments";
import { literal, plainUnits, type Units } from "./log";

/**
 * The agent's side of the User's attachments, apart from `src/attachments.ts`
 * so the interop adapter, which bundles that file without pi, can use it:
 *
 * - `attachmentsExtension`, the pi extension that shows the model the User's
 *   attachments: on every request, each recent attachment's preview goes in
 *   as an image in the message that names it. The images are never stored in
 *   the transcript, so the page's snapshots stay small and a deleted or
 *   expired attachment stops being shown.
 * - `AttachmentExpiry`, the Lifecycle capability that deletes each one 30
 *   days after it was attached: one job, at the oldest one's time, and none
 *   while the agent keeps no photos.
 */
export function attachmentsExtension(sql: () => SqlStorage, now: () => number): Extension {
  return {
    name: "attachments",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => ({ messages: withAttachmentImages(messages, (id) => modelImage(sql(), id, now())) })
      })
    ]
  };
}

export type AttachmentExpiryOptions = {
  readonly sql: () => SqlStorage;
  /** Now, in epoch ms, on the clock attachments are dated by. */
  readonly now: () => number;
  /** When the job queue should wake for something due at `at`; the same instant in production. */
  readonly jobTime: (at: number) => number;
  /** Where each run writes its wide event (src/log.ts); `plainUnits` by default. */
  readonly units?: Units;
};

const JOB = "attachments-expire";
const JOB_ID = "attachments:expire";

export class AttachmentExpiry extends LifecycleCapability {
  readonly #options: AttachmentExpiryOptions;

  constructor(options: AttachmentExpiryOptions) {
    super("attachments");
    this.#options = options;
  }

  /** After a photo is kept or deleted: the job wakes when the oldest one is due, or there is no job. */
  async arm(): Promise<void> {
    const due = nextExpiry(this.#options.sql());
    if (due === null) {
      if (this.lifecycle.jobs.get(JOB_ID)) await this.lifecycle.jobs.cancel(JOB_ID);
      return;
    }
    const time = this.#options.jobTime(due);
    if (this.lifecycle.jobs.get(JOB_ID)?.time === time) return;
    await this.lifecycle.jobs.push({ fn: JOB, time, id: JOB_ID, singleflight: true });
  }

  /** On start: whatever expired while the agent slept is deleted, and the job is set for the next. */
  override async onStart(): Promise<void> {
    pruneAttachments(this.#options.sql(), this.#options.now());
    await this.arm();
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (job.fn !== JOB) return;
    const units = this.#options.units ?? plainUnits;
    return units.job({ job: literal(JOB) }, async (event) => {
      const deleted = pruneAttachments(this.#options.sql(), this.#options.now());
      event.set({ deleted });
      const due = nextExpiry(this.#options.sql());
      return due === null ? undefined : { rescheduleAt: this.#options.jobTime(due) };
    });
  }
}
