import { cn, InputArea, Tabs } from "@cloudflare/kumo";
import { Dialog } from "@cloudflare/kumo/primitives/dialog";
import {
  ArrowSquareOutIcon,
  CaretUpIcon,
  CheckCircleIcon,
  DeviceMobileIcon,
  HandIcon,
  InfoIcon,
  KeyIcon,
  PaperPlaneRightIcon,
  SignInIcon,
  UserIcon,
  UsersIcon,
  WarningCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import qrcode from "qrcode-generator";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { humanSize } from "./attachments";
import type { Card, DirectUpdate, ScopeInfo } from "./poppy/wire";
import { AttachmentThumb } from "./ui/attachments";
import { useSend, type Send } from "./ui/connection";
import { Action, ActionLink, IconAction, useNow } from "./ui/controls";
import { ACCESS, accessOfScope, countdown, fullDate } from "./ui/format";
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

/** What a sign-in asks for: access in plain words, then each scope as the Company describes it. */
function Access({ scopes }: { scopes: readonly ScopeInfo[] }) {
  const level = accessOfScope(scopes.map((scope) => scope.scope).join(" "));
  return (
    <div className="text-[13px] text-kumo-subtle">
      <p>
        <span className="font-medium text-kumo-default">{level ? ACCESS[level] : "Access the Company defines"}</span>
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
  return (
    <article aria-labelledby={id} className="enter rounded-xl bg-kumo-base p-4 ring ring-kumo-hairline">
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
          className="sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-wrap justify-end gap-2 rounded-b-xl bg-kumo-base px-4 py-3 shadow-[0_-8px_12px_-8px_rgb(0_0_0/0.15)]"
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

function OperationCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "operation" }>; send: Send }) {
  const { send, disabled, note } = useSend(sendFrame);
  const decide = (decision: "approve" | "decline" | "cancel") =>
    send({ type: "poppy.operation", issuer: card.issuer, operationId: card.operationId, revision: card.revision, decision });
  return (
    <CardFrame
      domain={card.domain}
      icon={<HandIcon size={16} />}
      title={`Approve this at ${card.company}?`}
      note={note}
      meta={
        <>
          {card.account ? <>Account {card.account} · </> : null}View and change
          {card.userApprovalRequired ? " · The Company requires your explicit approval" : null}
        </>
      }
      actions={
        <>
          <Action variant="secondary" disabled={disabled} onClick={() => decide("decline")}>
            Decline
          </Action>
          <Action variant="primary" disabled={disabled} onClick={() => decide("approve")}>
            Approve
          </Action>
        </>
      }
    >
      {/* The Company's own words, verbatim (Operations extension 5.1). */}
      <CompanySays company={card.company}>{card.summary}</CompanySays>
      {card.previousSummary ? (
        <p className="text-[13px] text-kumo-subtle">
          Changed from: <del>{card.previousSummary}</del>
        </p>
      ) : null}
      <ul className="space-y-0.5 text-[13px] text-kumo-subtle tabular-nums">
        {card.highlights.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {card.expiresAt ? <li>Approve before {new Date(card.expiresAt).toLocaleString()}</li> : null}
      </ul>
    </CardFrame>
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
            Approve
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
      <p className="text-base text-pretty break-words">{card.summary}</p>
    </CardFrame>
  );
}

const APPROVAL_STATUS: Record<Extract<Card, { kind: "approval" }>["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "You declined",
  done: "Done, as you approved",
  refused: "Sent as you approved, but not done",
  failed: "Failed after you approved",
  unknown: "Outcome unknown"
};

const OPERATION_STATE: Record<string, string> = {
  proposed: "Approved, confirming",
  in_progress: "In progress",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired"
};

type Tone = "success" | "danger" | "info";

const TONE_ICON: Record<Tone, ReactNode> = {
  success: <CheckCircleIcon size={16} className="text-kumo-success" />,
  danger: <WarningCircleIcon size={16} className="text-kumo-danger" />,
  info: <InfoIcon size={16} className="text-kumo-subtle" />
};

/** A one-line record of something resolved: what happened, and where. */
function Receipt({ tone, company, children, action, note }: { tone: Tone; company: string; children: ReactNode; action?: ReactNode; note?: ReactNode }) {
  return (
    <div className="enter flex min-h-10 items-start gap-2 py-1">
      <span aria-hidden className="mt-0.5 shrink-0">
        {TONE_ICON[tone]}
      </span>
      <div className={cn("min-w-0 flex-1 text-[13px] text-pretty break-words", tone === "danger" ? "text-kumo-danger" : "text-kumo-subtle")}>
        {company ? <span className="font-medium text-kumo-default">{company} · </span> : null}
        {children}
        {note}
      </div>
      {action}
    </div>
  );
}

function ClosedCard({ card, send: sendFrame }: { card: Card; send: Send }) {
  // A receipt's buttons are disabled while the page isn't connected; the banner at the top says why, so each line doesn't.
  const { send, disabled, note } = useSend(sendFrame, { quiet: true });
  const dismiss = (
    <IconAction label="Dismiss" variant="ghost" icon={<XIcon size={16} />} disabled={disabled} onClick={() => send({ type: "poppy.card.dismiss", id: card.id })} className="-my-2" />
  );
  switch (card.kind) {
    case "notice": {
      const error = card.id.startsWith("error-");
      return (
        <Receipt tone={error ? "danger" : "info"} company={card.company} action={dismiss} note={note}>
          {card.text}
        </Receipt>
      );
    }
    case "approval": {
      if (card.status === "refused") {
        // Sent, and the Company answered with an error: never "done".
        const answered = card.answer ? `${card.answer.status}${card.answer.error ? ` (${card.answer.error})` : ""}` : "with an error";
        return (
          <Receipt tone="danger" company={card.company} action={dismiss} note={note}>
            Sent as you approved, but {card.company} answered {answered}: {card.summary}
            <span className="block text-kumo-subtle">Nothing changed unless {card.company} says otherwise.</span>
          </Receipt>
        );
      }
      const tone: Tone = card.status === "failed" || card.status === "unknown" ? "danger" : card.status === "declined" ? "info" : "success";
      return (
        <Receipt tone={tone} company={card.company} action={dismiss} note={note}>
          {APPROVAL_STATUS[card.status]}: {card.summary}
          {card.result ? <span className="block text-kumo-subtle">{card.result}</span> : null}
        </Receipt>
      );
    }
    case "operation": {
      const decided = card.approvedBy === "standing_permission" ? "approved by standing permission" : card.approvedBy === "user" ? "approved by you" : null;
      if (card.lost) {
        return (
          <Receipt tone={card.lost === "unknown" ? "danger" : "info"} company={card.company} action={dismiss} note={note}>
            {card.company} no longer has this, so nothing more can be done with it: “{card.summary}”
            <span className="block text-kumo-subtle">
              {card.lost === "unknown"
                ? `It may have happened: check with ${card.company} before asking again.`
                : decided
                  ? "It wasn't done. Ask your agent again if you still want it."
                  : "Nothing was confirmed."}
            </span>
          </Receipt>
        );
      }
      if (card.alteredSummary !== undefined) {
        // The Company changed this revision's terms after they were shown (Operations 3.1 forbids it).
        return (
          <Receipt tone="danger" company={card.company} action={dismiss} note={note}>
            {card.state === "proposed"
              ? `${card.company} changed these terms after you saw them, without a new revision, so your agent won't confirm them: “${card.summary}”`
              : `${card.company} now reports different terms from the ones ${decided ? "you approved" : "you saw"}: “${card.summary}”`}
            <span className="block text-kumo-subtle">
              {card.state === "proposed"
                ? `It now says: “${card.alteredSummary}”. Ask your agent for a new proposal if you still want it.`
                : `It says: “${card.alteredSummary}”. Check with ${card.company} what was done.`}
            </span>
          </Receipt>
        );
      }
      if (card.state === "in_progress") {
        return (
          <Receipt
            tone="info"
            company={card.company}
            note={note}
            action={
              <Action
                variant="secondary"
                className="-my-1"
                disabled={disabled}
                onClick={() => send({ type: "poppy.operation", issuer: card.issuer, operationId: card.operationId, revision: card.revision, decision: "cancel" })}
              >
                Ask {card.company} to stop
              </Action>
            }
          >
            In progress{decided ? `, ${decided}` : ""}: “{card.summary}”
          </Receipt>
        );
      }
      const tone: Tone = card.state === "succeeded" ? "success" : card.state === "failed" ? "danger" : "info";
      return (
        <Receipt tone={tone} company={card.company}>
          <span>
            {OPERATION_STATE[card.state] ?? card.state}
            {decided ? ` · ${decided}` : ""}
          </span>
          {card.result ? (
            <span className="block text-kumo-default">
              {card.company} says: {card.result}
            </span>
          ) : null}
          {card.links?.length ? (
            <span className="mt-1 flex flex-wrap gap-x-3">
              {card.links.flatMap((link) => {
                const href = httpsHref(link.url);
                return href
                  ? [
                      <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1 font-medium text-kumo-link underline">
                        Open {link.label} at {card.company}
                        <ArrowSquareOutIcon size={14} aria-hidden />
                      </a>
                    ]
                  : [];
              })}
            </span>
          ) : null}
        </Receipt>
      );
    }
    default:
      // Sign-in and invitation cards become notices when they close.
      return null;
  }
}

/** One card: a request while it waits for the User, a one-line receipt once resolved. */
export function PoppyCard({ card, send }: { card: Card; send: Send }) {
  if (!card.open) return <ClosedCard card={card} send={send} />;
  switch (card.kind) {
    case "signin_link":
      return <SignInLinkCard card={card} send={send} />;
    case "signin_device":
      return <DeviceCard card={card} send={send} />;
    case "signin_credentials":
      return <CredentialsCard card={card} send={send} />;
    case "signin_code":
      return <CodeCard card={card} send={send} />;
    case "operation":
      return <OperationCard card={card} send={send} />;
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

/** Resolved cards, for receipts under the transcript. */
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

/** New requests rise into view; putting the sheet away never answers a request. */
export function NeedsYouSheet({ view, send, extra, extraIds = [] }: { view: PoppyView; send: Send; extra?: ReactNode; extraIds?: readonly string[] }) {
  const items = needsYou(view.cards);
  const count = items.length + extraIds.length;
  // Ignore refreshed frames and removals. A new card, sign-in step, or operation
  // revision must draw attention again, even when the total count stays the same.
  const keys = [
    ...items.map((card) => JSON.stringify([card.id, card.kind, card.kind === "operation" ? card.revision : null])),
    ...extraIds.map((id) => JSON.stringify(["direct", id]))
  ];
  const [visibility, setVisibility] = useState({ keys, open: count > 0 });
  if (keys.length !== visibility.keys.length || keys.some((key, index) => key !== visibility.keys[index])) {
    setVisibility({ keys, open: count > 0 && (visibility.open || keys.some((key) => !visibility.keys.includes(key))) });
  }
  const title = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={visibility.open && count > 0} onOpenChange={(open) => setVisibility({ keys, open })}>
      {count > 0 ? (
        <div className="shrink-0 bg-kumo-base px-4 pt-3 sm:px-6">
          <Dialog.Trigger
            ref={trigger}
            render={<Action variant="secondary" className="mx-auto flex w-full max-w-3xl justify-between gap-3 bg-kumo-warning-tint" />}
          >
            <span className="flex items-center gap-2">
              <HandIcon size={18} aria-hidden className="text-kumo-warning" />
              Needs you
              <span className="rounded-full bg-kumo-base px-2 text-[13px] font-semibold text-kumo-warning tabular-nums">{count}</span>
            </span>
            <CaretUpIcon size={16} aria-hidden />
          </Dialog.Trigger>
        </div>
      ) : null}
      <Dialog.Portal keepMounted>
        <Dialog.Backdrop className="needs-you-backdrop fixed inset-0 z-40 bg-black/30" />
        <Dialog.Popup
          aria-modal="true"
          initialFocus={title}
          finalFocus={() => trigger.current ?? document.getElementById("chat-title")}
          className="needs-you-sheet fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-kumo-elevated text-kumo-default shadow-2xl ring ring-kumo-hairline outline-none"
        >
          <header className="shrink-0 border-b border-kumo-hairline px-4 pb-3 sm:px-6">
            <div aria-hidden className="mx-auto my-3 h-1 w-10 rounded-full bg-kumo-line" />
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title ref={title} tabIndex={-1} className="flex items-center gap-2 text-base font-semibold text-kumo-strong">
                Needs you
                <span className="rounded-full bg-kumo-warning-tint px-2 text-[13px] font-semibold text-kumo-warning tabular-nums">{count}</span>
              </Dialog.Title>
              <Dialog.Close render={<IconAction label="Close requests" variant="ghost" icon={<XIcon size={20} />} />} />
            </div>
            <Dialog.Description className="mt-1 text-[13px] text-kumo-subtle">Your agent is waiting for you. You can come back to these requests anytime.</Dialog.Description>
          </header>
          <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
            {extra}
            {items.map((card) => (
              <PoppyCard key={card.id} card={card} send={send} />
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Resolved requests as one-line receipts, under the transcript. */
export function Receipts({ view, send }: { view: PoppyView; send: Send }) {
  const items = receipts(view.cards);
  if (items.length === 0) return null;
  return (
    <section aria-label="Resolved requests" className="border-t border-kumo-hairline pt-3">
      {items.map((card) => (
        <PoppyCard key={card.id} card={card} send={send} />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- Direct Conversations

function speaker(update: DirectUpdate, sender: "agent" | "human"): string {
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
                  <span>{speaker(update, message.sender)}</span>
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
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-kumo-base p-3 ring ring-kumo-hairline">
      <UsersIcon size={16} aria-hidden className="shrink-0 text-kumo-warning" />
      <p className="min-w-0 flex-1 text-base">You're talking with {update.company}</p>
      <Action variant="primary" onClick={onOpen}>
        Open conversation
      </Action>
    </div>
  );
}
