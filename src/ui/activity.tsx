import { cn, Table } from "@cloudflare/kumo";
import { CaretRightIcon, ClockIcon, ListChecksIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { ActivityEntry, ActivityResult, ActivityTask } from "../poppy/wire";
import type { ActivityView, ProtocolView } from "../use-pi-session";
import { SendAction, type Send } from "./connection";
import { Action, EmptyState, PageHeader, Section, SkeletonRows, Truncated, useNow } from "./controls";
import { ACCESS, ago, countdown, DECIDED, fullDate, HOW, RESULT, when } from "./format";
import { activityGroups } from "./steps";
import { Status } from "./status";
import { PROTOCOL_LOG_LIMIT } from "../poppy/wire";
import { Diagnostics, ProtocolList } from "./protocol";

function Result({ result }: { result: ActivityResult }) {
  return <Status result={result} />;
}

/** What happened, with any quoted words and the outcome in the words of whoever wrote them. */
function What({ entry }: { entry: ActivityEntry }) {
  return (
    <div className="min-w-0 max-w-[60ch]">
      <p className="text-pretty break-words">
        {entry.what}
        {entry.quote ? <> “{entry.quote}”</> : null}
      </p>
      {entry.outcome ? (
        <p className="mt-0.5 text-[13px] text-pretty break-words text-kumo-subtle">
          {entry.outcomeBy === "company" ? `${entry.company} says: ` : ""}
          {entry.outcome}
        </p>
      ) : null}
      {entry.account ? <p className="mt-0.5 text-[13px] text-kumo-subtle">Account {entry.account}</p> : null}
    </div>
  );
}

/** How, with what access: "API · view and change access". */
function how(entry: ActivityEntry): string {
  const parts = [entry.how ? HOW[entry.how] : null, entry.access ? `${ACCESS[entry.access].toLowerCase()} access` : null].filter(Boolean);
  return parts.join(" · ");
}

function decided(entry: ActivityEntry): string {
  return entry.decidedBy ? DECIDED[entry.decidedBy] : "Not needed";
}

const STOP_LABEL: Record<ActivityTask["kind"], (task: ActivityTask) => string> = {
  conversation: () => "End conversation",
  device_sign_in: () => "Cancel sign-in",
  sign_out: () => "Try again",
  approval: () => "Stop"
};

function InProgress({ tasks, send }: { tasks: readonly ActivityTask[]; send: Send }) {
  const counting = tasks.some((task) => task.until !== undefined);
  const now = useNow(1000, counting);
  if (tasks.length === 0) {
    return (
      <EmptyState icon={<ClockIcon size={20} />} title="Nothing running">
        When your agent is waiting on a Company, following a conversation or waiting for a sign-in, it shows here.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline" aria-label="In progress">
      {tasks.map((task) => (
        <li key={task.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-base text-pretty break-words">
              {task.what}
              {task.quote ? <> “{task.quote}”</> : null}
            </p>
            <p className="mt-0.5 text-[13px] text-kumo-subtle tabular-nums">
              {task.note ? `${task.note} · ` : ""}
              {task.until !== undefined ? (
                <span title={fullDate(task.until)}>{task.until > now ? `Expires in ${countdown(task.until - now)}` : "Expired"}</span>
              ) : (
                <span title={fullDate(task.since)}>
                  {task.kind === "conversation" ? "Last heard" : "Started"} {ago(task.since, now)}
                </span>
              )}
            </p>
          </div>
          {task.stop ? (
            <SendAction send={send} frame={task.stop}>
              {STOP_LABEL[task.kind](task)}
            </SendAction>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Log({ entries }: { entries: readonly ActivityEntry[] }) {
  if (entries.length === 0) {
    return (
      <EmptyState icon={<ListChecksIcon size={20} />} title="Nothing yet">
        Everything your agent does at a Company is recorded here: what, how, who decided, and the result.
      </EmptyState>
    );
  }
  return (
    // A table on wide screens; on phones each row stacks: time, Company and result, then what happened.
    <div className="overflow-x-auto rounded-xl ring ring-kumo-hairline">
      <Table className="max-md:block">
        <Table.Header className="max-md:hidden">
          <Table.Row>
            <Table.Head className="w-24">Time</Table.Head>
            <Table.Head>Company</Table.Head>
            <Table.Head>What</Table.Head>
            <Table.Head className="max-md:hidden">How</Table.Head>
            <Table.Head className="max-lg:hidden">Decided by</Table.Head>
            <Table.Head>Result</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body className="max-md:block">
          {activityGroups(entries).map((group) =>
            group.kind === "entry" ? <LogRow key={group.entry.id} entry={group.entry} /> : <UploadRows key={group.entries[0]!.id} target={group.target} entries={group.entries} />
          )}
        </Table.Body>
      </Table>
    </div>
  );
}

function LogRow({ entry, nested = false }: { entry: ActivityEntry; nested?: boolean }) {
  return (
    <Table.Row className="max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:px-4 max-md:py-3">
      <Table.Cell className="align-top whitespace-nowrap tabular-nums text-kumo-subtle max-md:col-start-1 max-md:row-start-1 max-md:p-0!">
        <time dateTime={new Date(entry.at).toISOString()} title={fullDate(entry.at)}>
          {when(entry.at)}
        </time>
      </Table.Cell>
      <Table.Cell className="max-w-40 align-top max-md:col-start-2 max-md:row-start-1 max-md:max-w-none max-md:p-0! max-md:font-medium">
        {nested ? null : <Truncated text={entry.company} />}
      </Table.Cell>
      <Table.Cell className={cn("align-top max-md:col-span-3 max-md:row-start-2 max-md:p-0!", nested && "pl-8")}>
        <What entry={entry} />
        <p className="mt-0.5 text-[13px] text-kumo-subtle md:hidden">
          {how(entry)} · Decided by: {decided(entry)}
        </p>
      </Table.Cell>
      <Table.Cell className="align-top max-md:hidden">
        {entry.how ? HOW[entry.how] : null}
        {entry.access ? <span className="block text-[13px] whitespace-nowrap text-kumo-subtle">{ACCESS[entry.access].toLowerCase()} access</span> : null}
      </Table.Cell>
      <Table.Cell className={cn("align-top whitespace-nowrap max-lg:hidden", entry.decidedBy ? null : "text-kumo-subtle")}>{decided(entry)}</Table.Cell>
      <Table.Cell className="align-top max-md:col-start-3 max-md:row-start-1 max-md:p-0!">
        <Result result={entry.result} />
      </Table.Cell>
    </Table.Row>
  );
}

/** Photo uploads to one Company, one after another: one row, which opens to show each photo's own row. */
function UploadRows({ target, entries }: { target: string; entries: readonly ActivityEntry[] }) {
  const [open, setOpen] = useState(false);
  const first = entries[0]!;
  const counts = new Map<ActivityResult, number>();
  for (const entry of entries) counts.set(entry.result, (counts.get(entry.result) ?? 0) + 1);
  // The row's result is the one that most needs a look: anything not done before done.
  const worst = (["unknown", "failed", "waiting", "in_progress", "expired", "cancelled", "declined", "done"] as const).find((result) => counts.has(result))!;
  return (
    <>
      <Table.Row className="max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:px-4 max-md:py-3" data-uploads={entries.length}>
        <Table.Cell className="align-top whitespace-nowrap tabular-nums text-kumo-subtle max-md:col-start-1 max-md:row-start-1 max-md:p-0!">
          <time dateTime={new Date(first.at).toISOString()} title={fullDate(first.at)}>
            {when(first.at)}
          </time>
        </Table.Cell>
        <Table.Cell className="max-w-40 align-top max-md:col-start-2 max-md:row-start-1 max-md:max-w-none max-md:p-0! max-md:font-medium">
          <Truncated text={first.company} />
        </Table.Cell>
        <Table.Cell className="align-top max-md:col-span-3 max-md:row-start-2 max-md:p-0!">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-10 items-start gap-1.5 text-left">
            <CaretRightIcon size={16} aria-hidden className={cn("mt-1 shrink-0 text-kumo-subtle motion-safe:transition-transform", open && "rotate-90")} />
            <span className="min-w-0 text-pretty break-words">
              Asked you to approve sending {entries.length} photos to {target}
              <span className="block text-[13px] text-kumo-subtle">{[...counts.entries()].map(([result, count]) => `${count} ${RESULT[result].toLowerCase()}`).join(" · ")}</span>
            </span>
          </button>
        </Table.Cell>
        <Table.Cell className="align-top max-md:hidden">
          {first.how ? HOW[first.how] : null}
          {first.access ? <span className="block text-[13px] whitespace-nowrap text-kumo-subtle">{ACCESS[first.access].toLowerCase()} access</span> : null}
        </Table.Cell>
        <Table.Cell className={cn("align-top whitespace-nowrap max-lg:hidden", first.decidedBy ? null : "text-kumo-subtle")}>{decided(first)}</Table.Cell>
        <Table.Cell className="align-top max-md:col-start-3 max-md:row-start-1 max-md:p-0!">
          <Result result={worst} />
        </Table.Cell>
      </Table.Row>
      {open ? entries.map((entry) => <LogRow key={entry.id} entry={entry} nested />) : null}
    </>
  );
}

/**
 * Activity: what the agent is doing at Companies now, each with a way to stop
 * it where the protocol allows, and a log of everything it has done.
 */
export function ActivityPage({ activity, protocol, send, openProtocol = null }: { activity: ActivityView | null; protocol: ProtocolView; send: Send; openProtocol?: string | null }) {
  return (
    <div className="space-y-8">
      <PageHeader title="Activity" description="What your agent is doing at Companies, and everything it has done there." />
      <Section title="In progress">
        {activity ? <InProgress tasks={activity.inProgress} send={send} /> : <SkeletonRows rows={2} label="Loading what's in progress" />}
      </Section>
      <Section title="Log" description="Newest first. Kept after requests leave the chat.">
        {activity ? <Log entries={activity.log} /> : <SkeletonRows rows={4} label="Loading the log" />}
      </Section>
      <Section
        title="Protocol"
        description={`Each Poppy request your agent made to a Company, oldest first, with its spec section and what came back: the last ${PROTOCOL_LOG_LIMIT} per Company. Never headers, bodies, tokens, keys or codes.`}
      >
        <ProtocolList protocol={protocol} send={send} openDomain={openProtocol} />
      </Section>
      <Section
        title="Diagnostics"
        description="Export recent agent events or one action from the log. Per-action events survive unrelated activity; up to 50 flows are retained, with at most 200 events / 256 KiB each. Never bodies, signed URL queries or anything anyone said."
      >
        <Diagnostics diagnostics={protocol.diagnostics} send={send} flows={(activity?.log ?? []).filter(entry => entry.kind === "approval").map(entry => ({ id: entry.id.replace(/^approval-/, ""), label: `${entry.company} · ${entry.result} · ${entry.id.replace(/^approval-/, "")}` }))} />
      </Section>
    </div>
  );
}
