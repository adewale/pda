/** Company sign-in cards, QR codes and scope descriptions. */
import { useMemo, useState, useId } from "react";
import qrcode from "qrcode-generator";
import { type ScopeInfo, type Card } from "../poppy/wire";
import { type Send, useSend } from "./connection";
import { CardFrame, httpsHref } from "./poppy-card-frame";
import { KeyIcon, DeviceMobileIcon, ArrowSquareOutIcon, UsersIcon, SignInIcon } from "@phosphor-icons/react";
import { Action, useNow, ActionLink } from "./controls";
import { cn, InputArea } from "@cloudflare/kumo";
import { fullDate, countdown } from "./format";

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
            {scope.hint ? <span className="text-kumo-subtle"> ({scope.hint})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const fieldClass =
  "mt-1 block w-full rounded-lg bg-kumo-base px-3 py-2 text-base text-kumo-default ring ring-kumo-line placeholder:text-kumo-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand";

export function CredentialsCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "signin_credentials" }>; send: Send }) {
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

export function CodeCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "signin_code" }>; send: Send }) {
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

export function DeviceCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "signin_device" }>; send: Send }) {
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

export function DirectInvite({ card, send: sendFrame }: { card: Extract<Card, { kind: "direct_invite" }>; send: Send }) {
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
          {/* 8.10: only the Company's own invitation can be accepted without a first message, so the Company speaks first. */}
          {card.eventId ? (
            <Action type="button" variant="secondary" disabled={disabled} onClick={() => send({ type: "poppy.direct.start", conversationId: card.conversationId, text: "", eventId: card.eventId })}>
              Let {card.company} start
            </Action>
          ) : null}
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
          if (text.trim() && !disabled) send({ type: "poppy.direct.start", conversationId: card.conversationId, text: text.trim(), ...(card.eventId ? { eventId: card.eventId } : {}) });
        }}
      >
        <InputArea value={text} onValueChange={setText} rows={2} placeholder="Hi, I'd like to explain this myself." aria-label="Your message" className="text-base" />
        <p id={hintId} className="mt-1 text-[13px] text-kumo-subtle">
          {empty ? (card.eventId ? `Write your first message, or let ${card.company} start.` : "Write your first message to start.") : `Your words go to ${card.company} as written, from you.`}
        </p>
      </form>
    </CardFrame>
  );
}

export function SignInLinkCard({ card, send: sendFrame }: { card: Extract<Card, { kind: "signin_link" }>; send: Send }) {
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
