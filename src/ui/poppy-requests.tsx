/** The request tray above the chat composer. */
import { type Card } from "../poppy/wire";
import { type PoppyView } from "../use-pi-session";
import { type Send } from "./connection";
import { type ReactNode, useState, useEffect, useId, useRef, useLayoutEffect } from "react";
import { type ApprovalCardOf, BatchApprovalCard } from "./poppy-approval";
import { approvalBatches } from "./steps";
import { needsYou, PoppyCard } from "./poppy-cards";
import { Action, IconAction } from "./controls";
import { HandIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import { RequestPanelContext } from "./poppy-card-frame";

function requestLabel(card: Card | undefined): string {
  if (!card) return "Conversation";
  switch (card.kind) {
    case "signin_link":
    case "signin_device":
    case "signin_credentials":
    case "signin_code":
      return "Sign-in request";
    case "approval":
      return card.status === "unknown" ? "Check the outcome" : "Approval request";
    case "direct_invite":
      return "Conversation request";
    case "browser_control":
      return "A step for you";
    case "notice":
      return card.id.startsWith("reminder-") ? "Reminder" : card.id.startsWith("error-") ? "Request failed" : "Notice";
  }
}

/** Requests dock above the composer. Opening never takes focus from the conversation. */
export function NeedsYouPanel({ view, send, extra, extraIds = [] }: { view: PoppyView; send: Send; extra?: ReactNode; extraIds?: readonly string[] }) {
  // A batch the User decided stays in view, each photo with its progress, until every one has finished.
  const [decided, setDecided] = useState<readonly { key: string; ids: readonly string[] }[]>([]);
  const byId = new Map(view.cards.map((card) => [card.id, card]));
  const sending = decided
    .map((batch) => ({ key: batch.key, cards: batch.ids.map((id) => byId.get(id)).filter((card): card is ApprovalCardOf => card?.kind === "approval") }))
    .filter((batch) => batch.cards.some((card) => card.status === "pending" || card.status === "approved"));
  useEffect(() => {
    if (sending.length !== decided.length) setDecided(decided.filter((batch) => sending.some((item) => item.key === batch.key)));
  });
  const inBatch = new Set(sending.flatMap((batch) => batch.cards.map((card) => card.id)));
  const entries = [
    ...sending.map((batch) => ({ kind: "batch" as const, key: batch.key, cards: batch.cards, decided: true })),
    ...approvalBatches(needsYou(view.cards).filter((card) => !inBatch.has(card.id))).map((entry) => (entry.kind === "batch" ? { ...entry, decided: false } : entry))
  ];
  const items = entries.map((entry) => (entry.kind === "card" ? entry.card : entry.cards[0]!));
  const count = entries.length + extraIds.length;
  // Ignore refreshed frames and removals. A new card (a new revision of an
  // operation is a new card), sign-in step or photo joining a batch must draw attention again, even when the total count stays the same.
  const keys = [
    ...entries.map((entry) =>
      entry.kind === "card"
        ? JSON.stringify([entry.card.id, entry.card.kind])
        : JSON.stringify(["batch", entry.key, entry.cards.map((card) => card.id)])
    ),
    ...extraIds.map((id) => JSON.stringify(["direct", id]))
  ];
  const [visibility, setVisibility] = useState({ keys, open: count > 0 });
  if (keys.length !== visibility.keys.length || keys.some((key, index) => key !== visibility.keys[index])) {
    setVisibility({ keys, open: count > 0 && (visibility.open || keys.some((key) => !visibility.keys.includes(key))) });
  }
  const panelId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusInside = useRef(false);
  const focusOnOpen = useRef(false);
  const expanded = visibility.open && count > 0;
  const requestVersion = JSON.stringify(keys);
  const firstEntry = entries[0];
  const label = count === 1 ? (firstEntry?.kind === "batch" ? `Send ${firstEntry.cards.length} photos` : requestLabel(items[0])) : `${count} requests`;
  const collapse = () => setVisibility({ keys, open: false });
  useLayoutEffect(() => {
    if (expanded && (focusOnOpen.current || (focusInside.current && !panel.current?.contains(document.activeElement)))) {
      focusOnOpen.current = false;
      title.current?.focus({ preventScroll: true });
    } else if (!expanded && focusInside.current) {
      focusInside.current = false;
      const target = trigger.current ?? document.querySelector<HTMLElement>('[aria-label="Message your agent"]') ?? document.getElementById("chat-title");
      target?.focus({ preventScroll: true });
    }
  }, [expanded, count, requestVersion]);
  return (
    <>
      <p aria-live="polite" className="sr-only" aria-atomic="true">
        {count > 0 ? `${count === 1 ? "1 request needs" : `${count} requests need`} you. ${label}${items[0]?.company ? ` from ${items[0].company}` : ""}.` : ""}
      </p>
      <div hidden={count === 0} className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3 sm:px-6">
        {!expanded && count > 0 ? (
          <Action
            ref={trigger}
            variant="secondary"
            aria-expanded={false}
            aria-controls={panelId}
            onFocus={() => { focusOnOpen.current = true; }}
            onBlur={() => { focusOnOpen.current = false; }}
            className="mx-auto flex w-full max-w-3xl justify-between gap-3 rounded-t-xl rounded-b-none bg-kumo-warning-tint"
            onClick={() => {
              focusOnOpen.current = true;
              setVisibility({ keys, open: true });
            }}
          >
            <span className="flex items-center gap-2">
              <HandIcon size={18} aria-hidden className="text-kumo-warning" />
              Needs you
              <span className="rounded-full bg-kumo-base px-2 text-[13px] font-semibold text-kumo-warning tabular-nums">{count}</span>
            </span>
            <CaretUpIcon size={16} aria-hidden />
          </Action>
        ) : null}
        <section
          ref={panel}
          id={panelId}
          hidden={!expanded}
          aria-label="Needs you"
          className="needs-you-panel mx-auto flex max-h-[min(28rem,55dvh)] w-full max-w-3xl flex-col overflow-hidden rounded-t-xl border-x border-t border-kumo-line bg-kumo-base text-kumo-default"
          onFocusCapture={() => { focusInside.current = true; }}
          onBlurCapture={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusInside.current = false;
          }}
          onKeyDownCapture={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              collapse();
            }
          }}
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-kumo-hairline py-1 pr-2 pl-4">
            <h2 ref={title} tabIndex={-1} className="text-[13px] font-medium text-kumo-subtle">{label}</h2>
            <IconAction label="Collapse requests" variant="ghost" icon={<XIcon size={16} />} onClick={collapse} />
          </header>
          <div role="group" aria-label="Request details" tabIndex={0} className="min-h-0 overflow-y-auto overscroll-contain divide-y divide-kumo-hairline">
            <RequestPanelContext value={true}>
              {extra}
              {entries.map((entry) =>
                entry.kind === "card" ? (
                  <PoppyCard key={entry.card.id} card={entry.card} send={send} />
                ) : (
                  <BatchApprovalCard
                    key={`batch-${entry.key}`}
                    cards={entry.cards}
                    decided={entry.decided}
                    send={send}
                    onDecided={() => setDecided((current) => [...current, { key: entry.key, ids: entry.cards.map((card) => card.id) }])}
                  />
                )
              )}
            </RequestPanelContext>
          </div>
        </section>
      </div>
    </>
  );
}
