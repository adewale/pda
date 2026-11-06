/** Card routing, receipts and request classification. */
import { type ActivityResult, type Card } from "../poppy/wire";
import { type ReactNode, useContext, useRef, useEffect } from "react";
import { RequestPanelContext, httpsHref, CompanySays } from "./poppy-card-frame";
import { cn } from "@cloudflare/kumo";
import { STATUS_STYLE } from "./status";
import { RESULT } from "./format";
import { type Send, useSend } from "./connection";
import { IconAction, Action } from "./controls";
import { XIcon, InfoIcon } from "@phosphor-icons/react";
import { isTaskRequest, approvalResult } from "../poppy/approval-outcome";
import { resultFacts, redactQueries } from "./result-facts";
import { money, ApprovalCard } from "./poppy-approval";
import { SignInLinkCard, DeviceCard, CredentialsCard, CodeCard, DirectInvite } from "./poppy-signin";
import { type PoppyView } from "../use-pi-session";

/** A one-line record of something resolved: its state's mark and word, what happened, and where. */
function Receipt({ result, detail, company, children, action, note }: { result: ActivityResult; detail?: string | null; company: string; children: ReactNode; action?: ReactNode; note?: ReactNode }) {
  const inPanel = useContext(RequestPanelContext);
  return (
    <div className={cn("flex min-h-10 items-start gap-2", inPanel ? "px-4 py-3" : "enter py-1")} data-receipt={result}>
      <span aria-hidden className={cn("mt-0.5 shrink-0", STATUS_STYLE[result].className)}>
        {STATUS_STYLE[result].icon}
      </span>
      <div className="min-w-0 flex-1 text-[13px] text-pretty break-words text-kumo-default">
        <p>
          <span className={cn("font-medium", STATUS_STYLE[result].className)}>
            {RESULT[result]}
            {detail ? <span className="tabular-nums"> · {detail}</span> : null}
          </span>
          {company ? <span className="text-kumo-subtle"> · {company}</span> : null}
        </p>
        {children}
        {note}
      </div>
      {action}
    </div>
  );
}

/** Browser-observed string equality only; no signed URL reaches the telemetry frame. */
function NoticeLinks({ card, send, enabled }: { card: Extract<Card, { kind: "notice" }>; send: Send; enabled: boolean }) {
  const anchors = useRef(new Map<number, HTMLAnchorElement>());
  const reported = useRef<string | null>(null);
  const result = card.id.startsWith("result-");
  useEffect(() => {
    if (!result || !enabled) return;
    const checks = (card.links ?? []).flatMap((link, index) => {
      const anchor = anchors.current.get(index);
      return anchor ? [{ index, attribute_equal: anchor.getAttribute("href") === link.url, resolved_equal: anchor.href === link.url }] : [];
    });
    const signature = JSON.stringify({ cardId: card.id, checks });
    if (!checks.length || reported.current === signature) return;
    if (send({ type: "poppy.result_links.checked", cardId: card.id, checks })) reported.current = signature;
  }, [card.id, card.links, result, enabled, send]);
  return <ul className="mt-1 space-y-1">{card.links?.map((link, index) => {
    const parsed = httpsHref(link.url);
    if (!parsed) return null;
    const divider = link.label.lastIndexOf(" · ");
    const caption = result && divider >= 0 ? link.label.slice(0, divider) : link.label;
    return <li key={index}><a ref={anchor => { if (anchor) anchors.current.set(index, anchor); else anchors.current.delete(index); }} href={link.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
      {result ? <><bdi>{caption}</bdi>{" · "}<bdi dir="ltr">{new URL(parsed).hostname}</bdi></> : link.label}
    </a></li>;
  })}</ul>;
}

/** A request's outcome when no step in the chat shows it. */
function ClosedCard({ card, send: sendFrame, onAsk }: { card: Card; send: Send; onAsk?: ((text: string) => void) | undefined }) {
  // A receipt's buttons are disabled while the page isn't connected; the banner at the top says why, so each line doesn't.
  const { send, disabled, note } = useSend(sendFrame, { quiet: true });
  const inPanel = useContext(RequestPanelContext);
  const dismiss = (
    <IconAction label="Dismiss" variant="ghost" icon={<XIcon size={16} />} disabled={disabled} onClick={() => send({ type: "poppy.card.dismiss", id: card.id })} className="-my-2" />
  );
  switch (card.kind) {
    case "notice": {
      const error = card.id.startsWith("error-");
      return error ? (
        <Receipt result="failed" company={card.company} action={dismiss} note={note}>
          <p>{card.text}</p>
        </Receipt>
      ) : (
        <div className={cn("flex min-h-10 items-start gap-2 text-[13px] text-kumo-subtle", inPanel ? "px-4 py-3" : "enter py-1")}>
          <InfoIcon size={16} aria-hidden className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 text-pretty break-words">
            <p>{card.company ? <span className="font-medium">{card.company} · </span> : null}{card.text}{note}</p>
            {card.links?.length ? <NoticeLinks card={card} send={send} enabled={!disabled} /> : null}
          </div>
          {dismiss}
        </div>
      );
    }
    case "approval": {
      const resolution = card.outcomeResolution;
      const task = isTaskRequest(card.approvalId) || card.taskRequested === true;
      const result = approvalResult(card.status, resolution);
      // A checked outcome is attributed to the User; the original Company response stays separate.
      const detail = resolution ? "you checked with the Company" : card.answer
        ? `${card.answer.status}${card.answer.error ? ` ${card.answer.error}` : ""}`
        : card.status === "done"
          ? task ? "for your task" : "as you approved"
          : card.status === "terms"
            ? "sent; its terms wait on the next card"
          : card.status === "failed"
            ? task ? "during your task" : "after you approved"
            : null;
      const answered = card.answer ? `${card.answer.status}${card.answer.error ? ` (${card.answer.error})` : ""}` : "with an error";
      // What the Company answered, as a few facts; never its raw body, and never a URL (src/ui/result-facts.ts).
      const facts = card.status === "done" ? resultFacts(card.result).facts : [];
      return (
        <Receipt result={result} detail={detail} company={card.company} action={card.status === "unknown" && !resolution ? null : dismiss} note={note}>
          {card.terms ? (
            <CompanySays company={card.company} className="mt-1 border-l-2 border-kumo-line pl-3 [&_blockquote]:text-[13px]">
              {card.terms.total ? `${money(card.terms.total)} · ${card.terms.summary}` : card.terms.summary}
            </CompanySays>
          ) : (
            <p className="text-kumo-subtle">{card.summary}</p>
          )}
          {facts.length ? <p className="text-kumo-subtle tabular-nums">{facts.join(" · ")}</p> : null}
          {card.status === "refused" ? (
            <p>
              {task ? "Sent for your task" : "Sent as you approved"}, but {card.company} answered {answered}. Nothing changed unless {card.company} says otherwise.
            </p>
          ) : null}
          {card.status !== "done" && card.status !== "refused" && card.result ? <p>{redactQueries(card.result)}</p> : null}
          {resolution ? <p className="mt-1">You reported that this action {resolution.outcome === "performed" ? "happened" : "did not happen"}. Recording this did not send another request.</p> : card.status === "unknown" ? (
            <div className="mt-2 space-y-2">
              <p>Check the outcome with {card.company} before asking for this action again. Record only what you have confirmed.</p>
              <div className="flex flex-wrap gap-2">
                <Action variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: "performed" })}>I checked: it happened</Action>
                <Action variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: "not_performed" })}>I checked: it did not happen</Action>
              </div>
            </div>
          ) : null}
        </Receipt>
      );
    }
    default:
      // Sign-in and invitation cards become notices when they close.
      return null;
  }
}

/** One card: a request while it waits for the User, a one-line receipt once resolved. `onAsk` lets a receipt ask the agent something for the User. */
export function PoppyCard({ card, send, onAsk }: { card: Card; send: Send; onAsk?: (text: string) => void }) {
  if (!card.open) return <ClosedCard card={card} send={send} onAsk={onAsk} />;
  switch (card.kind) {
    case "signin_link":
      return <SignInLinkCard card={card} send={send} />;
    case "signin_device":
      return <DeviceCard card={card} send={send} />;
    case "signin_credentials":
      return <CredentialsCard card={card} send={send} />;
    case "signin_code":
      return <CodeCard card={card} send={send} />;
    case "approval":
      return <ApprovalCard card={card} send={send} />;
    case "direct_invite":
      return <DirectInvite card={card} send={send} />;
    case "notice":
      return <ClosedCard card={card} send={send} />;
  }
}

/**
 * What needs the User: every open card, plus failures they should see before
 * anything else (a request that didn't work, an approved action whose outcome
 * is unknown).
 */
export function needsYou(cards: readonly Card[]): Card[] {
  return cards.filter(
    (card) =>
      card.open ||
      (card.kind === "notice" && card.id.startsWith("error-")) ||
      (card.kind === "approval" && card.status === "unknown" && !card.outcomeResolution)
  );
}

/** Resolved cards: outcomes the chat places by time (`ChatPage`). */
export function receipts(cards: readonly Card[]): Card[] {
  const pinned = new Set(needsYou(cards));
  return cards.filter((card) => !pinned.has(card));
}

/** Every card, requests first: used where there is no tray. */
export function PoppyCards({ view, send }: { view: PoppyView; send: Send }) {
  if (view.cards.length === 0) return null;
  const open = needsYou(view.cards);
  const closed = receipts(view.cards);
  return (
    <div className="space-y-3" aria-label="Company requests">
      {open.map((card) => (
        <PoppyCard key={card.id} card={card} send={send} />
      ))}
      {closed.length ? (
        <div>
          {closed.map((card) => (
            <PoppyCard key={card.id} card={card} send={send} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
