/** Direct Conversations between the User and Company. */
import { type DirectUpdate } from "../poppy/wire";
import { type Send, useSend } from "./connection";
import { useState, useContext } from "react";
import { IconAction, Action } from "./controls";
import { XIcon, UserIcon, PaperPlaneRightIcon, UsersIcon } from "@phosphor-icons/react";
import { cn, InputArea, Tabs } from "@cloudflare/kumo";
import { type PoppyView } from "../use-pi-session";
import { RequestPanelContext } from "./poppy-card-frame";

// ---------------------------------------------------------------- Direct Conversations

/** Who is speaking for the Company: a person or its agent, by the name it gives when it gives one (0.3 8.4). */
function speaker(update: DirectUpdate, sender: "agent" | "human", name?: string): string {
  if (name) return sender === "human" ? `${name}, a person at ${update.company}` : `${name}, ${update.company}'s agent`;
  return sender === "human" ? `A person at ${update.company}` : `${update.company}'s agent`;
}

/** A Direct Conversation: the User talks with the Company; their words go as written. */
function DirectPanel({ update, send: sendFrame, onHide }: { update: DirectUpdate; send: Send; onHide?: () => void }) {
  const [text, setText] = useState("");
  const { send, disabled, note } = useSend(sendFrame);
  const answering = update.responder === "human" ? "human" : "agent";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-b border-kumo-hairline px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-balance text-kumo-strong">You're talking with {update.company}</h2>
          <p className="text-[13px] text-kumo-subtle">
            {speaker(update, answering)} is answering · Your words go as written, from you
          </p>
        </div>
        {onHide ? <IconAction label="Hide conversation" variant="ghost" icon={<XIcon size={20} />} onClick={onHide} /> : null}
      </header>
      <ol className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-label={`Messages with ${update.company}`}>
        {(update.messages ?? []).map((message) => (
          <li key={message.id} className={message.role === "user" ? "flex flex-col items-end" : "flex flex-col items-start"}>
            <p className="mb-1 flex items-center gap-1 text-[13px] text-kumo-subtle">
              {message.role === "user" ? (
                "You"
              ) : (
                <>
                  <UserIcon size={16} aria-hidden />
                  <span>{speaker(update, message.sender, message.authorName)}</span>
                </>
              )}
            </p>
            <div
              className={cn(
                "max-w-[85%] rounded-xl px-3 py-2 text-base text-pretty break-words whitespace-pre-wrap",
                message.role === "user" ? "bg-kumo-recessed text-kumo-default" : "ring ring-kumo-hairline"
              )}
            >
              {message.text}
              {message.data !== undefined ? (
                <details className="mt-1 text-[13px]">
                  <summary className="cursor-pointer text-kumo-subtle">Details sent</summary>
                  <pre className="mt-1 overflow-x-auto font-mono text-[13px] whitespace-pre-wrap">{JSON.stringify(message.data, null, 2)}</pre>
                </details>
              ) : null}
            </div>
          </li>
        ))}
        {update.partial ? (
          <li className="flex flex-col items-start" aria-live="polite">
            <p className="mb-1 text-[13px] text-kumo-subtle">{speaker(update, answering)}, writing</p>
            <div className="max-w-[85%] rounded-xl px-3 py-2 text-base text-kumo-subtle ring ring-kumo-hairline">{update.partial.text}</div>
          </li>
        ) : null}
      </ol>
      <form
        className="flex shrink-0 items-end gap-2 border-t border-kumo-hairline px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || disabled) return;
          // What the User wrote stays in the box unless it went.
          if (send({ type: "poppy.direct.say", conversationId: update.conversationId, text: text.trim() })) setText("");
        }}
      >
        <InputArea
          value={text}
          onValueChange={setText}
          rows={1}
          placeholder={`Write to ${update.company}`}
          aria-label={`Message ${update.company}`}
          className="flex-1 text-base"
        />
        <Action type="submit" variant="primary" disabled={!text.trim() || disabled} icon={<PaperPlaneRightIcon size={16} aria-hidden />}>
          Send
        </Action>
      </form>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 pb-3">
        {note ? <div className="basis-full text-right">{note}</div> : null}
        <Action variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.direct.close", conversationId: update.conversationId })}>
          End conversation
        </Action>
      </div>
    </div>
  );
}

/** Open Direct Conversations, in the order they started. */
export function openDirect(view: PoppyView): DirectUpdate[] {
  return Object.values(view.direct).filter((update) => !update.closed);
}

/**
 * The Direct Conversation sheet: a column beside the chat on wide screens,
 * the whole screen on phones. Nothing while no conversation is open.
 */
export function DirectConversations({ view, send, onHide }: { view: PoppyView; send: Send; onHide?: () => void }) {
  const open = openDirect(view);
  const [chosen, setChosen] = useState<string | null>(null);
  if (open.length === 0) return null;
  const current = open.find((update) => update.conversationId === chosen) ?? open.at(-1)!;
  return (
    <aside
      aria-label={`Conversation with ${current.company}`}
      className="sheet fixed inset-0 z-30 flex flex-col bg-kumo-base lg:static lg:z-auto lg:border-l lg:border-kumo-hairline"
    >
      {open.length > 1 ? (
        <div className="shrink-0 border-b border-kumo-hairline px-4 py-2">
          <Tabs
            variant="segmented"
            value={current.conversationId}
            onValueChange={(value) => setChosen(String(value))}
            tabs={open.map((update) => ({ value: update.conversationId, label: update.company }))}
          />
        </div>
      ) : null}
      <DirectPanel key={current.conversationId} update={current} send={send} {...(onHide ? { onHide } : {})} />
    </aside>
  );
}

/** Shown in the tray while a Direct Conversation is open but hidden. */
export function HiddenDirectRow({ update, onOpen }: { update: DirectUpdate; onOpen: () => void }) {
  const inPanel = useContext(RequestPanelContext);
  return (
    <div className={cn("flex flex-wrap items-center gap-3", inPanel ? "p-4" : "rounded-xl bg-kumo-base p-3 ring ring-kumo-hairline")}>
      <UsersIcon size={16} aria-hidden className="shrink-0 text-kumo-warning" />
      <p className="min-w-0 flex-1 text-base">You're talking with {update.company}</p>
      <Action variant="primary" onClick={onOpen}>
        Open conversation
      </Action>
    </div>
  );
}
