import { cn, InputArea, Tabs } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  CaretUpIcon,
  DeviceMobileIcon,
  HandIcon,
  InfoIcon,
  KeyIcon,
  PaperPlaneRightIcon,
  SignInIcon,
  UserIcon,
  UsersIcon,
  XIcon
} from "@phosphor-icons/react";
import qrcode from "qrcode-generator";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { humanSize } from "./attachments";
import type { ActivityResult, ApprovalTerms, Card, DirectUpdate, ScopeInfo } from "./poppy/wire";
import { AttachmentThumb } from "./ui/attachments";
import { useSend, type Send } from "./ui/connection";
import { Action, ActionLink, IconAction, useNow } from "./ui/controls";
import { countdown, fullDate, RESULT } from "./ui/format";
import { redactQueries, resultFacts } from "./ui/result-facts";
import { Status, STATUS_STYLE } from "./ui/status";
import { APPROVAL_RESULT, approvalBatches } from "./ui/steps";
import type { PoppyView } from "./use-pi-session";

/** A Company-supplied link, only if it is an HTTPS URL: never `javascript:`, `data:` or `http:`. */
function httpsHref(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" ? url.href : null;
}

/** A QR code drawn as SVG cells, for opening a device sign-in on a phone. Black on white, so it scans in both themes. */
function QrCode({ value }: { value: string }) {
  const cells = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value);
    code.make();
    const size = code.getModuleCount();
    const dark: string[] = [];
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) if (code.isDark(row, col)) dark.push(`M${col},${row}h1v1h-1z`);
    }
    return { size, path: dark.join("") };
  }, [value]);
  return (
    <svg
      viewBox={`-2 -2 ${cells.size + 4} ${cells.size + 4}`}
      className="qr size-36 shrink-0 rounded-lg bg-white"
      role="img"
      aria-label="QR code for the sign-in link"
    >
      <path d={cells.path} fill="black" />
    </svg>
  );
}

/** What a sign-in asks for: each scope, as the Company describes it (spec 4.7: every scope has a description). */
function Access({ scopes }: { scopes: readonly ScopeInfo[] }) {
  return (
    <div className="text-[13px] text-kumo-subtle">
      <p>
        <span className="font-medium text-kumo-default">Access {scopes.length === 1 ? "it asks for" : "they ask for"}</span>
        {" · "}
        {scopes.map((scope, index) => (
          <span key={scope.scope}>
            {index > 0 ? " " : null}
            <code className="font-mono">{scope.scope}</code>
          </span>
        ))}
      </p>
      <ul className="mt-1 space-y-0.5">
        {scopes.map((scope) => (
          <li key={scope.scope} className="text-pretty">
            {scope.description}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Words a Company wrote, quoted as theirs. */
export function CompanySays({ company, children, className }: { company: string; children: ReactNode; className?: string }) {
  return (
    <figure className={className}>
      <figcaption className="text-[13px] text-kumo-subtle">{company} says:</figcaption>
      <blockquote className="mt-0.5 text-base text-pretty text-kumo-default">{children}</blockquote>
    </figure>
  );
}

const RequestPanelContext = createContext(false);

/** One request waiting for the User. Primary action last, at the right. */
function CardFrame({
  domain,
  icon,
  title,
  meta,
  children,
  actions,
  note
}: {
  /** The Company's verified domain, under its self-chosen name (N14). */
  domain: string | undefined;
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  /** Why the actions can't be used yet, or didn't go (`useSend`). */
  note?: ReactNode;
}) {
  const id = useId();
  const inPanel = useContext(RequestPanelContext);
  return (
    <article aria-labelledby={id} className={cn("p-4", inPanel ? undefined : "enter rounded-xl bg-kumo-base ring ring-kumo-hairline")}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 shrink-0 text-kumo-warning">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={id} className="text-base font-semibold text-balance text-kumo-strong">
            {title}
          </h3>
          {domain ? (
            <p className="mt-0.5 text-[13px] text-kumo-subtle">
              <code className="font-mono break-all" title="The Company's verified domain">
                {domain}
              </code>
            </p>
          ) : null}
          {meta ? <div className="mt-0.5 text-[13px] text-kumo-subtle">{meta}</div> : null}
          <div className="mt-3 space-y-3">{children}</div>
        </div>
      </div>
      {/* Sticky, so a tall card (a photo on a phone) never scrolls its buttons out of the tray; the shadow says there's more above. */}
      {actions ? (
        <div
          data-card-actions
          className={cn("sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-wrap justify-end gap-2 bg-kumo-base px-4 py-3 shadow-[0_-8px_12px_-8px_rgb(0_0_0/0.15)]", inPanel ? undefined : "rounded-b-xl")}
        >
          {note ? <div className="basis-full text-right">{note}</div> : null}
          {actions}
        </div>
      ) : null}
    </article>
  );
}

const fieldClass =
  "mt-1 block w-full rounded-lg bg-kumo-base px-3 py-2 text-base text-kumo-default ring ring-kumo-line placeholder:text-kumo-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand";

function CredentialsCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "signin_credentials" }>; send: Send }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const formId = useId();
  const { send, disabled, note } = useSend(sendFrame);
  return (
    <CardFrame
      domain={card.domain}
      icon={<KeyIcon size={16} />}
      title={`Sign in to ${card.company}`}
      meta="Your details go straight to the Company. Your agent's model never sees them, and they aren't stored."
      note={note}
      actions={
        <>
          <Action type="button" variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.signin.cancel", signInId: card.signInId })}>
            Cancel sign-in
          </Action>
          <Action type="submit" form={formId} variant="primary" disabled={disabled}>
            Sign in to {card.company}
          </Action>
        </>
      }
    >
      <p className="text-base text-pretty">{card.reason}</p>
      <Access scopes={card.scopes} />
      <form
        id={formId}
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          // What the User typed stays in the form unless it went.
          if (send({ type: "poppy.credentials", signInId: card.signInId, values })) setValues({});
        }}
      >
        {card.fields.map((field) => (
          <label key={field.name} className="block max-w-sm text-[13px] font-medium text-kumo-default">
            {field.label}
            <input
              className={fieldClass}
              type={field.secret ? "password" : "text"}
              autoComplete={field.secret ? "current-password" : "username"}
              value={Object.hasOwn(values, field.name) ? values[field.name] : ""}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              required
            />
          </label>
        ))}
      </form>
    </CardFrame>
  );
}

function CodeCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "signin_code" }>; send: Send }) {
  const [code, setCode] = useState("");
  const formId = useId();
  const { send, disabled, note } = useSend(sendFrame);
  return (
    <CardFrame
      domain={card.domain}
      icon={<KeyIcon size={16} />}
      title={`Enter the code from ${card.company}`}
      note={note}
      actions={
        <Action type="submit" form={formId} variant="primary" disabled={disabled}>
          Submit code
        </Action>
      }
    >
      <p className="text-base text-pretty">
        {card.company} sent a code to {card.sentTo}.
      </p>
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          if (send({ type: "poppy.code", signInId: card.signInId, code })) setCode("");
        }}
      >
        <label className="block max-w-xs text-[13px] font-medium text-kumo-default">
          One-time code
          <input
            className={cn(fieldClass, "font-mono tabular-nums")}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </label>
      </form>
    </CardFrame>
  );
}

function DeviceCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "signin_device" }>; send: Send }) {
  const href = httpsHref(card.verificationUriComplete) ?? httpsHref(card.verificationUri);
  const now = useNow(1000);
  const left = card.expiresAt - now;
  const { send, disabled, note } = useSend(sendFrame);
  return (
    <CardFrame
      domain={card.domain}
      icon={<DeviceMobileIcon size={16} />}
      title={`Sign in to ${card.company} on any device`}
      note={note}
      actions={
        <Action variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.signin.cancel", signInId: card.signInId })}>
          Cancel sign-in
        </Action>
      }
    >
      <p className="text-base text-pretty">{card.reason}</p>
      <Access scopes={card.scopes} />
      <div className="flex flex-wrap items-center gap-4">
        {href ? <QrCode value={href} /> : null}
        <div className="space-y-2">
          <p className="text-[13px] text-kumo-subtle">Check that {card.company}'s page shows this code:</p>
          <p className="font-mono text-2xl font-semibold tracking-wider tabular-nums">{card.userCode}</p>
          <p className="text-[13px] text-kumo-subtle tabular-nums" title={fullDate(card.expiresAt)}>
            {left > 0 ? `The code expires in ${countdown(left)}` : "The code has expired."}
          </p>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-base font-medium text-kumo-link underline underline-offset-4"
            >
              Open {card.company}'s page <ArrowSquareOutIcon size={16} aria-hidden />
            </a>
          ) : (
            <p className="text-base text-kumo-danger">This sign-in link isn't a secure web address, so it isn't shown.</p>
          )}
        </div>
      </div>
    </CardFrame>
  );
}

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

function DirectInvite({ card, send: sendFrame }: { card: Extract<Card, { kind: "direct_invite" }>; send: Send }) {
  const [text, setText] = useState("");
  const formId = useId();
  const hintId = useId();
  const empty = !text.trim();
  const { send, disabled, note } = useSend(sendFrame);
  return (
    <CardFrame
      domain={card.domain}
      icon={<UsersIcon size={16} />}
      title={`Talk to ${card.company} yourself?`}
      note={note}
      actions={
        <>
          <Action type="button" variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.direct.decline", conversationId: card.conversationId })}>
            Not now
          </Action>
          <Action type="submit" form={formId} variant="primary" disabled={empty || disabled} aria-describedby={hintId}>
            Talk to {card.company}
          </Action>
        </>
      }
    >
      <p className="text-base text-pretty">{card.reason}</p>
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() && !disabled) send({ type: "poppy.direct.start", conversationId: card.conversationId, text: text.trim() });
        }}
      >
        <InputArea value={text} onValueChange={setText} rows={2} placeholder="Hi, I'd like to explain this myself." aria-label="Your message" className="text-base" />
        <p id={hintId} className="mt-1 text-[13px] text-kumo-subtle">
          {empty ? "Write your first message to start." : `Your words go to ${card.company} as written, from you.`}
        </p>
      </form>
    </CardFrame>
  );
}

function SignInLinkCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "signin_link" }>; send: Send }) {
  const href = httpsHref(card.url);
  const { send, disabled, note } = useSend(sendFrame);
  return (
    <CardFrame
      domain={card.domain}
      icon={<SignInIcon size={16} />}
      title={`Sign in to ${card.company}`}
      meta="You sign in on the Company's own page. Your agent never sees your password."
      note={note}
      actions={
        <>
          <Action variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.signin.cancel", signInId: card.signInId })}>
            Cancel sign-in
          </Action>
          {href ? (
            <ActionLink href={href} external variant="primary">
              Sign in on {card.company}'s page <ArrowSquareOutIcon size={16} aria-hidden />
            </ActionLink>
          ) : null}
        </>
      }
    >
      <p className="text-base text-pretty">{card.reason}</p>
      <Access scopes={card.scopes} />
      {href ? null : <p className="text-base text-kumo-danger">This sign-in link isn't a secure web address, so it isn't shown.</p>}
    </CardFrame>
  );
}

function ApprovalCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "approval" }>; send: Send }) {
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

type ApprovalCardOf = Extract<Card, { kind: "approval" }>;

/** One photo in a batch: ticked to send, with its size, its pixels once it has loaded, and how it stands once sent. */
function BatchTile({ card, ticked, onToggle, decided }: { card: ApprovalCardOf; ticked: boolean; onToggle: () => void; decided: boolean }) {
  const [pixels, setPixels] = useState<string | null>(null);
  const photo = card.attachments?.[0];
  // Waiting until the User decides; then each tile follows its own card, so the User sees which went and which didn't.
  const status: ActivityResult | null = !decided ? null : card.status === "pending" ? (ticked ? "in_progress" : "declined") : APPROVAL_RESULT[card.status];
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
function BatchApprovalCard({ cards, decided, send: sendFrame, onDecided }: { cards: readonly ApprovalCardOf[]; decided: boolean; send: Send; onDecided: () => void }) {
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
          <p className="min-w-0 flex-1 text-pretty break-words">
            {card.company ? <span className="font-medium">{card.company} · </span> : null}
            {card.text}
            {note}
          </p>
          {dismiss}
        </div>
      );
    }
    case "approval": {
      const result = APPROVAL_RESULT[card.status];
      // Done only for a 2xx, and then "as you approved"; a refusal shows the Company's status and code (decision 6).
      const detail = card.answer
        ? `${card.answer.status}${card.answer.error ? ` ${card.answer.error}` : ""}`
        : card.status === "done"
          ? "as you approved"
          : card.status === "terms"
            ? "sent; its terms wait on the next card"
          : card.status === "failed"
            ? "after you approved"
            : null;
      const answered = card.answer ? `${card.answer.status}${card.answer.error ? ` (${card.answer.error})` : ""}` : "with an error";
      // What the Company answered, as a few facts; never its raw body, and never a URL (src/ui/result-facts.ts).
      const facts = card.status === "done" ? resultFacts(card.result).facts : [];
      return (
        <Receipt result={result} detail={detail} company={card.company} action={dismiss} note={note}>
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
              Sent as you approved, but {card.company} answered {answered}. Nothing changed unless {card.company} says otherwise.
            </p>
          ) : null}
          {card.status !== "done" && card.status !== "refused" && card.result ? <p>{redactQueries(card.result)}</p> : null}
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
      (card.kind === "approval" && card.status === "unknown")
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
