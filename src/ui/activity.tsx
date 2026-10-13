import { cn, Table } from "@cloudflare/kumo";
import { CheckCircleIcon, CircleIcon, ClockIcon, HourglassIcon, ListChecksIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ActivityEntry, ActivityResult, ActivityTask, PoppyClientFrame } from "../poppy/wire";
import type { ActivityView, ProtocolView } from "../use-pi-session";
import { Action, EmptyState, PageHeader, Section, SkeletonRows, Truncated, useNow } from "./controls";
import { ACCESS, ago, countdown, DECIDED, fullDate, HOW, RESULT, when } from "./format";
import { PROTOCOL_LOG_LIMIT } from "../poppy/wire";
import { Diagnostics, ProtocolList } from "./protocol";

type Send = (frame: PoppyClientFrame) => void;

const RESULT_STYLE: Record<ActivityResult, { className: string; icon: ReactNode }> = {
  waiting: { className: "text-kumo-warning", icon: <HourglassIcon size={16} aria-hidden /> },
  in_progress: { className: "text-kumo-default", icon: <ClockIcon size={16} aria-hidden /> },
  done: { className: "text-kumo-success", icon: <CheckCircleIcon size={16} aria-hidden /> },
  declined: { className: "text-kumo-subtle", icon: <CircleIcon size={16} aria-hidden /> },
  cancelled: { className: "text-kumo-subtle", icon: <CircleIcon size={16} aria-hidden /> },
  expired: { className: "text-kumo-subtle", icon: <CircleIcon size={16} aria-hidden /> },
  failed: { className: "text-kumo-danger", icon: <WarningCircleIcon size={16} aria-hidden /> },
  unknown: { className: "text-kumo-danger", icon: <WarningCircleIcon size={16} aria-hidden /> }
};

function Result({ result }: { result: ActivityResult }) {
  const style = RESULT_STYLE[result];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", style.className)}>
      {style.icon}
      {RESULT[result]}
    </span>
  );
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
  operation: (task) => `Ask ${task.company} to stop`,
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
            <Action variant="secondary" onClick={() => send(task.stop!)}>
              {STOP_LABEL[task.kind](task)}
            </Action>
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
          {entries.map((entry) => (
            <Table.Row key={entry.id} className="max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:px-4 max-md:py-3">
              <Table.Cell className="align-top whitespace-nowrap tabular-nums text-kumo-subtle max-md:col-start-1 max-md:row-start-1 max-md:p-0!">
                <time dateTime={new Date(entry.at).toISOString()} title={fullDate(entry.at)}>
                  {when(entry.at)}
                </time>
              </Table.Cell>
              <Table.Cell className="max-w-40 align-top max-md:col-start-2 max-md:row-start-1 max-md:max-w-none max-md:p-0! max-md:font-medium">
                <Truncated text={entry.company} />
              </Table.Cell>
              <Table.Cell className="align-top max-md:col-span-3 max-md:row-start-2 max-md:p-0!">
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
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

/**
 * Activity: what the agent is doing at Companies now, each with a way to stop
 * it where the protocol allows, and a log of everything it has done.
 */
export function ActivityPage({ activity, protocol, send }: { activity: ActivityView | null; protocol: ProtocolView; send: Send }) {
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
        <ProtocolList protocol={protocol} send={send} />
      </Section>
      <Section
        title="Diagnostics"
        description="For the operator, when something went wrong: your agent's last 200 events (when and how it worked, which Companies and tools, model usage and cost) and the protocol log above, as text. Never what you, your agent or anyone else said."
      >
        <Diagnostics diagnostics={protocol.diagnostics} send={send} />
      </Section>
    </div>
  );
}
