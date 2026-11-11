/** A step a Company's website leaves to the User, and the browser handed to them for it (0.4 Browser Control 5). */
import { createContext, useContext } from "react";
import { type Card } from "../poppy/wire";
import { type Send, useSend } from "./connection";
import { CardFrame, httpsHref } from "./poppy-card-frame";
import { Action, ActionLink, useNow } from "./controls";
import { BrowserIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";

export type BrowserView = { readonly url: string; readonly expiresAt: number };

/**
 * Live view links, by handover, as this page received them. Never stored:
 * whoever holds one controls the browser until it expires.
 */
export const BrowserViews = createContext<Readonly<Record<string, BrowserView>>>({});

type BrowserCard = Extract<Card, { kind: "browser_control" }>;

/** A page of the Company's, shown as its host and path: what the website says about it is the Company's. */
function where(url: string): string {
  const href = httpsHref(url);
  if (!href) return url;
  const parsed = new URL(href);
  return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}

export function BrowserControlCard({ card, send: sendFrame }: { card: BrowserCard; send: Send }) {
  const { send, disabled, note } = useSend(sendFrame);
  const view = useContext(BrowserViews)[card.handoverId];
  const now = useNow(1000);
  if (card.state === "offered") {
    return (
      <CardFrame
        domain={card.domain}
        icon={<BrowserIcon size={16} />}
        title={`Take a step on ${card.company}'s website yourself?`}
        meta="You use your agent's browser, in its Session there. Your agent doesn't use the browser until you hand it back."
        note={note}
        actions={
          <>
            <Action type="button" variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.browser.cancel", handoverId: card.handoverId })}>
              Not now
            </Action>
            <Action type="button" variant="primary" disabled={disabled} onClick={() => send({ type: "poppy.browser.take", handoverId: card.handoverId })}>
              Take control
            </Action>
          </>
        }
      >
        <p className="text-base text-pretty">
          {card.company}'s website leaves this step to you: {card.step}, on <bdi dir="ltr">{where(card.url)}</bdi>.
        </p>
      </CardFrame>
    );
  }
  const href = view && view.expiresAt > now ? httpsHref(view.url) : null;
  return (
    <CardFrame
      domain={card.domain}
      icon={<BrowserIcon size={16} />}
      title={`You have control of the browser at ${card.company}`}
      meta="Take the step, then hand the browser back. Only you can end your control."
      note={note}
      actions={
        <>
          <Action type="button" variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.browser.cancel", handoverId: card.handoverId })}>
            Cancel
          </Action>
          <Action type="button" variant="primary" disabled={disabled} onClick={() => send({ type: "poppy.browser.return", handoverId: card.handoverId })}>
            Hand back
          </Action>
        </>
      }
    >
      <p className="text-base text-pretty">The step: {card.step}.</p>
      {card.note ? <p className="text-[13px] text-kumo-subtle">{card.note}</p> : null}
      {href ? (
        <ActionLink href={href} target="_blank" rel="noopener noreferrer" variant="secondary" className="mt-2">
          Open the browser <ArrowSquareOutIcon size={16} aria-hidden />
        </ActionLink>
      ) : (
        <Action type="button" variant="secondary" className="mt-2" disabled={disabled} onClick={() => send({ type: "poppy.browser.view", handoverId: card.handoverId })}>
          {view ? "Get a new link to the browser" : "Open the browser"}
        </Action>
      )}
    </CardFrame>
  );
}

/** How a handover ended, as a receipt's words. */
export function browserOutcome(card: BrowserCard): string {
  switch (card.state) {
    case "returned":
      return `You handed the browser back after the step: ${card.step}.`;
    case "cancelled":
      return `You cancelled your control of the browser for the step: ${card.step}.`;
    case "declined":
      return `You left this step for later: ${card.step}.`;
    default:
      return card.note ?? `The browser for this step closed: ${card.step}.`;
  }
}
