/** Message composition, explicit task permissions, and attachment upload state. */
import { useState, useMemo, useRef } from "react";
import { type PendingAttachment, attachProblem, uploadAttachment, removeAttachment, withMarkers, PendingAttachments } from "./attachments";
import { type PiSession } from "../use-pi-session";
import { companyDomains, readTaskAccess } from "../task-access";
import { ATTACHMENT_TYPES } from "../attachments";
import { IconAction, Action } from "./controls";
import { ImageIcon, StopIcon, PaperPlaneRightIcon } from "@phosphor-icons/react";
import { InputArea } from "@cloudflare/kumo";
import { NOT_SENT } from "./connection";

/** Photos in the composer: attach (picker, paste or drop), remove, and the ready ones for sending. */
function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const add = (files: Iterable<File>) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      const name = file.name || "Pasted photo";
      const problem = attachProblem(file);
      if (problem) {
        setItems((current) => [...current, { key, name, state: "failed", error: problem }]);
        continue;
      }
      setItems((current) => [...current, { key, name, state: "uploading" }]);
      uploadAttachment(file).then(
        (info) => setItems((current) => current.map((item) => (item.key === key ? { key, name: info.name, state: "ready", info } : item))),
        (error: unknown) =>
          setItems((current) =>
            current.map((item) => (item.key === key ? { key, name, state: "failed", error: error instanceof Error ? error.message : String(error) } : item))
          )
      );
    }
  };
  const remove = (key: string) => {
    const item = items.find((candidate) => candidate.key === key);
    if (item?.state === "ready") removeAttachment(item.info.id);
    setItems((current) => current.filter((candidate) => candidate.key !== key));
  };
  const ready = items.flatMap((item) => (item.state === "ready" ? [item.info] : []));
  const uploading = items.some((item) => item.state === "uploading");
  return { items, add, remove, ready, uploading, clear: () => setItems([]) };
}

/** The image files among dropped or pasted items. */
function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
}

export function Composer({ session }: { session: PiSession }) {
  const [prompt, setPrompt] = useState("");
  const [companies, setCompanies] = useState("");
  const [uploadCompany, setUploadCompany] = useState("");
  const [uploadFiles, setUploadFiles] = useState<ReadonlySet<string>>(new Set());
  const [accessError, setAccessError] = useState<string | null>(null);
  const companyOptions = useMemo(() => { try { return companyDomains(companies); } catch { return []; } }, [companies]);
  const attachments = useAttachments();
  const picker = useRef<HTMLInputElement>(null);
  const connected = session.status === "open";
  const [stopNotSent, setStopNotSent] = useState(false);
  const hintId = "composer-hint";
  const sendable = session.status !== "unauthenticated" && (prompt.trim() !== "" || attachments.ready.length > 0) && !attachments.uploading;
  /**
   * While a run is going, Enter queues a follow-up and Steer joins the run.
   * Enter and the Send button both come here. Sending doesn't wait for the
   * connection: the message moves from the box into the chat as pending,
   * and goes once the agent is connected.
   */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    if (!sendable) return;
    let access;
    try {
      access = readTaskAccess({ companies: companyDomains(companies), uploads: uploadCompany && uploadFiles.size
        ? [{ company: uploadCompany, files: attachments.ready.filter(file => uploadFiles.has(file.id)).map(file => file.id) }] : [] });
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "Check the selected Companies and photos.");
      return;
    }
    const text = withMarkers(prompt, attachments.ready);
    setPrompt("");
    setCompanies("");
    setUploadCompany("");
    setUploadFiles(new Set());
    setAccessError(null);
    attachments.clear();
    session.submit(text, whenBusy, access);
  };
  return (
    <div className="shrink-0 border-t border-kumo-hairline bg-kumo-base">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragOver={(event) => {
          if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = imageFiles(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          attachments.add(files);
        }}
        className="mx-auto max-w-3xl px-4 pt-3 pb-3 sm:px-6"
      >
        <PendingAttachments items={attachments.items} onRemove={attachments.remove} />
        <fieldset className="mb-2 space-y-2 text-[13px] text-kumo-subtle">
          <legend className="sr-only">Access for this message</legend>
          <label className="flex flex-wrap items-center gap-2">
            <span>Companies for this message</span>
            <input aria-label="Companies for this message" value={companies} maxLength={2048}
              onChange={event => { setCompanies(event.currentTarget.value); setUploadCompany(""); setUploadFiles(new Set()); }}
              placeholder="shop.example, another.example (optional)" className="min-h-9 min-w-0 flex-1 rounded-md px-2 ring ring-kumo-line" />
          </label>
          {attachments.ready.length > 0 ? (
            <details>
              <summary className="cursor-pointer">Allow selected photos to upload to a Company</summary>
              <p className="my-2">Photos are shown to your model. Company uploads need a disclosure card unless you select the files and their destination here.</p>
              <label className="block">Photo destination
                <select aria-label="Photo upload destination" value={uploadCompany} onChange={event => setUploadCompany(event.currentTarget.value)} className="ml-2 min-h-9 max-w-full rounded-md px-2 ring ring-kumo-line">
                  <option value="">Choose a Company above</option>
                  {companyOptions.map(domain => <option key={domain} value={domain}>{domain}</option>)}
                </select>
              </label>
              {attachments.ready.map(file => <label key={file.id} className="mt-2 flex items-center gap-2">
                <input type="checkbox" aria-label={`Allow upload of ${file.name}`} checked={uploadFiles.has(file.id)} onChange={event => setUploadFiles(current => { const next = new Set(current); if (event.target.checked) next.add(file.id); else next.delete(file.id); return next; })} />
                <span className="min-w-0 break-words">Allow {file.name} to upload to this destination for this message</span>
              </label>)}
            </details>
          ) : null}
          {accessError ? <p role="alert" className="text-kumo-danger">{accessError}</p> : null}
        </fieldset>
        <input
          ref={picker}
          type="file"
          accept={ATTACHMENT_TYPES.join(",")}
          multiple
          hidden
          aria-hidden
          tabIndex={-1}
          data-testid="attach-input"
          onChange={(event) => {
            attachments.add([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
        <div className="flex items-end gap-2 rounded-xl bg-kumo-base p-2 ring ring-kumo-line focus-within:ring-2 focus-within:ring-kumo-brand">
          <IconAction
            label="Attach a photo"
            type="button"
            variant="ghost"
            icon={<ImageIcon size={16} />}
            onClick={() => picker.current?.click()}
          />
          <InputArea
            value={prompt}
            onValueChange={setPrompt}
            onPaste={(event) => {
              const files = imageFiles(event.clipboardData?.files);
              if (files.length === 0) return;
              event.preventDefault();
              attachments.add(files);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={session.running ? "Add to what it's doing, or queue a follow-up" : "Message your agent"}
            aria-label="Message your agent"
            aria-describedby={hintId}
            rows={2}
            className="flex-1 resize-none bg-transparent! text-base shadow-none! ring-0! outline-none! focus:ring-0!"
          />
          {session.running ? (
            <div className="flex gap-1.5">
              <Action type="button" variant="secondary" disabled={!sendable} onClick={() => submit("steer")}>
                Steer
              </Action>
              {/* Stop isn't queued: disabled while disconnected, and a click on a socket that just closed says it didn't go. */}
              <IconAction
                label="Stop the agent"
                variant="secondary"
                disabled={!connected}
                icon={<StopIcon size={16} weight="fill" />}
                onClick={() => setStopNotSent(!session.abort())}
              />
            </div>
          ) : (
            <IconAction
              label="Send message"
              type="submit"
              variant="primary"
              disabled={!sendable}
              icon={<PaperPlaneRightIcon size={16} />}
            />
          )}
        </div>
        <p id={hintId} className="mt-1.5 text-[13px] text-kumo-subtle max-sm:sr-only">
          {session.status === "unauthenticated" ? "Sign in again to send. Copy any draft you want to keep before reloading." : connected
            ? session.running
              ? "Enter queues a follow-up · Steer adds it to the current answer"
              : "Enter to send · Shift+Enter for a new line · Attach, paste or drop a photo"
            : "Not connected yet. What you send waits in the chat and goes once your agent is connected."}
        </p>
        {stopNotSent && session.running ? (
          <p role="alert" className="mt-1.5 text-[13px] text-kumo-danger">
            {NOT_SENT}
          </p>
        ) : null}
      </form>
    </div>
  );
}
