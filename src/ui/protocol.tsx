import { cn } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CopyIcon,
  DownloadSimpleIcon,
  InfoIcon,
  ProhibitIcon,
  TreeStructureIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { ProtocolCompany, ProtocolEntry, ProtocolOutcome } from "../poppy/wire";
import type { ProtocolLogView, ProtocolView } from "../use-pi-session";
import { useConnected, type Send } from "./connection";
import { Action, EmptyState, SkeletonRows } from "./controls";
import { fullDate, when } from "./format";

/**
 * The protocol view, inside Activity: for each Company, the Poppy exchanges
 * the agent made, in order, each with the section of the spec it follows,
 * for the spec's authors and other implementers. Each Company's log comes
 * from the agent when its disclosure opens, and again whenever it grows.
 * It can be copied or downloaded as plain text for an interop report.
 */

const OUTCOME: Record<ProtocolOutcome, { label: string; className: string; icon: ReactNode }> = {
  ok: { label: "OK", className: "text-kumo-success", icon: <CheckCircleIcon size={16} aria-hidden /> },
  error: { label: "Error", className: "text-kumo-danger", icon: <WarningCircleIcon size={16} aria-hidden /> },
  retry: { label: "Sent again", className: "text-kumo-warning", icon: <ArrowClockwiseIcon size={16} aria-hidden /> },
  failed: { label: "No answer", className: "text-kumo-danger", icon: <WarningCircleIcon size={16} aria-hidden /> },
  refused: { label: "Refused by us", className: "text-kumo-danger", icon: <ProhibitIcon size={16} aria-hidden /> },
  info: { label: "State", className: "text-kumo-subtle", icon: <InfoIcon size={16} aria-hidden /> }
};

/** "14:05:09.123": a protocol log needs seconds. */
function clock(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${time}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * A Company's log as plain text, oldest first: the same allowlisted fields
 * the page shows, one exchange per line, with UTC times, for an interop report.
 */
export function protocolText(log: ProtocolLogView, exportedAt = Date.now()): string {
  const head = [
    `Poppy protocol log: ${log.company}${log.domain && log.domain !== log.company ? ` (${log.domain})` : ""}`,
    ...(log.issuer ? [`Issuer: ${log.issuer}`] : []),
    `Exported: ${new Date(exportedAt).toISOString()}; ${log.entries.length} entr${log.entries.length === 1 ? "y" : "ies"}, oldest first; times in UTC`,
    "Recorded: time, spec section, method, URL (origin and path), status, error code, what was sent and what came back.",
    "Never recorded: headers, bodies, tokens, assertions, DPoP proofs, keys, codes, state, verifiers, sign-in values, query strings.",
    ""
  ];
  const lines = log.entries.map((entry) =>
    [
      new Date(entry.at).toISOString(),
      `${entry.section} ${entry.title}`,
      [entry.method, entry.url].filter(Boolean).join(" ") || "-",
      entry.summary,
      `-> ${entry.result} [${entry.outcome}]`
    ].join(" | ")
  );
  return `${[...head, ...lines].join("\n")}\n`;
}

/** A file name for the download: the Company's domain or key, and the date. */
function fileName(log: ProtocolLogView): string {
  const name = (log.domain ?? log.key).replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-|-$/g, "");
  return `poppy-protocol-${name || "company"}-${new Date().toISOString().slice(0, 10)}.txt`;
}

function Outcome({ outcome }: { outcome: ProtocolOutcome }) {
  const style = OUTCOME[outcome];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]", style.className)}>
      {style.icon}
      {style.label}
    </span>
  );
}

function Entry({ entry }: { entry: ProtocolEntry }) {
  return (
    // On phones: time and outcome on one line, the rest below; wider, four columns.
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 md:grid-cols-[6.5rem_9.5rem_minmax(0,1fr)_auto]">
      <time dateTime={new Date(entry.at).toISOString()} title={fullDate(entry.at)} className="col-start-1 row-start-1 text-[13px] tabular-nums text-kumo-subtle">
        {clock(entry.at)}
      </time>
      <span className="col-start-2 row-start-1 min-w-0 text-[13px] font-medium text-kumo-default">
        <span className="tabular-nums">{entry.section}</span> {entry.title}
      </span>
      <div className="col-span-3 row-start-2 min-w-0 md:col-span-1 md:col-start-3 md:row-start-1">
        <p className="text-pretty break-words">{entry.summary}</p>
        {entry.method || entry.url ? (
          <p className="mt-0.5 font-mono text-[12px] break-all text-kumo-subtle">{[entry.method, entry.url].filter(Boolean).join(" ")}</p>
        ) : null}
        <p className="mt-0.5 text-[13px] text-pretty break-words text-kumo-subtle">→ {entry.result}</p>
      </div>
      <span className="col-start-3 row-start-1 justify-self-end md:col-start-4">
        <Outcome outcome={entry.outcome} />
      </span>
    </li>
  );
}

/** Copy and download: what a person filing an interop report needs. */
function Export({ log }: { log: ProtocolLogView }) {
  const [said, setSaid] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(protocolText(log));
      setSaid("Copied as text.");
    } catch {
      setSaid("Couldn't copy here; use Download instead.");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([protocolText(log)], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName(log);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setSaid("Downloaded.");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
      <Action variant="secondary" icon={<CopyIcon size={16} aria-hidden />} onClick={() => void copy()}>
        Copy as text
      </Action>
      <Action variant="secondary" icon={<DownloadSimpleIcon size={16} aria-hidden />} onClick={download}>
        Download .txt
      </Action>
      <span role="status" className="text-[13px] text-kumo-subtle">
        {said}
      </span>
    </div>
  );
}

function CompanyProtocol({ company, log, send }: { company: ProtocolCompany; log: ProtocolLogView | undefined; send: Send }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const connected = useConnected();
  // Ask when opened, again whenever the log grows while it's open, and again on reconnecting: a request while disconnected doesn't go.
  useEffect(() => {
    if (open && connected) send({ type: "poppy.protocol", key: company.key });
  }, [open, connected, company.key, company.lastSeq, send]);
  const name = `${company.company}${company.domain && company.domain !== company.company ? ` (${company.domain})` : ""}`;
  return (
    <li>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
        >
          <CaretRightIcon size={16} aria-hidden className={cn("shrink-0 text-kumo-subtle motion-safe:transition-transform", open && "rotate-90")} />
          <span className="min-w-0 flex-1">
            <span className="block font-medium break-words text-kumo-default">Protocol · {name}</span>
            <span className="block text-[13px] text-kumo-subtle tabular-nums">
              {company.count} {company.count === 1 ? "exchange" : "exchanges"} · last <span title={fullDate(company.lastAt)}>{when(company.lastAt)}</span>
            </span>
          </span>
        </button>
      </h3>
      {open ? (
        <div id={panel} className="border-t border-kumo-hairline">
          {log ? (
            <>
              <Export log={log} />
              <ol aria-label={`Protocol exchanges with ${company.company}, oldest first`} className="divide-y divide-kumo-hairline border-t border-kumo-hairline">
                {log.entries.map((entry) => (
                  <Entry key={entry.seq} entry={entry} />
                ))}
              </ol>
            </>
          ) : (
            <div className="p-4">
              <SkeletonRows rows={2} label={`Loading the protocol log for ${company.company}`} />
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** A file name for the diagnostics download: the date and time it was made. */
function diagnosticsFileName(at: number): string {
  return `agent-diagnostics-${new Date(at).toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
}

/**
 * "Copy diagnostics": the agent's newest events (src/agent-log.ts) and every
 * Company's protocol log, as text a User can hand the operator, who then
 * needs no access to the logs. Asked for when Activity opens, so the copy is
 * ready when the button is pressed, and again after each copy.
 */
export function Diagnostics({ diagnostics, send }: { diagnostics: ProtocolView["diagnostics"]; send: Send }) {
  const [said, setSaid] = useState("");
  const connected = useConnected();
  useEffect(() => {
    if (connected) send({ type: "poppy.diagnostics" });
  }, [connected, send]);
  const copy = async () => {
    if (!diagnostics) {
      send({ type: "poppy.diagnostics" });
      setSaid("Still getting them from your agent; try again in a moment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(diagnostics.text);
      setSaid("Copied. Paste them into your message to the operator.");
    } catch {
      setSaid("Couldn't copy here; use Download instead.");
    }
    send({ type: "poppy.diagnostics" });
  };
  const download = () => {
    if (!diagnostics) return;
    const url = URL.createObjectURL(new Blob([diagnostics.text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = diagnosticsFileName(diagnostics.at);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setSaid("Downloaded.");
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Action variant="secondary" icon={<CopyIcon size={16} aria-hidden />} onClick={() => void copy()}>
        Copy diagnostics
      </Action>
      <Action variant="secondary" icon={<DownloadSimpleIcon size={16} aria-hidden />} onClick={download} disabled={!diagnostics}>
        Download diagnostics
      </Action>
      <span role="status" className="text-[13px] text-kumo-subtle">
        {said}
      </span>
    </div>
  );
}

/** Every Company's protocol log, each behind its own disclosure. */
export function ProtocolList({ protocol, send }: { protocol: ProtocolView; send: Send }) {
  if (protocol.companies === null) return <SkeletonRows rows={1} label="Loading the protocol view" />;
  if (protocol.companies.length === 0) {
    return (
      <EmptyState icon={<TreeStructureIcon size={20} />} title="No exchanges yet">
        Once your agent finds a Company, every Poppy request it makes there is listed here, with its spec section and result.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline" aria-label="Protocol logs by Company">
      {protocol.companies.map((company) => (
        <CompanyProtocol key={company.key} company={company} log={protocol.logs[company.key]} send={send} />
      ))}
    </ul>
  );
}
