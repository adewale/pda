/** Exact Company terms, approval decisions and batched approval cards. */
import { type ApprovalTerms, type Card, type ActivityResult } from "../poppy/wire";
import { CompanySays, httpsHref, CardFrame } from "./poppy-card-frame";
import { ArrowSquareOutIcon, HandIcon } from "@phosphor-icons/react";
import { type Send, useSend } from "./connection";
import { Action } from "./controls";
import { AttachmentThumb } from "./attachments";
import { humanSize } from "../attachments";
import { useState } from "react";
import { approvalResult } from "../poppy/approval-outcome";
import { cn } from "@cloudflare/kumo";
import { Status } from "./status";

/** An amount as money where it reads as one ("14.50" USD → "$14.50"), else as the Company wrote it. */
export function money(total: { amount: string; currency: string }): string {
  if (/^\d+(\.\d+)?$/.test(total.amount) && /^[A-Z]{3}$/.test(total.currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: total.currency }).format(Number(total.amount));
    } catch {
      // An unknown currency code: as written.
    }
  }
  return `${total.amount} ${total.currency}`;
}

/** "Cost (total): 15.00 USD" → ["Cost (total)", "15.00 USD"], so the terms line up as a two-column list. */
function termRow(line: string): [string, string] | [string] {
  const split = line.indexOf(": ");
  return split > 0 ? [line.slice(0, split), line.slice(split + 2)] : [line];
}

/**
 * What an approval card shows of an operation a Company returned (Ops 5):
 * the total from its terms in large figures, the Company's own summary
 * quoted as theirs and shown as text (Ops 3: never a link, image or HTML),
 * where the terms disagree with the summary or the request, then every
 * cost, date and condition the terms name, lined up, and links to any
 * previews on the Company's own hosts.
 */
function OperationTerms({ terms, company }: { terms: ApprovalTerms; company: string }) {
  const total = terms.total ? money(terms.total) : null;
  return (
    <>
      {total ? (
        <p className="flex items-baseline gap-2" data-total>
          <span className="text-[13px] text-kumo-subtle">Total</span>
          <span className="text-2xl font-semibold text-kumo-strong tabular-nums">{total}</span>
        </p>
      ) : null}
      <CompanySays company={company} className="border-l-2 border-kumo-line pl-3">
        {terms.summary}
      </CompanySays>
      {terms.differences?.length ? (
        <div className="rounded-lg bg-kumo-warning-tint p-3 text-[13px] text-kumo-default" data-terms-differences>
          <p className="font-medium">Check before you approve: {company}'s terms and summary don't agree</p>
          <ul className="mt-1 list-disc pl-5">
            {terms.differences.map((difference) => (
              <li key={difference}>{difference}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 text-[13px] text-kumo-subtle tabular-nums">
        {[...terms.highlights, `Approve before: ${new Date(terms.expiresAt).toLocaleString()}`].map((line) => {
          const [label, value] = termRow(line);
          return value === undefined ? (
            <dd key={line} className="col-span-2">
              {label}
            </dd>
          ) : (
            <div key={line} className="contents">
              <dt className="min-w-0 break-words">{label}</dt>
              <dd className="text-right text-kumo-default">{value}</dd>
            </div>
          );
        })}
      </dl>
      {terms.previews?.length ? (
        <div className="text-[13px]">
          <p className="text-kumo-subtle">Previews at {company}, each in a new tab:</p>
          <ul className="flex flex-wrap gap-x-3">
            {terms.previews.flatMap((preview) => {
              const href = httpsHref(preview.url);
              return href
                ? [
                    <li key={href}>
                      <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1 font-medium text-kumo-link underline">
                        {preview.label}
                        <ArrowSquareOutIcon size={14} aria-hidden />
                      </a>
                    </li>
                  ]
                : [];
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function ApprovalCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "approval" }>; send: Send }) {
  const photos = card.attachments ?? [];
  const { send, disabled, note } = useSend(sendFrame);
  return (
    <CardFrame
      domain={card.domain}
      icon={<HandIcon size={16} />}
      note={note}
      title={photos.length ? `Send ${photos.length === 1 ? "this photo" : "these photos"} to ${card.company}?` : `Approve this at ${card.company}?`}
      meta={
        photos.length === 1
          ? "Your photo leaves your agent only if you approve, and goes only to this Company"
          : photos.length
            ? "Your photos leave your agent only if you approve, and go only to this Company"
            : "View and change · Nothing happens unless you approve"
      }
      actions={
        <>
          <Action variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.approval", approvalId: card.approvalId, decision: "decline" })}>
            Decline
          </Action>
          <Action variant="primary" disabled={disabled} onClick={() => send({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" })}>
            {card.terms?.total ? `Approve ${money(card.terms.total)}` : "Approve"}
          </Action>
        </>
      }
    >
      {photos.length ? (
        <div className="flex flex-wrap gap-2">
          {photos.map((photo) => (
            <AttachmentThumb key={photo.id} id={photo.id} name={photo.name} detail={humanSize(photo.size)} size="card" />
          ))}
        </div>
      ) : null}
      {card.terms ? <OperationTerms terms={card.terms} company={card.company} /> : <p className="text-base text-pretty break-words">{card.summary}</p>}
    </CardFrame>
  );
}

export type ApprovalCardOf = Extract<Card, { kind: "approval" }>;

/** One photo in a batch: ticked to send, with its size, its pixels once it has loaded, and how it stands once sent. */
function BatchTile({ card, ticked, onToggle, decided }: { card: ApprovalCardOf; ticked: boolean; onToggle: () => void; decided: boolean }) {
  const [pixels, setPixels] = useState<string | null>(null);
  const photo = card.attachments?.[0];
  // Waiting until the User decides; then each tile follows its own card, so the User sees which went and which didn't.
  const status: ActivityResult | null = !decided ? null : card.status === "pending" ? (ticked ? "in_progress" : "declined") : approvalResult(card.status, card.outcomeResolution);
  const detail = card.answer ? `${card.answer.status}${card.answer.error ? ` ${card.answer.error}` : ""}` : null;
  const name = photo?.name ?? card.summary;
  return (
    <li className={cn("flex min-w-0 flex-col gap-1 rounded-lg p-1.5 ring", ticked ? "ring-kumo-line" : "opacity-60 ring-kumo-hairline")} data-tile={status ?? (ticked ? "ticked" : "unticked")}>
      <label className={cn("flex min-w-0 flex-col gap-1", decided ? "cursor-default" : "cursor-pointer")}>
        {photo ? (
          <img
            src={`/api/attachments/${encodeURIComponent(photo.id)}`}
            alt={photo.name}
            loading="lazy"
            onLoad={(event) => setPixels(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)}
            className="image-outline aspect-[4/3] w-full rounded-md object-cover"
          />
        ) : null}
        <span className="flex min-w-0 items-start gap-1.5 text-[13px]">
          <input type="checkbox" checked={ticked} disabled={decided} onChange={onToggle} className="mt-0.5 size-4 shrink-0 accent-kumo-brand" />
          <span className="min-w-0">
            <span className="block truncate font-medium text-kumo-default">{name}</span>
            <span className="block text-kumo-subtle tabular-nums">{[photo ? humanSize(photo.size) : null, pixels].filter(Boolean).join(" · ")}</span>
          </span>
        </span>
      </label>
      {status ? <Status result={status} detail={detail} className="text-[13px] font-medium" /> : null}
    </li>
  );
}

/**
 * Uploads of the User's photos to one Company's same address, decided on one
 * card: every photo shown, each ticked to start, and a button that counts
 * what it sends. Unticked photos are declined, so the model hears the User
 * didn't want them. The agent checks the batch again before sending anything
 * (operations.ts `decideLocalBatch`), sends them one at a time, and each tile
 * shows how its photo went. Anything else that waits keeps its own card.
 */
export function BatchApprovalCard({ cards, decided, send: sendFrame, onDecided }: { cards: readonly ApprovalCardOf[]; decided: boolean; send: Send; onDecided: () => void }) {
  const { send, disabled, note } = useSend(sendFrame);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  const first = cards[0]!;
  const ticked = cards.filter((card) => !unticked.has(card.approvalId)).length;
  const decide = (approve: boolean) => {
    const decisions = cards.map((card) => ({ approvalId: card.approvalId, decision: approve && !unticked.has(card.approvalId) ? ("approve" as const) : ("decline" as const) }));
    if (send({ type: "poppy.approvals", decisions })) onDecided();
  };
  const toggle = (id: string) => setUnticked((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const done = cards.filter((card) => card.status !== "pending" && card.status !== "approved").length;
  return (
    <CardFrame
      domain={first.domain}
      icon={<HandIcon size={16} />}
      note={note}
      title={decided ? `Sending your photos to ${first.company}` : `Send ${cards.length} photos to ${first.company}?`}
      meta={decided ? `${done} of ${cards.length} finished` : "Your photos leave your agent only if you approve, and go only to this Company. Untick any you don't want sent."}
      actions={
        decided ? undefined : (
          <>
            <Action variant="secondary" disabled={disabled} onClick={() => decide(false)}>
              Decline all
            </Action>
            <Action variant="primary" disabled={disabled || ticked === 0} onClick={() => decide(true)}>
              {ticked === cards.length ? `Send ${ticked} photos` : `Send ${ticked} of ${cards.length} photos`}
            </Action>
          </>
        )
      }
    >
      <ul aria-label={`Photos to send to ${first.company}`} className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        {cards.map((card) => (
          <BatchTile key={card.approvalId} card={card} ticked={!unticked.has(card.approvalId)} decided={decided} onToggle={() => toggle(card.approvalId)} />
        ))}
      </ul>
      <p className="text-[13px] text-pretty break-words text-kumo-subtle">Each goes to {first.summary.replace(/^Send your photo “[^”]*” \([^)]*\) to /, "")}</p>
    </CardFrame>
  );
}
