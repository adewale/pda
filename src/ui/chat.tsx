import { cn, InputArea, Loader } from "@cloudflare/kumo";
import { ClockIcon, HandIcon, MagnifyingGlassIcon, PaperPlaneRightIcon, SignInIcon, StopIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DirectConversations, HiddenDirectRow, NeedsYouTray, openDirect, Receipts } from "../poppy-ui";
import type { PiSession } from "../use-pi-session";
import { Action, IconAction, useNow } from "./controls";
import { countdown } from "./format";
import { Transcript } from "./transcript";

function Capability({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-1 shrink-0 text-kumo-subtle">
        {icon}
      </span>
      <p className="text-base text-pretty">
        <span className="font-medium text-kumo-strong">{title}</span> <span className="text-kumo-subtle">{children}</span>
      </p>
    </li>
  );
}

/** Before the first message: what this agent does, in plain words. */
function Welcome() {
  return (
    <div className="max-w-[70ch] py-8 sm:py-14">
      <h2 className="text-xl font-semibold text-balance text-kumo-strong">Your agent works with companies for you</h2>
      <p className="mt-2 text-base text-pretty text-kumo-subtle">Tell it what you need, such as “Exchange my jumper for a size L at manzanita.example”. It remembers this conversation.</p>
      <ul className="mt-6 space-y-4">
        <Capability icon={<MagnifyingGlassIcon size={20} />} title="It finds the company">
          and what it offers personal agents: an API, its own agent to talk to, or its website.
        </Capability>
        <Capability icon={<SignInIcon size={20} />} title="You sign in on the company's own page.">
          Your agent never sees your password.
        </Capability>
        <Capability icon={<HandIcon size={20} />} title="It acts only with your approval,">
          or within a standing permission you set.
        </Capability>
        <Capability icon={<ClockIcon size={20} />} title="It keeps working while you're away,">
          and asks here when it needs you.
        </Capability>
      </ul>
    </div>
  );
}

/** The one place a spinner shows: while the agent is visibly working. */
function Working({ session }: { session: PiSession }) {
  const { running, live, tools, retry, queued } = session;
  const now = useNow(1000, retry !== null);
  if (!running) return null;
  // The tool's own line above says what it is doing; this only says that work is going on.
  const text = retry
    ? retry.at > now
      ? `The model didn't answer (${retry.error}). Trying again in ${countdown(retry.at - now)}`
      : "Trying the model again"
    : tools.length
      ? "Working"
      : live
        ? "Writing"
        : "Thinking";
  return (
    <div role="status" className="flex items-center gap-2 text-[13px] text-kumo-subtle tabular-nums">
      <Loader size={16} />
      <span>{text}</span>
      {queued > 0 ? <span>· {queued === 1 ? "1 message waits" : `${queued} messages wait`} for this to finish</span> : null}
    </div>
  );
}

/** Keeps the newest message in view while the reader is at the bottom; leaves them alone when they scroll up. */
function useStickToBottom(...dependencies: unknown[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  return scroller;
}

function Composer({ session }: { session: PiSession }) {
  const [prompt, setPrompt] = useState("");
  const connected = session.status === "open";
  const hintId = "composer-hint";
  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    session.submit(text, whenBusy);
  };
  return (
    <div className="shrink-0 border-t border-kumo-hairline bg-kumo-base">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="mx-auto max-w-3xl px-4 pt-3 pb-3 sm:px-6"
      >
        <div className="flex items-end gap-2 rounded-xl bg-kumo-base p-2 ring ring-kumo-line focus-within:ring-2 focus-within:ring-kumo-brand">
          <InputArea
            value={prompt}
            onValueChange={setPrompt}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={session.running ? "Add to what it's doing, or queue a follow-up" : "Message your agent"}
            aria-label="Message your agent"
            aria-describedby={hintId}
            disabled={!connected}
            rows={2}
            className="flex-1 resize-none bg-transparent! text-base shadow-none! ring-0! outline-none! focus:ring-0!"
          />
          {session.running ? (
            <div className="flex gap-1.5">
              <Action type="button" variant="secondary" disabled={prompt.trim() === ""} onClick={() => submit("steer")}>
                Steer
              </Action>
              <IconAction label="Stop the agent" variant="secondary" icon={<StopIcon size={16} weight="fill" />} onClick={session.abort} />
            </div>
          ) : (
            <IconAction
              label="Send message"
              type="submit"
              variant="primary"
              disabled={!connected || prompt.trim() === ""}
              icon={<PaperPlaneRightIcon size={16} />}
            />
          )}
        </div>
        <p id={hintId} className="mt-1.5 text-[13px] text-kumo-subtle max-sm:sr-only">
          {connected
            ? session.running
              ? "Enter queues a follow-up · Steer adds it to the current answer"
              : "Enter to send · Shift+Enter for a new line"
            : "You can send once your agent is connected."}
        </p>
      </form>
    </div>
  );
}

/**
 * Chat, the home place: what needs the User pinned on top, the conversation,
 * receipts for what was resolved, and the composer. A Direct Conversation
 * opens beside it on wide screens and over it on phones.
 */
export function ChatPage({
  session,
  hidden,
  setHidden
}: {
  session: PiSession;
  /** Direct Conversations the User put away for now. */
  hidden: ReadonlySet<string>;
  setHidden: (next: ReadonlySet<string>) => void;
}) {
  const { poppy, sendPoppy, messages, live, running, tools, error } = session;
  const runningTools = tools.map((tool) => tool.name);
  const scroller = useStickToBottom(messages, live, running, poppy.cards);
  const empty = messages.length === 0 && !live && !running;
  const direct = openDirect(poppy);
  const shown = direct.filter((update) => !hidden.has(update.conversationId));
  const put = direct.filter((update) => hidden.has(update.conversationId));
  const sheetView = { ...poppy, direct: Object.fromEntries(shown.map((update) => [update.conversationId, update])) };

  return (
    <div className={cn("grid h-full min-h-0", shown.length ? "lg:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)]" : "grid-cols-1")}>
      <section aria-labelledby="chat-title" className="flex min-h-0 min-w-0 flex-col">
        <h1 id="chat-title" tabIndex={-1} className="sr-only">
          Chat with your agent
        </h1>
        <NeedsYouTray
          view={poppy}
          send={sendPoppy}
          extra={
            put.length ? (
              <>
                {put.map((update) => (
                  <HiddenDirectRow
                    key={update.conversationId}
                    update={update}
                    onOpen={() => setHidden(new Set([...hidden].filter((id) => id !== update.conversationId)))}
                  />
                ))}
              </>
            ) : undefined
          }
        />
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
            {empty ? <Welcome /> : null}
            <Transcript messages={messages} live={live} runningTools={runningTools} onRetry={(text) => session.submit(text)} />
            <Working session={session} />
            <Receipts view={poppy} send={sendPoppy} />
            {error ? (
              <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-kumo-danger-tint px-4 py-3">
                <p className="min-w-0 flex-1 text-base text-pretty text-kumo-danger">Your agent reported a problem: {error}</p>
                <Action variant="secondary" onClick={() => window.location.reload()}>
                  Reload the page
                </Action>
              </div>
            ) : null}
          </div>
        </div>
        <Composer session={session} />
      </section>
      {shown.length ? (
        <DirectConversations
          view={sheetView}
          send={sendPoppy}
          onHide={() => setHidden(new Set([...hidden, ...shown.map((update) => update.conversationId)]))}
        />
      ) : null}
    </div>
  );
}
