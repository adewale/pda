import { cn } from "@cloudflare/kumo";
import {
  AlarmIcon,
  ArrowClockwiseIcon,
  CalculatorIcon,
  CaretRightIcon,
  ChatsIcon,
  ClockIcon,
  FileTextIcon,
  GlobeIcon,
  InfoIcon,
  NotebookIcon,
  PlugsConnectedIcon,
  SignInIcon,
  StorefrontIcon,
  WrenchIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { TranscriptMessage, TranscriptPart } from "../protocol";
import { AttachmentThumb, splitMarkers } from "./attachments";
import { Action } from "./controls";
import { SUMMARY_NOTICE } from "./history";
import type { ActivityResult } from "../poppy/wire";
import { RESULT } from "./format";
import { redactQueries } from "./result-facts";
import { isPlainClick } from "./route";
import { Status } from "./status";
import type { ApprovalStep, stepDecisions } from "./steps";
import { companyNames, describeToolCall, proposedBy, type ToolDecision, type ToolHow, type ToolLine, type ToolOutcome } from "./tool-line";

/** An image the page may load: `data:`, or this origin's own. */
function isOwnImage(src: string): boolean {
  if (!src) return false;
  if (/^data:image\//i.test(src)) return true;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Images in what the model writes, markdown or HTML, load only from this
 * origin or `data:`. Any other image would make the browser fetch a URL the
 * model chose, carrying whatever the model put in it (a prompt injection's
 * way out), so it becomes a link the User can choose to follow. The
 * Content-Security-Policy (`src/csp.ts`) refuses such loads too.
 */
function ModelImage({ src, alt, node: _node, ...rest }: ComponentProps<"img"> & { node?: unknown }) {
  const url = typeof src === "string" ? src : "";
  if (isOwnImage(url)) return <img src={url} alt={alt ?? ""} {...rest} />;
  const label = alt ? `Image: ${alt}` : "Image";
  if (!/^https?:\/\//i.test(url)) return <span className="text-kumo-subtle">[{label}]</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" title={url}>
      [{label}]
    </a>
  );
}

/** What Streamdown renders for elements that would load something: images by `ModelImage`, and no `<source>` (a `<picture>`'s other images). */
const MODEL_COMPONENTS = { img: ModelImage, source: () => null };

type ToolCall = Extract<TranscriptPart, { type: "tool-call" }>;
type ToolResult = Extract<TranscriptPart, { type: "tool-result" }>;

function resultText(part: ToolResult): string {
  return part.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n");
}

function outcomeOf(part: ToolResult | undefined): ToolOutcome | undefined {
  if (!part) return undefined;
  return { error: part.error, ...(part.details !== undefined ? { details: part.details } : {}), text: resultText(part) };
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-[13px] font-medium text-kumo-subtle">{label}</p>
      <pre className="max-h-60 overflow-auto rounded-lg bg-kumo-recessed p-3 font-mono text-[13px] leading-5 break-words whitespace-pre-wrap">
        {redactQueries(typeof value === "string" ? value : JSON.stringify(value, null, 2))}
      </pre>
    </div>
  );
}

const HOW_ICON: Record<ToolHow, ReactNode> = {
  API: <PlugsConnectedIcon size={16} />,
  "their agent": <ChatsIcon size={16} />,
  website: <GlobeIcon size={16} />,
  "sign-in": <SignInIcon size={16} />,
  "web page": <FileTextIcon size={16} />,
  memory: <NotebookIcon size={16} />,
  clock: <ClockIcon size={16} />,
  calculator: <CalculatorIcon size={16} />,
  schedule: <AlarmIcon size={16} />
};

/** A step's state in the shared words (src/ui/status.tsx); null for one that simply finished, which needs no word. */
function stepResult(line: ToolLine, decision: ToolDecision | undefined): ActivityResult | null {
  if (decision) return decision.result;
  switch (line.state) {
    case "running":
      return "in_progress";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "done":
      return null;
  }
}

type Step = {
  readonly call: ToolCall | undefined;
  readonly result: ToolResult | undefined;
  readonly line: ToolLine | null;
  readonly name: string;
  readonly running: boolean;
  readonly domain: string | null;
  readonly approval: ApprovalStep | undefined;
  readonly status: ActivityResult | null;
};

/** What the transcript needs to know about requests the agent put on cards. */
export type StepContext = {
  readonly decisions: ReturnType<typeof stepDecisions>;
  readonly companies: ReadonlyMap<string, string>;
  readonly onRetry?: ((text: string) => void) | undefined;
  readonly onProtocol?: ((domain: string) => void) | undefined;
};

function stepOf(call: ToolCall | undefined, result: ToolResult | undefined, running: boolean, context: StepContext): Step {
  const name = call?.name ?? result?.name ?? "tool";
  const outcome = outcomeOf(result);
  const proposed = proposedBy(outcome);
  const approval = proposed && "approvalId" in proposed ? context.decisions.approvals.get(proposed.approvalId) : undefined;
  const decision: ToolDecision | undefined = approval ?? (proposed && "operationId" in proposed ? context.decisions.operation(proposed.operationId) : undefined);
  const line = describeToolCall(name, call?.arguments ?? {}, outcome ?? (running ? undefined : { error: false }), context.companies, decision);
  const args = call?.arguments;
  const domain = args && typeof args === "object" && "domain" in args && typeof args.domain === "string" ? args.domain : null;
  return { call, result, line, name, running, domain, approval, status: line ? stepResult(line, decision) : null };
}

/** The raw call and its result, behind a disclosure: URLs without their queries, and a way to the Company's protocol log. */
function Details({ call, result, domain, company, onProtocol }: { call: ToolCall | undefined; result: ToolResult | undefined; domain: string | null; company: string | null; onProtocol?: ((domain: string) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const images = result?.content.filter((content) => content.type === "image") ?? [];
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="-my-2.5 inline-flex min-h-10 shrink-0 items-center rounded-md px-2 text-[13px] font-medium text-kumo-link underline-offset-4 hover:underline"
      >
        Details
      </button>
      {open ? (
        <div id={id} className="basis-full space-y-3 pt-2 pl-6">
          {call ? <JsonBlock label="Arguments" value={call.arguments} /> : null}
          {result ? <JsonBlock label={result.error ? "Error" : "Result"} value={resultText(result) || "(no text)"} /> : <p className="text-[13px] text-kumo-subtle">No result yet.</p>}
          {result?.details !== undefined && result.details !== null && !result.name.startsWith("poppy_") ? <JsonBlock label="Details" value={result.details} /> : null}
          {images.map((image, index) =>
            image.type === "image" ? (
              <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`${result!.name} output ${index + 1}`} className="image-outline max-w-full rounded-lg" />
            ) : null
          )}
          {domain && onProtocol ? (
            <a
              href={`/activity?company=${encodeURIComponent(domain)}`}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onProtocol(domain);
              }}
              className="inline-flex min-h-10 items-center text-[13px] font-medium text-kumo-link underline underline-offset-4"
            >
              See every exchange with {company ?? domain} in Activity
            </a>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** A step's photos, small, so the same picture marks the same photo here, on its card and in the message that sent it. */
function StepPhotos({ photos }: { photos: ApprovalStep["attachments"] }) {
  if (photos.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {photos.slice(0, 8).map((photo) => (
        <img key={photo.id} src={`/api/attachments/${encodeURIComponent(photo.id)}`} alt={photo.name} title={photo.name} loading="lazy" className="image-outline size-6 rounded object-cover" />
      ))}
    </span>
  );
}

/**
 * One step: what the agent did, where and how, and how it stands. A request
 * the User decided shows its outcome here, where it was asked for, with the
 * Company's status code and a few facts from its answer; the raw call and
 * result are behind Details.
 */
function StepLine({ step, context }: { step: Step; context: StepContext }) {
  const { line, call, result, approval, status } = step;
  if (!line) return <ToolCard name={step.name} call={call} result={result} running={step.running} />;
  const company = step.domain ? (context.companies.get(step.domain.toLowerCase()) ?? approval?.company ?? null) : (approval?.company ?? null);
  const meta = [line.how, line.access ? `${line.access} access` : null].filter(Boolean).join(" · ");
  const detail = approval?.httpStatus ? `${approval.httpStatus}${approval.code ? ` ${approval.code}` : ""}` : null;
  const retry =
    approval && approval.result === "failed" && approval.photos?.length && context.onRetry && company
      ? `Please try sending ${approval.photos.map((photo) => `“${photo}”`).join(", ")} to ${company} again.`
      : null;
  return (
    <div className="flex flex-wrap items-start gap-x-2 text-[13px]" data-tool={call?.name ?? result?.name} data-status={status ?? "done"}>
      <span aria-hidden className="mt-0.5 shrink-0 text-kumo-subtle">
        {line.how ? HOW_ICON[line.how] : <StorefrontIcon size={16} />}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-pretty break-words">
          <span className="text-kumo-default">{line.text}</span>
          {line.quote ? <span className="text-kumo-default"> “{line.quote}”</span> : null}
          {meta ? <span className="text-kumo-subtle"> · {meta}</span> : null}
        </p>
        {status || approval?.attachments.length ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {status ? <Status result={status} detail={detail} className="font-medium" /> : null}
            <StepPhotos photos={approval?.attachments ?? []} />
            {approval?.facts.length ? <span className="min-w-0 break-words text-kumo-subtle tabular-nums">{approval.facts.join(" · ")}</span> : null}
            {retry ? (
              <button type="button" onClick={() => context.onRetry!(retry)} className="inline-flex min-h-10 items-center gap-1 font-medium text-kumo-link underline underline-offset-4">
                <ArrowClockwiseIcon size={14} aria-hidden />
                Ask your agent to try again
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Details call={call} result={result} domain={step.domain} company={company} onProtocol={context.onProtocol} />
    </div>
  );
}

/** Any other tool: a compact card with its name and state. */
function ToolCard({ name, call, result, running }: { name: string; call: ToolCall | undefined; result: ToolResult | undefined; running: boolean }) {
  const status: ActivityResult | null = result ? (result.error ? "failed" : null) : running ? "in_progress" : null;
  return (
    <div className="flex flex-wrap items-start gap-x-2 rounded-xl px-3 py-2 text-[13px] ring ring-kumo-hairline" data-tool={name}>
      <span aria-hidden className="mt-0.5 shrink-0 text-kumo-subtle">
        <WrenchIcon size={16} />
      </span>
      <p className="min-w-0 flex-1">
        <code className="font-mono">{name}</code>
        {status ? <> · <Status result={status} /></> : <span className="text-kumo-subtle">{result ? " · Done" : " · No result"}</span>}
      </p>
      <Details call={call} result={result} domain={null} company={null} />
    </div>
  );
}

/** How many steps stand where: "2 failed", "1 waiting for you". */
function tally(steps: readonly Step[]): string {
  const counts = new Map<ActivityResult, number>();
  for (const step of steps) if (step.status && step.status !== "done") counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  return [...counts.entries()].map(([result, count]) => `${count} ${RESULT[result].toLowerCase()}`).join(" · ");
}

/** One line for several steps in a row: the photos sent to one Company, or the steps and where they ran. */
function runSummary(steps: readonly Step[], companies: ReadonlyMap<string, string>): string {
  const domains = [...new Set(steps.map((step) => step.domain).filter((domain): domain is string => domain !== null))];
  const names = domains.map((domain) => companies.get(domain.toLowerCase()) ?? domain);
  const uploads = steps.every((step) => step.name === "poppy_api_call" && step.call && typeof step.call.arguments === "object" && step.call.arguments !== null && "files" in step.call.arguments);
  if (uploads && names.length === 1) {
    const photos = steps.length;
    const sent = steps.filter((step) => step.status === "done").length;
    if (steps.every((step) => step.status === "waiting")) return `Asked you to approve sending ${photos} photos to ${names[0]}`;
    return `Sent ${sent} of ${photos} photos to ${names[0]}`;
  }
  return `${steps.length} steps${names.length ? ` at ${names.join(", ")}` : ""}`;
}

/** Two steps in a row read fine as two lines; three or more fold into one. */
const RUN_FOLDS_AT = 3;

/**
 * Steps the agent took one after another, as one line that opens to show
 * each. Open by itself while any is working, waiting for the User, failed
 * or unknown; folded once all are done, unless the User opened it.
 */
function StepRun({ steps, context }: { steps: readonly Step[]; context: StepContext }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const id = useId();
  if (steps.length < RUN_FOLDS_AT) {
    return (
      <div className="space-y-1">
        {steps.map((step, index) => (
          <StepLine key={step.call?.id ?? step.result?.id ?? index} step={step} context={context} />
        ))}
      </div>
    );
  }
  const attention = steps.some((step) => step.running || (step.status !== null && step.status !== "done" && step.status !== "declined"));
  const open = chosen ?? attention;
  const first = steps.find((step) => step.line?.how)?.line?.how;
  const counts = tally(steps);
  return (
    <div className="text-[13px]" data-steps={steps.length}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setChosen(!open)}
        className="flex min-h-10 w-full items-start gap-2 rounded-md text-left"
      >
        <span aria-hidden className="mt-0.5 shrink-0 text-kumo-subtle">
          {first ? HOW_ICON[first] : <StorefrontIcon size={16} />}
        </span>
        <span className="min-w-0 flex-1 text-pretty">
          <span className="text-kumo-default">{runSummary(steps, context.companies)}</span>
          {counts ? <span className="text-kumo-subtle"> · {counts}</span> : null}
        </span>
        <CaretRightIcon size={16} aria-hidden className={cn("mt-0.5 shrink-0 text-kumo-subtle motion-safe:transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div id={id} className="mt-1 space-y-1 border-l border-kumo-hairline pl-4">
          {steps.map((step, index) => (
            <StepLine key={step.call?.id ?? step.result?.id ?? index} step={step} context={context} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function UserMessage({ message }: { message: TranscriptMessage }) {
  // Photos the User attached are named by markers in the text (src/attachments.ts): show the photos, not the markers.
  const { text, photos } = splitMarkers(message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));
  return (
    <div className="flex flex-col items-end gap-2">
      {photos.length ? (
        <div className="flex max-w-[min(85%,70ch)] flex-wrap justify-end gap-2">
          {photos.map((photo) => (
            <AttachmentThumb key={photo.id} id={photo.id} name={photo.name} detail={photo.size} />
          ))}
        </div>
      ) : null}
      {text ? (
        <div className="max-w-[min(85%,70ch)] rounded-xl bg-kumo-recessed px-4 py-2.5 text-base leading-7 text-pretty break-words whitespace-pre-wrap text-kumo-default">
          {text}
        </div>
      ) : null}
    </div>
  );
}

function Notice({ message }: { message: TranscriptMessage }) {
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  return text ? (
    <p className="flex items-start gap-2 text-[13px] text-kumo-subtle">
      <InfoIcon size={16} aria-hidden className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 text-pretty">{text}</span>
    </p>
  ) : null;
}

/**
 * What the agent's own code told the model, which pi keeps as a user
 * message: a `[system]` note (an approval's outcome, a Company's message) or
 * a scheduled task's run. Never the User's bubble. Its first sentence shows;
 * the rest, with any URL's query taken out, is behind Details.
 */
export function agentNotice(text: string): { label: string; summary: string; full: string } | null {
  if (text.startsWith("[system]")) {
    const body = text.slice("[system]".length).trim();
    const first = (body.split("\n")[0] ?? "").split(/ Result: /)[0]!;
    return { label: "Your agent was told", summary: clipText(redactQueries(first), 160), full: redactQueries(body) };
  }
  const scheduled = /^\[(scheduled task you set on [^\]]+)\]\s*/.exec(text);
  if (scheduled) {
    const body = text.slice(scheduled[0].length);
    return { label: `A ${scheduled[1]} ran`, summary: clipText(body, 160), full: body };
  }
  return null;
}

function clipText(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function AgentNotice({ notice }: { notice: NonNullable<ReturnType<typeof agentNotice>> }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const more = notice.full.replace(/\s+/g, " ").trim() !== notice.summary;
  return (
    <div className="flex flex-wrap items-start gap-x-2 text-[13px] text-kumo-subtle" data-notice>
      <InfoIcon size={16} aria-hidden className="mt-0.5 shrink-0" />
      <p className="min-w-0 flex-1 text-pretty break-words">
        <span className="font-medium">{notice.label}:</span> {notice.summary}
      </p>
      {more ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className="-my-2.5 inline-flex min-h-10 shrink-0 items-center rounded-md px-2 font-medium text-kumo-link underline-offset-4 hover:underline"
        >
          Details
        </button>
      ) : null}
      {open ? (
        <pre id={id} className="mt-2 max-h-60 basis-full overflow-auto rounded-lg bg-kumo-recessed p-3 font-mono leading-5 break-words whitespace-pre-wrap text-kumo-default">
          {notice.full}
        </pre>
      ) : null}
    </div>
  );
}

/** pi's summary, without the wrapper pi puts round it for the model. */
function summaryText(message: TranscriptMessage): string {
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  const inner = /<summary>\n?([\s\S]*?)\n?<\/summary>\s*$/.exec(text);
  return (inner ? inner[1]! : text).trim();
}

/**
 * Where the agent's earlier conversation was summarised: a notice, not a
 * message from the person, though pi gives the model the summary as one.
 * The messages before it stay above it; the summary is behind a disclosure.
 */
function SummaryNotice({ message }: { message: TranscriptMessage }) {
  const text = summaryText(message);
  return (
    <div className="flex items-start gap-2 text-[13px] text-kumo-subtle" data-summary>
      <InfoIcon size={16} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
      <p>{SUMMARY_NOTICE}</p>
      {text ? (
        <details className="max-w-[70ch]">
          <summary className="inline-flex min-h-10 cursor-pointer items-center rounded-md font-medium">What your agent kept</summary>
          <p className="mt-1 whitespace-pre-wrap">{text}</p>
        </details>
      ) : null}
      </div>
    </div>
  );
}

/** Something that happened beside the conversation, such as an order's outcome, placed by its time. */
export type TimelineEvent = { readonly key: string; readonly at: number; readonly node: ReactNode };

/** The thinking of each turn (the run of answers after one message), shown once, where it starts. */
function thinkingByTurn(messages: readonly TranscriptMessage[]): Map<string, string[]> {
  const turns = new Map<string, string[]>();
  let first: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      first = null;
      continue;
    }
    if (message.role !== "assistant") continue;
    const thoughts = message.parts.flatMap((part) => (part.type === "thinking" && part.text ? [part.text] : []));
    if (thoughts.length === 0) continue;
    if (first === null) {
      first = message.id;
      turns.set(first, []);
    }
    turns.get(first)!.push(...thoughts);
  }
  return turns;
}

/**
 * The conversation: the person's messages, the agent's answers, and one line
 * per thing the agent did at a Company, several in a row folded into one.
 * Tool calls are paired with their results by id, so each call is one line
 * wherever its result arrives; a request the User decided shows its outcome
 * on that line. `events` (an order's outcome, a notice) go in by time.
 * `summaries` names the messages that are summaries of earlier conversation.
 */
export function Transcript({
  messages,
  live,
  runningTools,
  onRetry,
  summaries,
  decisions,
  events = [],
  onProtocol
}: {
  messages: readonly TranscriptMessage[];
  live: TranscriptMessage | null;
  runningTools: readonly string[];
  onRetry?: (text: string) => void;
  summaries?: ReadonlySet<string>;
  decisions?: ReturnType<typeof stepDecisions>;
  events?: readonly TimelineEvent[];
  onProtocol?: (domain: string) => void;
}) {
  const all = useMemo(() => (live ? [...messages, live] : messages), [messages, live]);
  const { results, called, companies } = useMemo(() => {
    const results = new Map<string, ToolResult>();
    const called = new Set<string>();
    for (const message of all) {
      for (const part of message.parts) {
        if (part.type === "tool-result") results.set(part.id, part);
        if (part.type === "tool-call") called.add(part.id);
      }
    }
    return { results, called, companies: companyNames(results.values()) };
  }, [all]);
  const thinking = useMemo(() => thinkingByTurn(all), [all]);
  const context: StepContext = { decisions: decisions ?? NO_DECISIONS, companies, onRetry, onProtocol };
  const pending = [...events].sort((a, b) => a.at - b.at);

  let lastUserText = "";
  const items: ReactNode[] = [];
  const eventsUpTo = (at: number) => {
    while (pending.length && pending[0]!.at <= at) {
      const event = pending.shift()!;
      items.push(<div key={`event-${event.key}`}>{event.node}</div>);
    }
  };
  for (const message of all) {
    if (message !== live) eventsUpTo(message.timestamp);
    items.push(renderMessage(message));
  }
  eventsUpTo(Number.POSITIVE_INFINITY);
  return <div className="space-y-6">{items}</div>;

  function renderMessage(message: TranscriptMessage): ReactNode {
    switch (message.role) {
      case "user": {
        if (summaries?.has(message.id)) return <SummaryNotice key={message.id} message={message} />;
        const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
        const notice = agentNotice(text);
        if (notice) return <AgentNotice key={message.id} notice={notice} />;
        lastUserText = text;
        return <UserMessage key={message.id} message={message} />;
      }
      case "notice":
        return <Notice key={message.id} message={message} />;
      case "tool": {
        const orphans = message.parts.filter((part): part is ToolResult => part.type === "tool-result" && !called.has(part.id));
        if (orphans.length === 0) return null;
        return <StepRun key={message.id} steps={orphans.map((part) => stepOf(undefined, part, false, context))} context={context} />;
      }
      case "assistant": {
        const retryText = lastUserText;
        const streaming = message === live;
        const blocks: ReactNode[] = [];
        let run: ToolCall[] = [];
        const flush = () => {
          if (run.length === 0) return;
          const steps = run.map((part) => stepOf(part, results.get(part.id), streaming || runningTools.includes(part.name), context));
          blocks.push(<StepRun key={run[0]!.id} steps={steps} context={context} />);
          run = [];
        };
        message.parts.forEach((part, index) => {
          if (part.type === "tool-call") {
            run.push(part);
            return;
          }
          flush();
          switch (part.type) {
            case "text":
              if (part.text)
                blocks.push(
                  <Streamdown key={index} className="sd-theme text-base leading-7 text-pretty" plugins={{ code }} controls={false} components={MODEL_COMPONENTS}>
                    {part.text}
                  </Streamdown>
                );
              return;
            case "thinking": {
              // One disclosure for a turn's thinking, where it starts; later answers in the turn add to it.
              const turn = thinking.get(message.id);
              if (!turn || message.parts.findIndex((item) => item.type === "thinking") !== index) return;
              blocks.push(
                <details key={index} className="text-[13px] text-kumo-subtle">
                  <summary className="inline-flex min-h-10 cursor-pointer items-center rounded-md font-medium">Thinking</summary>
                  {turn.map((text, n) => (
                    <p key={n} className="mt-1 whitespace-pre-wrap">
                      {text}
                    </p>
                  ))}
                </details>
              );
              return;
            }
            case "tool-result":
              blocks.push(<StepLine key={part.id} step={stepOf(undefined, part, false, context)} context={context} />);
              return;
            case "image":
              blocks.push(<img key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="" className="image-outline max-w-full rounded-lg" />);
              return;
          }
        });
        flush();
        if (blocks.length === 0 && !message.error) return null;
        return (
          <div key={message.id} className="max-w-[70ch] space-y-3">
            {blocks}
            {message.error ? (
              <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-kumo-danger-tint px-4 py-3">
                <p className="min-w-0 flex-1 text-base text-pretty text-kumo-danger">
                  Your agent couldn't finish this answer: {message.error}
                </p>
                {onRetry && retryText ? (
                  <Action variant="secondary" icon={<ArrowClockwiseIcon size={16} aria-hidden />} onClick={() => onRetry(retryText)}>
                    Send again
                  </Action>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      }
    }
  }
}

const NO_DECISIONS: ReturnType<typeof stepDecisions> = { approvals: new Map(), operation: () => undefined };
