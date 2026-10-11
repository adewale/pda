import { Badge, Button, InputArea, Surface } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  KeyIcon,
  StorefrontIcon,
  UserIcon,
  XIcon
} from "@phosphor-icons/react";
import qrcode from "qrcode-generator";
import { useMemo, useState } from "react";
import type { Card, DirectUpdate, PoppyClientFrame } from "./poppy/wire";
import type { PoppyView } from "./use-pi-session";

type Send = (frame: PoppyClientFrame) => void;

/** A QR code drawn as SVG cells, for opening a device sign-in on a phone. */
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
    <svg viewBox={`-2 -2 ${cells.size + 4} ${cells.size + 4}`} className="size-36 rounded-lg bg-white" role="img" aria-label="QR code for the sign-in link">
      <path d={cells.path} fill="#000" />
    </svg>
  );
}

function Scopes({ scopes }: { scopes: readonly { scope: string; description: string }[] }) {
  return (
    <ul className="mt-2 space-y-1 text-xs text-kumo-subtle">
      {scopes.map((scope) => (
        <li key={scope.scope}>
          <code className="font-semibold text-kumo-default">{scope.scope}</code> — {scope.description}
        </li>
      ))}
    </ul>
  );
}

function CardFrame({ title, company, children, onDismiss }: { title: string; company: string; children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StorefrontIcon size={16} className="shrink-0 text-kumo-subtle" />
          <p className="truncate text-sm font-semibold">
            {title}
            {company ? <span className="font-normal text-kumo-subtle"> · {company}</span> : null}
          </p>
        </div>
        {onDismiss ? (
          <Button variant="ghost" shape="square" size="sm" aria-label="Dismiss" onClick={onDismiss} icon={<XIcon size={14} />} />
        ) : null}
      </div>
      {children}
    </Surface>
  );
}

function CredentialsCard({ card, send }: { card: Extract<Card, { kind: "signin_credentials" }>; send: Send }) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <CardFrame title="Sign in" company={card.company}>
      <p className="text-sm">{card.reason}</p>
      <p className="mt-1 text-xs text-kumo-subtle">
        Your details go straight to {card.company}. The agent's model never sees them, and they aren't stored.
      </p>
      <Scopes scopes={card.scopes} />
      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          send({ type: "poppy.credentials", signInId: card.signInId, values });
          setValues({});
        }}
      >
        {card.fields.map((field) => (
          <label key={field.name} className="block text-xs">
            <span className="text-kumo-subtle">{field.label}</span>
            <input
              className="mt-1 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm"
              type={field.secret ? "password" : "text"}
              autoComplete={field.secret ? "current-password" : "username"}
              value={values[field.name] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              required
            />
          </label>
        ))}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" icon={<KeyIcon size={14} />}>
            Sign in
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => send({ type: "poppy.signin.cancel", signInId: card.signInId })}>
            Cancel
          </Button>
        </div>
      </form>
    </CardFrame>
  );
}

function CodeCard({ card, send }: { card: Extract<Card, { kind: "signin_code" }>; send: Send }) {
  const [code, setCode] = useState("");
  return (
    <CardFrame title="Enter the code" company={card.company}>
      <p className="text-sm">{card.company} sent a code: {card.sentTo}.</p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send({ type: "poppy.code", signInId: card.signInId, code });
          setCode("");
        }}
      >
        <input
          className="w-40 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-label="One-time code"
          required
        />
        <Button type="submit" variant="primary" size="sm">
          Submit
        </Button>
      </form>
    </CardFrame>
  );
}

function OperationCard({ card, send }: { card: Extract<Card, { kind: "operation" }>; send: Send }) {
  const decide = (decision: "approve" | "decline" | "cancel") =>
    send({ type: "poppy.operation", issuer: card.issuer, operationId: card.operationId, revision: card.revision, decision });
  return (
    <CardFrame title={card.open ? "Approve this?" : `Operation ${card.state.replace("_", " ")}`} company={card.company}>
      {card.account ? <p className="text-xs text-kumo-subtle">Account: {card.account}</p> : null}
      {/* The Company's own words, verbatim (Operations extension 5.1). */}
      <blockquote className="mt-2 border-l-2 border-kumo-line pl-3 text-sm">{card.summary}</blockquote>
      {card.previousSummary ? (
        <p className="mt-2 text-xs text-kumo-subtle">
          Changed from: <span className="line-through">{card.previousSummary}</span>
        </p>
      ) : null}
      <ul className="mt-2 space-y-0.5 text-xs text-kumo-subtle">
        {card.highlights.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {card.expiresAt ? <li>Approve before {new Date(card.expiresAt).toLocaleString()}</li> : null}
      </ul>
      {card.result ? (
        <p className="mt-2 text-sm">
          <CheckCircleIcon size={14} className="mr-1 inline text-kumo-success" />
          {card.company} says: {card.result}
        </p>
      ) : null}
      {card.open ? (
        <div className="mt-3 flex gap-2">
          <Button variant="primary" size="sm" onClick={() => decide("approve")}>
            Approve
          </Button>
          <Button variant="secondary" size="sm" onClick={() => decide("decline")}>
            Decline
          </Button>
        </div>
      ) : card.state === "in_progress" ? (
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => decide("cancel")}>
            Ask to stop
          </Button>
        </div>
      ) : (
        <Badge variant="secondary" className="mt-2">
          {card.state}
          {card.approvedBy === "standing_permission" ? " · by standing permission" : ""}
        </Badge>
      )}
    </CardFrame>
  );
}

function DirectInvite({ card, send }: { card: Extract<Card, { kind: "direct_invite" }>; send: Send }) {
  const [text, setText] = useState("");
  return (
    <CardFrame title="Talk to them yourself?" company={card.company}>
      <p className="text-sm">{card.reason}</p>
      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) send({ type: "poppy.direct.start", conversationId: card.conversationId, text: text.trim() });
        }}
      >
        <InputArea value={text} onValueChange={setText} rows={2} placeholder={`Your first message to ${card.company}`} aria-label="Your message" />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={!text.trim()}>
            Talk to {card.company}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => send({ type: "poppy.direct.decline", conversationId: card.conversationId })}>
            Not now
          </Button>
        </div>
      </form>
    </CardFrame>
  );
}

function PoppyCard({ card, send }: { card: Card; send: Send }) {
  const dismiss = () => send({ type: "poppy.card.dismiss", id: card.id });
  switch (card.kind) {
    case "signin_link":
      return (
        <CardFrame title="Sign in" company={card.company}>
          <p className="text-sm">{card.reason}</p>
          <Scopes scopes={card.scopes} />
          <div className="mt-3 flex gap-2">
            <a
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-kumo-contrast px-3 py-1.5 text-sm font-medium text-kumo-inverse"
            >
              Sign in on {card.company}'s page <ArrowSquareOutIcon size={14} />
            </a>
            <Button variant="secondary" size="sm" onClick={() => send({ type: "poppy.signin.cancel", signInId: card.signInId })}>
              Cancel
            </Button>
          </div>
        </CardFrame>
      );
    case "signin_device":
      return (
        <CardFrame title="Sign in on any device" company={card.company}>
          <p className="text-sm">{card.reason}</p>
          <Scopes scopes={card.scopes} />
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <QrCode value={card.verificationUriComplete ?? card.verificationUri} />
            <div className="space-y-2">
              <p className="text-xs text-kumo-subtle">Check that the page shows this code:</p>
              <p className="font-mono text-2xl font-semibold tracking-widest">{card.userCode}</p>
              <a
                href={card.verificationUriComplete ?? card.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm underline"
              >
                Open {card.company}'s page <ArrowSquareOutIcon size={14} />
              </a>
            </div>
          </div>
        </CardFrame>
      );
    case "signin_credentials":
      return <CredentialsCard card={card} send={send} />;
    case "signin_code":
      return <CodeCard card={card} send={send} />;
    case "operation":
      return <OperationCard card={card} send={send} />;
    case "approval":
      return (
        <CardFrame title={card.status === "pending" ? "Approve this?" : `Request ${card.status}`} company={card.company} {...(card.open ? {} : { onDismiss: dismiss })}>
          <p className="text-sm">{card.summary}</p>
          {card.result ? <p className="mt-2 text-xs text-kumo-subtle">{card.result}</p> : null}
          {card.open ? (
            <div className="mt-3 flex gap-2">
              <Button variant="primary" size="sm" onClick={() => send({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" })}>
                Approve
              </Button>
              <Button variant="secondary" size="sm" onClick={() => send({ type: "poppy.approval", approvalId: card.approvalId, decision: "decline" })}>
                Decline
              </Button>
            </div>
          ) : null}
        </CardFrame>
      );
    case "direct_invite":
      return <DirectInvite card={card} send={send} />;
    case "notice":
      return (
        <CardFrame title={card.company || "Notice"} company="" onDismiss={dismiss}>
          <p className="text-sm">{card.text}</p>
        </CardFrame>
      );
  }
}

/** Cards waiting for the User, and recent outcomes. */
export function PoppyCards({ view, send }: { view: PoppyView; send: Send }) {
  if (view.cards.length === 0) return null;
  return (
    <div className="space-y-3" aria-label="Company requests">
      {view.cards.map((card) => (
        <PoppyCard key={card.id} card={card} send={send} />
      ))}
    </div>
  );
}

/** A Direct Conversation: the User talks with the Company; their words go as written. */
function DirectPanel({ update, send }: { update: DirectUpdate; send: Send }) {
  const [text, setText] = useState("");
  return (
    <Surface className="rounded-xl p-4 ring-2 ring-kumo-brand">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">You're talking with {update.company}</p>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary">{update.responder === "human" ? "A person" : "Their agent"}</Badge>
          {update.closed ? (
            <Badge variant="secondary">Ended</Badge>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => send({ type: "poppy.direct.close", conversationId: update.conversationId })}>
              End
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {(update.messages ?? []).map((message) => (
          <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex"}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${message.role === "user" ? "bg-kumo-contrast text-kumo-inverse" : "bg-kumo-elevated"}`}>
              {message.role === "company" ? (
                <p className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide text-kumo-subtle">
                  <UserIcon size={10} /> {message.sender === "human" ? "Person" : "Agent"}
                </p>
              ) : null}
              {message.text}
            </div>
          </div>
        ))}
        {update.partial ? <p className="text-sm italic text-kumo-subtle">{update.partial.text}</p> : null}
      </div>
      {update.closed ? null : (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            send({ type: "poppy.direct.say", conversationId: update.conversationId, text: text.trim() });
            setText("");
          }}
        >
          <InputArea value={text} onValueChange={setText} rows={1} placeholder="Your message" aria-label={`Message ${update.company}`} className="flex-1" />
          <Button type="submit" variant="primary" size="sm" disabled={!text.trim()}>
            Send
          </Button>
        </form>
      )}
    </Surface>
  );
}

export function DirectConversations({ view, send }: { view: PoppyView; send: Send }) {
  const open = Object.values(view.direct).filter((update) => !update.closed);
  if (open.length === 0) return null;
  return (
    <div className="space-y-3">
      {open.map((update) => (
        <DirectPanel key={update.conversationId} update={update} send={send} />
      ))}
    </div>
  );
}

/** Connected companies and standing permissions. */
export function PoppySettings({ view, send, onClose }: { view: PoppyView; send: Send; onClose: () => void }) {
  const [draft, setDraft] = useState({ account: "", action: "", maxAmount: "", currency: "USD", maxUses: "" });
  const accounts = view.accounts;
  return (
    <aside className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base" aria-label="Companies">
      <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-kumo-line px-4">
        <p className="text-sm font-semibold">Companies</p>
        <Button variant="ghost" shape="square" aria-label="Close" onClick={onClose} icon={<XIcon size={16} />} />
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Connected accounts</h2>
          {accounts.length === 0 ? <p className="text-sm text-kumo-subtle">None yet.</p> : null}
          <ul className="space-y-2">
            {accounts.map((account) => (
              <li key={`${account.issuer}|${account.account}`} className="rounded-lg p-3 ring ring-kumo-line">
                <p className="text-sm font-semibold">{account.company}</p>
                <p className="text-xs text-kumo-subtle">
                  {account.account} · {account.scope || "no scopes"}
                  {account.expiresAt ? ` · until ${new Date(account.expiresAt).toLocaleDateString()}` : ""}
                </p>
                <Button className="mt-2" variant="secondary" size="sm" onClick={() => send({ type: "poppy.signout", issuer: account.issuer, account: account.account })}>
                  Sign out
                </Button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Standing permissions</h2>
          <p className="mb-2 text-xs text-kumo-subtle">
            Let the agent approve matching proposals for you. Anything outside the limits still asks you.
          </p>
          <ul className="space-y-2">
            {view.permissions.map((permission) => (
              <li key={permission.id} className="rounded-lg p-3 ring ring-kumo-line text-sm">
                <p>
                  <span className="font-semibold">{permission.company}</span>: “{permission.action}”
                  {permission.maxAmount ? ` up to ${permission.maxAmount} ${permission.currency ?? ""}` : ""}
                </p>
                <p className="text-xs text-kumo-subtle">
                  {permission.maxUses ? `${permission.uses} of ${permission.maxUses} uses` : `${permission.uses} uses`}
                  {permission.expiresAt ? ` · until ${new Date(permission.expiresAt).toLocaleDateString()}` : ""}
                </p>
                <Button className="mt-2" variant="secondary" size="sm" onClick={() => send({ type: "poppy.permission.remove", id: permission.id })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {accounts.length > 0 ? (
            <form
              className="mt-3 space-y-2 text-xs"
              onSubmit={(event) => {
                event.preventDefault();
                const account = accounts.find((item) => `${item.issuer}|${item.account}` === draft.account) ?? accounts[0]!;
                send({
                  type: "poppy.permission.add",
                  issuer: account.issuer,
                  account: account.account,
                  action: draft.action,
                  ...(draft.maxAmount ? { maxAmount: draft.maxAmount, currency: draft.currency } : {}),
                  ...(draft.maxUses ? { maxUses: Number(draft.maxUses) } : {})
                });
                setDraft({ ...draft, action: "", maxAmount: "", maxUses: "" });
              }}
            >
              <select className="w-full rounded-lg border border-kumo-line bg-kumo-base px-2 py-1.5" value={draft.account} onChange={(event) => setDraft({ ...draft, account: event.target.value })} aria-label="Company account">
                {accounts.map((account) => (
                  <option key={`${account.issuer}|${account.account}`} value={`${account.issuer}|${account.account}`}>
                    {account.company} ({account.account})
                  </option>
                ))}
              </select>
              <input className="w-full rounded-lg border border-kumo-line bg-kumo-base px-2 py-1.5" placeholder="Action the summary mentions, e.g. exchange" value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} required />
              <div className="flex gap-2">
                <input className="w-24 rounded-lg border border-kumo-line bg-kumo-base px-2 py-1.5" placeholder="Max amount" inputMode="decimal" value={draft.maxAmount} onChange={(event) => setDraft({ ...draft, maxAmount: event.target.value })} />
                <input className="w-16 rounded-lg border border-kumo-line bg-kumo-base px-2 py-1.5" placeholder="USD" value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} />
                <input className="w-20 rounded-lg border border-kumo-line bg-kumo-base px-2 py-1.5" placeholder="Max uses" inputMode="numeric" value={draft.maxUses} onChange={(event) => setDraft({ ...draft, maxUses: event.target.value })} />
              </div>
              <Button type="submit" variant="secondary" size="sm">
                Add permission
              </Button>
            </form>
          ) : null}
        </section>
      </div>
    </aside>
  );
}
