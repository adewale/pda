/** Chat timeline, pending messages, working state and Direct Conversation layout. */
import { type ReactNode, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { MagnifyingGlassIcon, SignInIcon, HandIcon, ClockIcon } from "@phosphor-icons/react";
import { type PiSession } from "../use-pi-session";
import { useNow, Action } from "./controls";
import { countdown } from "./format";
import { Loader, cn } from "@cloudflare/kumo";
import { UserMessage, type TimelineEvent, Transcript } from "./transcript";
import { approvalsOnSteps, stepDecisions } from "./steps";
import { APPROVAL_READ_LIMIT } from "../poppy/approval-outcome";
import { receipts, PoppyCard, openDirect, NeedsYouPanel, HiddenDirectRow, DirectConversations } from "../poppy-ui";
import { BrowserViews } from "./poppy-browser";
import { AllowCompanyContext } from "./poppy-company";
import { Composer, type ComposerHandle } from "./composer";

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
      <p className="mt-2 text-base text-pretty text-kumo-subtle">Add a domain under “Companies your agent can contact”, then ask for what you need, such as “Exchange my jumper for a size L”. It remembers this conversation.</p>
      <ul className="mt-6 space-y-4">
        <Capability icon={<MagnifyingGlassIcon size={20} />} title="It checks what your chosen company offers:">
          an API, its own agent to talk to, or its website.
        </Capability>
        <Capability icon={<SignInIcon size={20} />} title="You sign in on the company's own page.">
          Your agent never sees your password.
        </Capability>
        <Capability icon={<HandIcon size={20} />} title="It makes requests for your task.">
          When the company requires approval, you review its exact terms before the agent proceeds.
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

/**
 * What the User sent that the agent hasn't taken yet: shown under the
 * conversation, each with why it is still here, until the agent answers.
 */
function Pending({ session }: { session: PiSession }) {
  const { outbox, status } = session;
  if (outbox.length === 0) return null;
  return (
    <div className="space-y-5">
      {outbox.map((item) => (
        <div key={item.id} className="flex flex-col items-end gap-1.5">
          <div className={cn(item.state === "failed" ? undefined : "opacity-70")}>
            <UserMessage message={{ id: item.id, role: "user", parts: [{ type: "text", text: item.text }], timestamp: 0 }} />
          </div>
          {item.state === "failed" ? (
            <div role="alert" className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              <p className="text-[13px] text-pretty text-kumo-danger">Your agent didn't take this message: {item.error}</p>
              <Action variant="secondary" disabled={status === "unauthenticated"} onClick={() => session.resend(item.id)}>
                Try again
              </Action>
              <Action variant="ghost" onClick={() => session.discard(item.id)}>
                Remove
              </Action>
            </div>
          ) : (
            <p role="status" className="text-[13px] text-kumo-subtle">
              {status === "unauthenticated" ? "Sign in again before sending. This message is kept in this tab." : status === "open" ? "Sending" : "Waiting to connect. It goes once your agent is connected."}
            </p>
          )}
        </div>
      ))}
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

/**
 * Chat, the home place: the conversation, with each request's outcome on the
 * step that asked for it and other outcomes placed by time; what needs the
 * User docked above the composer; and the composer. Nothing is pinned under
 * the agent's newest message. A Direct Conversation opens beside it on wide
 * screens and over it on phones.
 */
export function ChatPage({
  session,
  hidden,
  setHidden,
  onProtocol
}: {
  session: PiSession;
  /** Direct Conversations the User put away for now. */
  hidden: ReadonlySet<string>;
  setHidden: (next: ReadonlySet<string>) => void;
  /** Open a Company's protocol log in Activity, by its domain. */
  onProtocol?: (domain: string) => void;
}) {
  const { poppy, sendPoppy, messages, live, running, tools, error } = session;
  const composer = useRef<ComposerHandle>(null);
  const reviewMessage = (text: string) => composer.current?.edit(text);
  const allowCompany = useCallback((domain: string, photos: readonly string[]) => composer.current?.allowCompany(domain, photos) ?? false, []);
  const onSteps = useMemo(() => approvalsOnSteps(live ? [...messages, live] : messages), [messages, live]);
  const approvalKey = [...onSteps].sort().join(",");
  useEffect(() => {
    if (session.status !== "open" || !approvalKey) return;
    const ids = approvalKey.split(",");
    for (let index = 0; index < ids.length; index += APPROVAL_READ_LIMIT) sendPoppy({ type: "poppy.approvals.read", ids: ids.slice(index, index + APPROVAL_READ_LIMIT) });
    // Changes to cards/Activity refresh decisions, but the lookup's own reply
    // changes neither dependency and cannot start a request loop.
  }, [approvalKey, poppy.cards, poppy.activity, session.status, sendPoppy]);
  const decisions = useMemo(() => stepDecisions(poppy.cards, poppy.activity?.log ?? [], poppy.decisions), [poppy.cards, poppy.activity, poppy.decisions]);
  const events: TimelineEvent[] = receipts(poppy.cards)
    .filter((card) => !(card.kind === "approval" && onSteps.has(card.approvalId)))
    .map((card) => ({ key: card.id, at: card.at ?? Number.POSITIVE_INFINITY, node: <PoppyCard card={card} send={sendPoppy} onAsk={reviewMessage} /> }));
  const runningTools = tools.map((tool) => tool.name);
  const scroller = useStickToBottom(messages, live, running, poppy.cards, session.outbox);
  const empty = messages.length === 0 && !live && !running && session.outbox.length === 0;
  const direct = openDirect(poppy);
  const shown = direct.filter((update) => !hidden.has(update.conversationId));
  const put = direct.filter((update) => hidden.has(update.conversationId));
  const sheetView = { ...poppy, direct: Object.fromEntries(shown.map((update) => [update.conversationId, update])) };

  return (
    <BrowserViews.Provider value={poppy.browserViews ?? {}}>
    <div className={cn("grid h-full min-h-0", shown.length ? "lg:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)]" : "grid-cols-1")}>
      <section aria-labelledby="chat-title" className="flex min-h-0 min-w-0 flex-col">
        <h1 id="chat-title" tabIndex={-1} className="sr-only">
          Chat with your agent
        </h1>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
            {empty ? <Welcome /> : null}
            <Transcript
              messages={messages}
              live={live}
              runningTools={runningTools}
              onRetry={reviewMessage}
              summaries={session.summaries}
              decisions={decisions}
              events={events}
              {...(onProtocol ? { onProtocol } : {})}
            />
            <Pending session={session} />
            <Working session={session} />
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
        <AllowCompanyContext.Provider value={allowCompany}>
        <NeedsYouPanel
          view={poppy}
          send={sendPoppy}
          extraIds={put.map((update) => update.conversationId)}
          extra={put.map((update) => (
            <HiddenDirectRow
              key={update.conversationId}
              update={update}
              onOpen={() => setHidden(new Set([...hidden].filter((id) => id !== update.conversationId)))}
            />
          ))}
        />
        </AllowCompanyContext.Provider>
        <Composer ref={composer} session={session} />
      </section>
      {shown.length ? (
        <DirectConversations
          view={sheetView}
          send={sendPoppy}
          onHide={() => setHidden(new Set([...hidden, ...shown.map((update) => update.conversationId)]))}
        />
      ) : null}
    </div>
    </BrowserViews.Provider>
  );
}
