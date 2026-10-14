import { Table } from "@cloudflare/kumo";
import { ArrowLeftIcon, ChatsIcon, ShieldCheckIcon, StorefrontIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useId, useState, type FormEvent } from "react";
import type { ConnectedAccount, PendingSignOut, Permission } from "../poppy/wire";
import type { PoppyView } from "../use-pi-session";
import { SendAction, useSend, type Send } from "./connection";
import { Action, EmptyState, PageHeader, Section, Truncated } from "./controls";
import { ACCESS, accessOfScope, ago, fullDate, untilDate, when } from "./format";
import type { Issuer } from "../poppy/issuer";

/** One Company the agent knows the User at: its accounts, permissions and open conversations. */
type CompanyRow = {
  readonly issuer: Issuer;
  readonly name: string;
  readonly accounts: readonly ConnectedAccount[];
  readonly permissions: readonly Permission[];
  /** Sign-outs this Company hasn't accepted yet. */
  readonly signOuts: readonly PendingSignOut[];
};

function companiesOf(view: PoppyView): CompanyRow[] {
  const byIssuer = new Map<Issuer, { name: string; accounts: ConnectedAccount[]; permissions: Permission[]; signOuts: PendingSignOut[] }>();
  const entry = (issuer: Issuer, name: string) => {
    let found = byIssuer.get(issuer);
    if (!found) byIssuer.set(issuer, (found = { name, accounts: [], permissions: [], signOuts: [] }));
    return found;
  };
  for (const account of view.accounts) entry(account.issuer, account.company).accounts.push(account);
  for (const permission of view.permissions) entry(permission.issuer, permission.company).permissions.push(permission);
  for (const signOut of view.signOuts) entry(signOut.issuer, signOut.company).signOuts.push(signOut);
  return [...byIssuer.entries()]
    .map(([issuer, row]) => ({ issuer, ...row }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "View and change", with the raw scope beside it in small mono. */
function AccessCell({ scope }: { scope: string }) {
  const level = accessOfScope(scope);
  return (
    <span className="flex min-w-0 flex-col">
      <span>{level ? ACCESS[level] : scope ? "Access the Company defines" : "Signed out"}</span>
      {scope ? <code className="truncate font-mono text-[13px] text-kumo-subtle">{scope}</code> : null}
    </span>
  );
}

function usesLeft(permission: Permission): string {
  if (permission.maxUses === null) return `Used ${permission.uses} ${permission.uses === 1 ? "time" : "times"}, no limit`;
  const left = Math.max(0, permission.maxUses - permission.uses);
  return `${permission.uses} of ${permission.maxUses} uses, ${left} left`;
}

function limitText(permission: Permission): string {
  return permission.maxAmount ? `up to ${permission.maxAmount} ${permission.currency ?? ""}`.trim() : "any amount";
}

/** Add a standing permission for one Company: persistent labels, inline checks, input kept on error. */
function AddPermission({ company, send: sendFrame }: { company: CompanyRow; send: Send }) {
  const { send, disabled, note } = useSend(sendFrame);
  const [draft, setDraft] = useState({ account: "", action: "", maxAmount: "", currency: "USD", maxUses: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ids = { action: useId(), amount: useId(), uses: useId() };
  const accounts = company.accounts;
  if (accounts.length === 0) {
    return <p className="text-[13px] text-kumo-subtle">Sign in to {company.name} through your agent to add a standing permission.</p>;
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!draft.action.trim()) found.action = "Name the word or words the Company's summary must begin with, such as exchange.";
    if (draft.maxAmount && !/^\d+(\.\d+)?$/.test(draft.maxAmount.trim())) found.amount = "Use a number, such as 50 or 49.99.";
    if (draft.maxUses && !/^[1-9]\d*$/.test(draft.maxUses.trim())) found.uses = "Use a whole number of times, such as 3.";
    setErrors(found);
    if (Object.keys(found).length) return;
    const account = accounts.find((item) => `${item.issuer}|${item.account}` === draft.account) ?? accounts[0]!;
    if (disabled) return;
    const sent = send({
      type: "poppy.permission.add",
      issuer: account.issuer,
      account: account.account,
      action: draft.action.trim(),
      ...(draft.maxAmount ? { maxAmount: draft.maxAmount.trim(), currency: draft.currency } : {}),
      ...(draft.maxUses ? { maxUses: Number(draft.maxUses) } : {})
    });
    // What the User filled in stays unless it went.
    if (sent) setDraft({ ...draft, action: "", maxAmount: "", maxUses: "" });
  };
  const field =
    "mt-1 block w-full rounded-lg bg-kumo-base px-3 py-2 text-base text-kumo-default ring ring-kumo-line placeholder:text-kumo-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand aria-invalid:ring-kumo-danger";
  const label = "block text-[13px] font-medium text-kumo-default";
  return (
    <form noValidate onSubmit={submit} className="space-y-4 rounded-xl p-4 ring ring-kumo-hairline" aria-label={`Add a standing permission at ${company.name}`}>
      <p className="text-base font-semibold">Add a standing permission</p>
      <label className={label}>
        Account
        <select className={field} value={draft.account} onChange={(event) => setDraft({ ...draft, account: event.target.value })}>
          {accounts.map((account) => (
            <option key={`${account.issuer}|${account.account}`} value={`${account.issuer}|${account.account}`}>
              {account.account}
            </option>
          ))}
        </select>
      </label>
      <div>
        <label className={label}>
          Word or words {company.name}'s summary must begin with
          <input
            className={field}
            value={draft.action}
            placeholder="exchange"
            aria-invalid={errors.action ? true : undefined}
            aria-describedby={errors.action ? ids.action : undefined}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          />
        </label>
        {errors.action ? (
          <p id={ids.action} className="mt-1 text-[13px] text-kumo-danger">
            {errors.action}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_6rem_1fr]">
        <div>
          <label className={label}>
            Up to
            <input
              className={`${field} tabular-nums`}
              inputMode="decimal"
              placeholder="50"
              value={draft.maxAmount}
              aria-invalid={errors.amount ? true : undefined}
              aria-describedby={errors.amount ? ids.amount : undefined}
              onChange={(event) => setDraft({ ...draft, maxAmount: event.target.value })}
            />
          </label>
          {errors.amount ? (
            <p id={ids.amount} className="mt-1 text-[13px] text-kumo-danger">
              {errors.amount}
            </p>
          ) : null}
        </div>
        <label className={label}>
          Currency
          <input className={`${field} uppercase`} maxLength={3} value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} />
        </label>
        <div className="col-span-2 sm:col-span-1">
          <label className={label}>
            Number of times
            <input
              className={`${field} tabular-nums`}
              inputMode="numeric"
              placeholder="3"
              value={draft.maxUses}
              aria-invalid={errors.uses ? true : undefined}
              aria-describedby={errors.uses ? ids.uses : undefined}
              onChange={(event) => setDraft({ ...draft, maxUses: event.target.value })}
            />
          </label>
          {errors.uses ? (
            <p id={ids.uses} className="mt-1 text-[13px] text-kumo-danger">
              {errors.uses}
            </p>
          ) : null}
        </div>
      </div>
      <p className="text-[13px] text-pretty text-kumo-subtle">Leave the amount or the number of times empty for no limit. Terms the agent can't check, such as a renewal or a flag, still come to you.</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {note ? <div className="basis-full text-right">{note}</div> : null}
        <Action type="submit" variant="primary" disabled={disabled}>
          Add standing permission
        </Action>
      </div>
    </form>
  );
}

/**
 * Sign-outs the Company hasn't accepted: the agent no longer uses the
 * account, but the access it granted is still live there. Said plainly, with
 * until when, and a way to try again.
 */
function SignOutsNotAccepted({ company, send }: { company: CompanyRow; send: Send }) {
  return (
    <ul className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-danger" aria-label={`Sign-outs not accepted by ${company.name}`}>
      {company.signOuts.map((signOut) => (
        <li key={signOut.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex items-center gap-1.5 text-base font-medium text-kumo-danger">
              <WarningCircleIcon size={16} aria-hidden />
              <span>
                Sign-out not accepted by {company.name} yet ({signOut.error ?? "no_answer"})
              </span>
            </p>
            <Truncated text={signOut.account} className="text-[13px] text-kumo-subtle" />
            <p className="text-[13px] text-pretty text-kumo-default">
              Your agent no longer uses this account, but the access {company.name} granted stays live there{" "}
              {signOut.expiresAt === null ? (
                <>until you revoke it at {company.name}.</>
              ) : (
                <>
                  until <time dateTime={new Date(signOut.expiresAt).toISOString()}>{fullDate(signOut.expiresAt)}</time>, unless you revoke it at {company.name}.
                </>
              )}
            </p>
            <p className="text-[13px] text-kumo-subtle tabular-nums">
              Tried {signOut.attempts} {signOut.attempts === 1 ? "time" : "times"} ·{" "}
              {signOut.nextAt === null ? "Your agent has stopped trying" : <>Trying again at {when(signOut.nextAt)}</>}
            </p>
          </div>
          <SendAction send={send} frame={{ type: "poppy.signout", issuer: signOut.issuer, account: signOut.account }}>
            Try again
          </SendAction>
        </li>
      ))}
    </ul>
  );
}

function CompanyDetail({ company, view, send, onBack }: { company: CompanyRow; view: PoppyView; send: Send; onBack: () => void }) {
  const conversations = (view.activity?.inProgress ?? []).filter((task) => task.kind === "conversation" && task.issuer === company.issuer);
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Action variant="ghost" icon={<ArrowLeftIcon size={16} aria-hidden />} onClick={onBack} className="-ml-2 pl-2">
          All Companies
        </Action>
        <PageHeader title={company.name} description={<code className="font-mono text-[13px] break-all">{company.issuer}</code>} />
      </div>

      <Section title="Accounts" description="Accounts your agent is signed in to. Signing out stops your agent using the account at once, and asks the Company to revoke the access it granted.">
        {company.accounts.length === 0 && company.signOuts.length === 0 ? (
          <EmptyState icon={<StorefrontIcon size={20} />} title="Not signed in">
            Your agent asks you to sign in at {company.name} when a task needs your account.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline">
            {company.accounts.map((account) => (
              <li key={account.account} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
                <div className="min-w-0 flex-1">
                  <Truncated text={account.account} className="text-base font-medium" />
                  <p className="text-[13px] text-kumo-subtle">Until {untilDate(account.expiresAt)}</p>
                </div>
                <div className="min-w-0 text-base">
                  <AccessCell scope={account.scope} />
                </div>
                <SendAction send={send} frame={{ type: "poppy.signout", issuer: account.issuer, account: account.account }}>
                  Sign out of {company.name}
                </SendAction>
              </li>
            ))}
          </ul>
        )}
        {company.signOuts.length ? <SignOutsNotAccepted company={company} send={send} /> : null}
      </Section>

      <Section title="Standing permissions" description={`Your agent approves ${company.name}'s proposals that match, within these limits. Anything else still asks you.`}>
        {company.permissions.length === 0 ? (
          <EmptyState icon={<ShieldCheckIcon size={20} />} title="None yet">
            Without one, your agent asks you before every change at {company.name}.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline">
            {company.permissions.map((permission) => (
              <li key={permission.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-base">
                    Proposals that say “{permission.action}”, {limitText(permission)}
                  </p>
                  <p className="text-[13px] text-kumo-subtle tabular-nums">
                    {usesLeft(permission)} · Until {untilDate(permission.expiresAt)} · {permission.account}
                  </p>
                </div>
                <SendAction send={send} frame={{ type: "poppy.permission.remove", id: permission.id }}>
                  Remove standing permission
                </SendAction>
              </li>
            ))}
          </ul>
        )}
        <AddPermission company={company} send={send} />
      </Section>

      <Section title="Open conversations" description={`Conversations with ${company.name}'s agent that your agent is still following.`}>
        {conversations.length === 0 ? (
          <EmptyState icon={<ChatsIcon size={20} />} title="None open">
            Your agent closes a conversation when the task is done.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline">
            {conversations.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-base">{task.what}</p>
                  <p className="text-[13px] text-kumo-subtle">
                    {task.note ? `${task.note} · ` : ""}Last heard {ago(task.since)}
                  </p>
                </div>
                {task.stop ? (
                  <SendAction send={send} frame={task.stop}>
                    End conversation
                  </SendAction>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/**
 * Companies: where the agent is signed in, with what access, and what it may
 * approve by itself. A table first; a Company's own page for changing it.
 */
export function CompaniesPage({
  view,
  send,
  selected,
  onSelect
}: {
  view: PoppyView;
  send: Send;
  selected: string | null;
  onSelect: (issuer: Issuer | null) => void;
}) {
  const companies = companiesOf(view);
  const company = selected ? companies.find((item) => item.issuer === selected) : undefined;
  if (company) return <CompanyDetail company={company} view={view} send={send} onBack={() => onSelect(null)} />;
  return (
    <div className="space-y-6">
      <PageHeader title="Companies" description="Where your agent can act for you, with what access, and what it may approve without asking." />
      {companies.length === 0 ? (
        <EmptyState icon={<StorefrontIcon size={20} />} title="No Companies yet">
          When you sign in at a Company through your agent, it appears here with the access you gave.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl ring ring-kumo-hairline">
          <Table className="max-md:block">
            <Table.Header className="max-md:hidden">
              <Table.Row>
                <Table.Head>Company</Table.Head>
                <Table.Head>Account</Table.Head>
                <Table.Head>Access</Table.Head>
                <Table.Head className="max-md:hidden">Until</Table.Head>
                <Table.Head className="max-sm:hidden">Standing permissions</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body className="max-md:block">
              {companies.flatMap((row) =>
                (row.accounts.length ? row.accounts : [null]).map((account, index) => (
                  <Table.Row key={`${row.issuer}|${account?.account ?? ""}`} className="max-md:flex max-md:flex-col max-md:gap-1 max-md:px-4 max-md:py-3">
                    <Table.Cell className="max-w-48 max-md:max-w-none max-md:p-0!">
                      {index === 0 ? (
                        <button
                          type="button"
                          onClick={() => onSelect(row.issuer)}
                          className="-mx-1 flex min-h-10 max-w-full items-center rounded-md px-1 text-left text-base font-medium text-kumo-link underline-offset-4 hover:underline"
                        >
                          <Truncated text={row.name} />
                        </button>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell className="max-w-56 max-md:max-w-none max-md:p-0!">
                      {account ? (
                        <Truncated text={account.account} />
                      ) : row.signOuts.length ? (
                        <span className="text-kumo-danger">Sign-out not accepted yet</span>
                      ) : (
                        <span className="text-kumo-subtle">Signed out</span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="max-md:p-0!">{account ? <AccessCell scope={account.scope} /> : null}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap max-md:hidden">{account ? untilDate(account.expiresAt) : null}</Table.Cell>
                    <Table.Cell className="tabular-nums max-sm:hidden">{index === 0 ? row.permissions.length : null}</Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
          </Table>
        </div>
      )}
    </div>
  );
}
