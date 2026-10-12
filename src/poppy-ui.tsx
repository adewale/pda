import { cn, InputArea, Tabs } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
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
import { useId, useMemo, useState, type ReactNode } from "react";
import { humanSize } from "./attachments";
import type { Card, DirectUpdate, PoppyClientFrame, ScopeInfo } from "./poppy/wire";
import { AttachmentThumb } from "./ui/attachments";
import { Action, ActionLink, IconAction, useNow } from "./ui/controls";
import { ACCESS, accessOfScope, countdown, fullDate } from "./ui/format";
import type { PoppyView } from "./use-pi-session";

type Send = (frame: PoppyClientFrame) => void;

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
  actions
}: {
  /** The Company's verified domain, under its self-chosen name (N14). */
  domain: string | undefined;
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
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
      {actions ? <div className="mt-4 flex flex-wrap justify-end gap-2">{actions}</div> : null}
    </article>
  );
}

const fieldClass =
  "mt-1 block w-full rounded-lg bg-kumo-base px-3 py-2 text-base text-kumo-default ring ring-kumo-line placeholder:text-kumo-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand";

function CredentialsCard({ card, send }: { card: Extract<Card, { kind: "signin_credentials" }>; send: Send }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const formId = useId();
  return (
    <CardFrame
      domain={card.domain}
      icon={<KeyIcon size={16} />}
      title={`Sign in to ${card.company}`}
      meta="Your details go straight to the Company. Your agent's model never sees them, and they aren't stored."
      actions={
        <>
          <Action type="button" variant="secondary" onClick={() => send({ type: "poppy.signin.cancel", signInId: card.signInId })}>
            Cancel sign-in
          </Action>
          <Action type="submit" form={formId} variant="primary">
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
          send({ type: "poppy.credentials", signInId: card.signInId, values });
          setValues({});
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

function CodeCard({ card, send }: { card: Extract<Card, { kind: "signin_code" }>; send: Send }) {
  const [code, setCode] = useState("");
  const formId = useId();
  return (
    <CardFrame
      domain={card.domain}
      icon={<KeyIcon size={16} />}
      title={`Enter the code from ${card.company}`}
      actions={
        <Action type="submit" form={formId} variant="primary">
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
          send({ type: "poppy.code", signInId: card.signInId, code });
          setCode("");
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

function DeviceCard({ card, send }: { card: Extract<Card, { kind: "signin_device" }>; send: Send }) {
  const href = httpsHref(card.verificationUriComplete) ?? httpsHref(card.verificationUri);
  const now = useNow(1000);
  const left = card.expiresAt - now;
  return (
    <CardFrame
      domain={card.domain}
      icon={<DeviceMobileIcon size={16} />}
      title={`Sign in to ${card.company} on any device`}
      actions={
        <Action variant="secondary" onClick={() => send({ type: "poppy.signin.cancel", signInId: card.signInId })}>
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

function OperationCard({ card, send }: { card: Extract<Card, { kind: "operation" }>; send: Send }) {
  const decide = (decision: "approve" | "decline" | "cancel") =>
    send({ type: "poppy.operation", issuer: card.issuer, operationId: card.operationId, revision: card.revision, decision });
  return (
    <CardFrame
      domain={card.domain}
      icon={<HandIcon size={16} />}
      title={`Approve this at ${card.company}?`}
      meta={
        <>
          {card.account ? <>Account {card.account} · </> : null}View and change
          {card.userApprovalRequired ? " · The Company asks for your approval, not a standing permission" : null}
        </>
      }
      actions={
        <>
          <Action variant="secondary" onClick={() => decide("decline")}>
            Decline
          </Action>
          <Action variant="primary" onClick={() => decide("approve")}>
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

function DirectInvite({ card, send }: { card: Extract<Card, { kind: "direct_invite" }>; send: Send }) {
  const [text, setText] = useState("");
  const formId = useId();
  const hintId = useId();
  const empty = !text.trim();
  return (
    <CardFrame
      domain={card.domain}
      icon={<UsersIcon size={16} />}
      title={`Talk to ${card.company} yourself?`}
      actions={
        <>
          <Action type="button" variant="secondary" onClick={() => send({ type: "poppy.direct.decline", conversationId: card.conversationId })}>
            Not now
          </Action>
          <Action type="submit" form={formId} variant="primary" disabled={empty} aria-describedby={hintId}>
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
          if (text.trim()) send({ type: "poppy.direct.start", conversationId: card.conversationId, text: text.trim() });
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

function SignInLinkCard({ card, send }: { card: Extract<Card, { kind: "signin_link" }>; send: Send }) {
  const href = httpsHref(card.url);
  return (
    <CardFrame
      domain={card.domain}
      icon={<SignInIcon size={16} />}
      title={`Sign in to ${card.company}`}
      meta="You sign in on the Company's own page. Your agent never sees your password."
      actions={
        <>
          <Action variant="secondary" onClick={() => send({ type: "poppy.signin.cancel", signInId: card.signInId })}>
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

function ApprovalCard({ card, send }: { card: Extract<Card, { kind: "approval" }>; send: Send }) {
  const photos = card.attachments ?? [];
  return (
    <CardFrame
      domain={card.domain}
      icon={<HandIcon size={16} />}
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
          <Action variant="secondary" onClick={() => send({ type: "poppy.approval", approvalId: card.approvalId, decision: "decline" })}>
            Decline
          </Action>
          <Action variant="primary" onClick={() => send({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" })}>
            Approve
          </Action>
        </>
      }
    >
      {photos.length ? (
        <div className="flex flex-wrap gap-2">
          {photos.map((photo) => (
            <AttachmentThumb key={photo.id} id={photo.id} name={photo.name} detail={humanSize(photo.size)} />
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
  failed: "Failed after you approved",
  unknown: "Interrupted"
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
function Receipt({ tone, company, children, action }: { tone: Tone; company: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="enter flex min-h-10 items-start gap-2 py-1">
      <span aria-hidden className="mt-0.5 shrink-0">
        {TONE_ICON[tone]}
      </span>
      <div className={cn("min-w-0 flex-1 text-[13px] text-pretty break-words", tone === "danger" ? "text-kumo-danger" : "text-kumo-subtle")}>
        {company ? <span className="font-medium text-kumo-default">{company} · </span> : null}
        {children}
      </div>
      {action}
    </div>
  );
}

function ClosedCard({ card, send }: { card: Card; send: Send }) {
  const dismiss = <IconAction label="Dismiss" variant="ghost" icon={<XIcon size={16} />} onClick={() => send({ type: "poppy.card.dismiss", id: card.id })} className="-my-2" />;
  switch (card.kind) {
    case "notice": {
      const error = card.id.startsWith("error-");
      return (
        <Receipt tone={error ? "danger" : "info"} company={card.company} action={dismiss}>
          {card.text}
        </Receipt>
      );
    }
    case "approval": {
      const tone: Tone = card.status === "failed" || card.status === "unknown" ? "danger" : card.status === "declined" ? "info" : "success";
      return (
        <Receipt tone={tone} company={card.company} action={dismiss}>
          {APPROVAL_STATUS[card.status]}: {card.summary}
          {card.result ? <span className="block text-kumo-subtle">{card.result}</span> : null}
        </Receipt>
      );
    }
    case "operation": {
      const decided = card.approvedBy === "standing_permission" ? "approved by standing permission" : card.approvedBy === "user" ? "approved by you" : null;
      if (card.lost) {
        return (
          <Receipt tone={card.lost === "unknown" ? "danger" : "info"} company={card.company} action={dismiss}>
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
      if (card.state === "in_progress") {
        return (
          <Receipt
            tone="info"
            company={card.company}
            action={
              <Action
                variant="secondary"
                className="-my-1"
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

/** The tray pinned above the chat: everything waiting for the User, with a count. */
export function NeedsYouTray({ view, send, extra }: { view: PoppyView; send: Send; extra?: ReactNode }) {
  const items = needsYou(view.cards);
  const count = items.length + (extra ? 1 : 0);
  if (count === 0) return null;
  return (
    <section aria-labelledby="needs-you" className="max-h-[45dvh] shrink-0 overflow-y-auto border-b border-kumo-hairline bg-kumo-elevated">
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-4 sm:px-6">
        <h2 id="needs-you" className="flex items-center gap-2 text-base font-semibold text-kumo-strong">
          Needs you
          <span className="rounded-full bg-kumo-warning-tint px-2 text-[13px] font-semibold text-kumo-warning tabular-nums">{count}</span>
        </h2>
        {extra}
        {items.map((card) => (
          <PoppyCard key={card.id} card={card} send={send} />
        ))}
      </div>
    </section>
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
function DirectPanel({ update, send, onHide }: { update: DirectUpdate; send: Send; onHide?: () => void }) {
  const [text, setText] = useState("");
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
          if (!text.trim()) return;
          send({ type: "poppy.direct.say", conversationId: update.conversationId, text: text.trim() });
          setText("");
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
        <Action type="submit" variant="primary" disabled={!text.trim()} icon={<PaperPlaneRightIcon size={16} aria-hidden />}>
          Send
        </Action>
      </form>
      <div className="flex shrink-0 justify-end px-4 pb-3">
        <Action variant="secondary" onClick={() => send({ type: "poppy.direct.close", conversationId: update.conversationId })}>
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
