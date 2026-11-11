import { useId, useState, type FormEvent } from "react";
import { ListChecksIcon } from "@phosphor-icons/react";
import type { InstructionCondition, StandingInstruction } from "../poppy/wire";
import type { Issuer } from "../poppy/issuer";
import { SendAction, useConnected, type Send } from "./connection";
import { Action, EmptyState, Section } from "./controls";
import { fullDate, when } from "./format";

const field =
  "mt-1 block w-full rounded-lg bg-kumo-base px-3 py-2 text-base text-kumo-default ring ring-kumo-line placeholder:text-kumo-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand aria-invalid:ring-kumo-danger";

/** A condition in plain words: what the Company's terms must say for the instruction to cover them. */
function conditionText(condition: InstructionCondition): string {
  const at = condition.path.join(" › ");
  if (condition.kind === "at_most") return `${at} is at most ${condition.amount} ${condition.currency}`;
  if (condition.kind === "one_of") return `${at} is one of ${condition.values.map(String).join(", ")}`;
  return `${at} is ${String(condition.value)}`;
}

const SPEND: Record<StandingInstruction["approvals"][number]["spend"], string> = {
  reserved: "reserved",
  used: "counted",
  released: "not counted"
};

/**
 * The User's standing instructions at one Company (0.4 Operations 5;
 * decision 44): each one, what it approved, and a way to withdraw it, and a
 * form to write a new one. Only this page writes them; the model reads them.
 */
export function InstructionsSection({ issuer, company, accounts, instructions, send }: {
  issuer: Issuer;
  company: string;
  accounts: readonly string[];
  instructions: readonly StandingInstruction[];
  send: Send;
}) {
  const mine = instructions.filter((item) => item.issuer === issuer);
  return (
    <Section
      title="Standing instructions"
      description={`What your agent may approve at ${company} without asking you, when ${company} speaks Poppy 0.4. Anything an instruction doesn't clearly cover, or that could make a change that can't be undone, still comes to you.`}
    >
      {mine.length === 0 ? (
        <EmptyState icon={<ListChecksIcon size={20} />} title="No instructions">
          Your agent asks you to approve each of {company}'s operations.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline">
          {mine.map((item) => (
            <li key={item.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium text-pretty">“{item.text}”</p>
                  <p className="text-[13px] text-kumo-subtle">
                    {item.conditions.map(conditionText).join("; ")}
                    {item.budget ? `; at most ${item.budget.amount} ${item.budget.currency} in any ${item.budget.days} days` : ""}
                    {item.account ? ` · account ${item.account}` : " · any account"}
                  </p>
                  <p className="text-[13px] text-kumo-subtle">
                    Written {fullDate(item.createdAt)}
                    {item.withdrawnAt !== null ? ` · withdrawn ${fullDate(item.withdrawnAt)}` : ""}
                  </p>
                </div>
                {item.withdrawnAt === null ? (
                  <SendAction send={send} frame={{ type: "poppy.instruction.withdraw", id: item.id }}>
                    Withdraw
                  </SendAction>
                ) : null}
              </div>
              {item.approvals.length ? (
                <ul className="space-y-1 text-[13px]" aria-label="What it approved">
                  {item.approvals.map((approval) => (
                    <li key={approval.approvalId} className="text-pretty">
                      <span className="text-kumo-subtle">{when(approval.at)}:</span> {approval.summary || approval.approvalId}{" "}
                      <span className="text-kumo-subtle">
                        ({approval.status}{approval.currency ? `; ${approval.amount} ${approval.currency} ${SPEND[approval.spend]}` : ""})
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-kumo-subtle">It hasn't approved anything yet.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <NewInstruction issuer={issuer} accounts={accounts} send={send} />
    </Section>
  );
}

/**
 * A new instruction: the User's own words, and one amount condition on a
 * member of the Company's terms (`price_difference`, say), with an optional
 * limit over a period. The agent checks it again before storing it.
 */
function NewInstruction({ issuer, accounts, send }: { issuer: Issuer; accounts: readonly string[]; send: Send }) {
  const ids = { text: useId(), path: useId(), amount: useId(), currency: useId(), account: useId(), budget: useId(), days: useId() };
  const connected = useConnected();
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [account, setAccount] = useState("");
  const [budget, setBudget] = useState("");
  const [days, setDays] = useState("7");
  const ready = text.trim() !== "" && path.trim() !== "" && /^\d+(\.\d{1,6})?$/.test(amount) && /^[A-Z]{3}$/.test(currency) && (budget === "" || /^\d+(\.\d{1,6})?$/.test(budget));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const sent = send({
      type: "poppy.instruction.add",
      issuer,
      account: account || null,
      text: text.trim(),
      conditions: [{ kind: "at_most", path: path.split(".").map((name) => name.trim()).filter(Boolean), amount, currency }],
      budget: budget ? { amount: budget, currency, days: Number(days) || 7 } : null
    });
    if (sent) {
      setText("");
      setPath("");
      setAmount("");
      setBudget("");
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl p-4 ring ring-kumo-hairline" aria-label="Write a standing instruction">
      <div>
        <label htmlFor={ids.text} className="block text-[13px] font-medium text-kumo-default">In your words</label>
        <input id={ids.text} className={field} placeholder="Go ahead with any exchange under $20" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={ids.path} className="block text-[13px] font-medium text-kumo-default">Amount in the terms</label>
          <input id={ids.path} className={field} placeholder="price_difference" spellCheck={false} value={path} onChange={(event) => setPath(event.target.value)} />
        </div>
        <div>
          <label htmlFor={ids.amount} className="block text-[13px] font-medium text-kumo-default">At most</label>
          <input id={ids.amount} className={field} inputMode="decimal" placeholder="20.00" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </div>
        <div>
          <label htmlFor={ids.currency} className="block text-[13px] font-medium text-kumo-default">Currency</label>
          <input id={ids.currency} className={field} maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={ids.account} className="block text-[13px] font-medium text-kumo-default">Account</label>
          <select id={ids.account} className={field} value={account} onChange={(event) => setAccount(event.target.value)}>
            <option value="">Any account, or signed out</option>
            {accounts.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={ids.budget} className="block text-[13px] font-medium text-kumo-default">In total at most <span className="font-normal text-kumo-subtle">(optional)</span></label>
          <input id={ids.budget} className={field} inputMode="decimal" placeholder="50.00" value={budget} onChange={(event) => setBudget(event.target.value)} />
        </div>
        <div>
          <label htmlFor={ids.days} className="block text-[13px] font-medium text-kumo-default">Over this many days</label>
          <input id={ids.days} className={field} inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} />
        </div>
      </div>
      <Action type="submit" variant="primary" disabled={!ready || !connected}>Add instruction</Action>
    </form>
  );
}
