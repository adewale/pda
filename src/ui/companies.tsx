import { Table } from "@cloudflare/kumo";
import { ArrowLeftIcon, ChatsIcon, StorefrontIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ConnectedAccount, PendingSignOut } from "../poppy/wire";
import type { PoppyView } from "../use-pi-session";
import { SendAction, type Send } from "./connection";
import { Action, EmptyState, PageHeader, Section, Truncated } from "./controls";
import { ago, fullDate, untilDate, when } from "./format";
import type { Issuer } from "../poppy/issuer";

/** One Company the agent knows the User at: its accounts and open conversations. */
type CompanyRow = {
  readonly issuer: Issuer;
  readonly name: string;
  readonly accounts: readonly ConnectedAccount[];
  /** Sign-outs this Company hasn't accepted yet. */
  readonly signOuts: readonly PendingSignOut[];
  /** The Company's verified domain, when the agent has used it. */
  readonly domain: string | null;
  /** When the agent last made a Poppy request there; null when only an account says it knows the Company. */
  readonly lastUsed: number | null;
};

/**
 * Every Company the agent knows the User at: where it holds an account, and where it has only used a signed-out Session, such
 * as an order placed without signing in (from the protocol log's index).
 */
export function companiesOf(view: PoppyView): CompanyRow[] {
  const byIssuer = new Map<Issuer, { name: string; accounts: ConnectedAccount[]; signOuts: PendingSignOut[]; domain: string | null; lastUsed: number | null }>();
  const entry = (issuer: Issuer, name: string) => {
    let found = byIssuer.get(issuer);
    if (!found) byIssuer.set(issuer, (found = { name, accounts: [], signOuts: [], domain: null, lastUsed: null }));
    return found;
  };
  for (const account of view.accounts) entry(account.issuer, account.company).accounts.push(account);
  for (const signOut of view.signOuts) entry(signOut.issuer, signOut.company).signOuts.push(signOut);
  for (const used of view.protocol.companies ?? []) {
    if (!used.issuer) continue;
    const found = entry(used.issuer, used.company);
    found.domain = used.domain;
    found.lastUsed = used.lastAt;
  }
  return [...byIssuer.entries()]
    .map(([issuer, row]) => ({ issuer, ...row }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The scopes the Company granted, in small mono: each Company defines its own (spec 4.7). */
function AccessCell({ scope }: { scope: string }) {
  return scope ? <code className="block truncate font-mono text-[13px]">{scope}</code> : <span className="text-kumo-subtle">No scopes</span>;
}

function NotAccepted({ company, reason, send }: { company: CompanyRow; reason: PendingSignOut["reason"]; send: Send }) {
  const stepUp = reason === "step_up";
  return (
    <ul
      className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-danger"
      aria-label={stepUp ? `Replaced access not revoked by ${company.name}` : `Sign-outs not accepted by ${company.name}`}
    >
      {company.signOuts.filter((signOut) => signOut.reason === reason).map((signOut) => (
        <li key={signOut.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex items-center gap-1.5 text-base font-medium text-kumo-danger">
              <WarningCircleIcon size={16} aria-hidden />
              <span>
                {stepUp ? "Revoking replaced access" : "Sign-out"} not accepted by {company.name} yet ({signOut.error ?? "no_answer"})
              </span>
            </p>
            <Truncated text={signOut.account} className="text-[13px] text-kumo-subtle" />
            <p className="text-[13px] text-pretty text-kumo-default">
              {stepUp
                ? "You gave your agent more access to this account, and it uses only the new access, but the access it had before stays live there "
                : `Your agent no longer uses this account, but the access ${company.name} granted stays live there `}
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
          <SendAction send={send} frame={{ type: "poppy.revoke.retry", id: signOut.id }}>
            Try again
          </SendAction>
        </li>
      ))}
    </ul>
  );
}

function CompanyDetail({ company, view, send, onBack }: { company: CompanyRow; view: PoppyView; send: Send; onBack: () => void }) {
  const conversations = (view.activity?.inProgress ?? []).filter((task) => task.kind === "conversation" && task.issuer === company.issuer);
  const operations = (view.activity?.inProgress ?? []).filter((task) => task.kind === "approval" && task.issuer === company.issuer);
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
        {company.signOuts.some((signOut) => signOut.reason === "sign_out") ? <NotAccepted company={company} reason="sign_out" send={send} /> : null}
        {company.signOuts.some((signOut) => signOut.reason === "step_up") ? <NotAccepted company={company} reason="step_up" send={send} /> : null}
      </Section>

      <Section title="In progress" description={`Approved requests at ${company.name} that haven't finished, signed in or not.`}>
        {operations.length === 0 ? (
          <EmptyState icon={<StorefrontIcon size={20} />} title="Nothing in progress">
            What your agent does here, and how it ended, is listed in Activity.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline">
            {operations.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-base">
                    {task.what}
                    {task.quote ? <> “{task.quote}”</> : null}
                  </p>
                  <p className="text-[13px] text-kumo-subtle">
                    {task.note ? `${task.note} · ` : ""}Since {ago(task.since)}
                  </p>
                </div>
                {task.stop ? (
                  <SendAction send={send} frame={task.stop}>
                    Stop
                  </SendAction>
                ) : null}
              </li>
            ))}
          </ul>
        )}
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
      <PageHeader title="Companies" description="Where your agent can act for you, with what access. Every change asks for your approval." />
      {companies.length === 0 ? (
        <EmptyState icon={<StorefrontIcon size={20} />} title="No Companies yet">
          When your agent uses a Company, signed in or not, it appears here with the access you gave.
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
                        <span className="text-kumo-danger">
                          {row.signOuts.some((signOut) => signOut.reason === "sign_out") ? "Sign-out not accepted yet" : "Revoking replaced access not accepted yet"}
                        </span>
                      ) : (
                        <span className="text-kumo-subtle">
                          Used without signing in{row.lastUsed !== null ? <> · last <span title={fullDate(row.lastUsed)}>{ago(row.lastUsed)}</span></> : null}
                        </span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="max-md:p-0!">{account ? <AccessCell scope={account.scope} /> : null}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap max-md:hidden">{account ? untilDate(account.expiresAt) : null}</Table.Cell>
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
