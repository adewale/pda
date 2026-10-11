import { cn } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  ChatsIcon,
  GlobeIcon,
  HourglassIcon,
  PlugsConnectedIcon,
  SignInIcon,
  StorefrontIcon,
  WarningCircleIcon,
  WrenchIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { TranscriptMessage, TranscriptPart } from "../protocol";
import { Action } from "./controls";
import { companyNames, describeToolCall, type ToolHow, type ToolLine, type ToolOutcome } from "./tool-line";

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
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

const HOW_ICON: Record<ToolHow, ReactNode> = {
  API: <PlugsConnectedIcon size={16} />,
  "their agent": <ChatsIcon size={16} />,
  website: <GlobeIcon size={16} />,
  "sign-in": <SignInIcon size={16} />
};

const STATE_WORDS: Record<ToolLine["state"], string | null> = {
  running: "Working",
  done: null,
  waiting: "Waiting for you",
  failed: "Didn't work"
};

/** The raw call and its result, behind a disclosure. */
function Details({ call, result }: { call: ToolCall | undefined; result: ToolResult | undefined }) {
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
        </div>
      ) : null}
    </>
  );
}

/** A Poppy tool call as one line: what, where, how, with what access; raw call and result behind Details. */
function PoppyLine({ line, call, result }: { line: ToolLine; call: ToolCall | undefined; result: ToolResult | undefined }) {
  const meta = [line.how, line.access ? `${line.access} access` : null, STATE_WORDS[line.state]].filter(Boolean).join(" · ");
  const icon =
    line.state === "failed" ? (
      <WarningCircleIcon size={16} className="text-kumo-danger" />
    ) : line.state === "waiting" ? (
      <HourglassIcon size={16} className="text-kumo-warning" />
    ) : line.how ? (
      HOW_ICON[line.how]
    ) : (
      <StorefrontIcon size={16} />
    );
  return (
    <div className="flex flex-wrap items-start gap-x-2 text-[13px]" data-tool={call?.name ?? result?.name}>
      <span aria-hidden className="mt-0.5 shrink-0 text-kumo-subtle">
        {icon}
      </span>
      <p className="min-w-0 flex-1 text-pretty break-words">
        <span className={cn(line.state === "failed" ? "text-kumo-danger" : "text-kumo-default")}>{line.text}</span>
        {line.quote ? <span className="text-kumo-default"> “{line.quote}”</span> : null}
        {meta ? <span className="text-kumo-subtle"> · {meta}</span> : null}
      </p>
      <Details call={call} result={result} />
    </div>
  );
}

/** Any other tool: a compact card with its name and state. */
function ToolCard({ name, call, result, running }: { name: string; call: ToolCall | undefined; result: ToolResult | undefined; running: boolean }) {
  const state = result ? (result.error ? "Failed" : "Done") : running ? "Working" : "No result";
  return (
    <div className="flex flex-wrap items-start gap-x-2 rounded-xl px-3 py-2 text-[13px] ring ring-kumo-hairline" data-tool={name}>
      <span aria-hidden className="mt-0.5 shrink-0 text-kumo-subtle">
        {result?.error ? <WarningCircleIcon size={16} className="text-kumo-danger" /> : <WrenchIcon size={16} />}
      </span>
      <p className="min-w-0 flex-1">
        <code className="font-mono">{name}</code>
        <span className={result?.error ? "text-kumo-danger" : "text-kumo-subtle"}> · {state}</span>
      </p>
      <Details call={call} result={result} />
    </div>
  );
}

function ToolEntry({ call, result, running, companies }: { call?: ToolCall; result?: ToolResult; running: boolean; companies: ReadonlyMap<string, string> }) {
  const name = call?.name ?? result?.name ?? "tool";
  const outcome = outcomeOf(result);
  const line = describeToolCall(name, call?.arguments ?? {}, outcome ?? (running ? undefined : { error: false }), companies);
  if (line) return <PoppyLine line={line} call={call} result={result} />;
  return <ToolCard name={name} call={call} result={result} running={running} />;
}

function UserMessage({ message }: { message: TranscriptMessage }) {
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  return (
    <div className="flex justify-end">
      <div className="max-w-[min(85%,70ch)] rounded-xl bg-kumo-recessed px-4 py-2.5 text-base leading-7 text-pretty break-words whitespace-pre-wrap text-kumo-default">
        {text}
      </div>
    </div>
  );
}

function Notice({ message }: { message: TranscriptMessage }) {
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  return text ? <p className="text-center text-[13px] text-kumo-subtle">{text}</p> : null;
}

/**
 * The conversation: the person's messages, the agent's answers, and one line
 * per thing the agent did at a Company. Tool calls are paired with their
 * results by id, so each call is one line wherever its result arrives.
 */
export function Transcript({
  messages,
  live,
  runningTools,
  onRetry
}: {
  messages: readonly TranscriptMessage[];
  live: TranscriptMessage | null;
  runningTools: readonly string[];
  onRetry?: (text: string) => void;
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

  let lastUserText = "";
  return (
    <div className="space-y-5">
      {all.map((message) => {
        switch (message.role) {
          case "user":
            lastUserText = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
            return <UserMessage key={message.id} message={message} />;
          case "notice":
            return <Notice key={message.id} message={message} />;
          case "tool": {
            const orphans = message.parts.filter((part): part is ToolResult => part.type === "tool-result" && !called.has(part.id));
            if (orphans.length === 0) return null;
            return (
              <div key={message.id} className="space-y-2">
                {orphans.map((part) => (
                  <ToolEntry key={part.id} result={part} running={false} companies={companies} />
                ))}
              </div>
            );
          }
          case "assistant": {
            const retryText = lastUserText;
            const streaming = message === live;
            return (
              <div key={message.id} className="max-w-[70ch] space-y-3">
                {message.parts.map((part, index) => {
                  switch (part.type) {
                    case "text":
                      return part.text ? (
                        <Streamdown key={index} className="sd-theme text-base leading-7 text-pretty" plugins={{ code }} controls={false} components={MODEL_COMPONENTS}>
                          {part.text}
                        </Streamdown>
                      ) : null;
                    case "thinking":
                      return (
                        <details key={index} className="text-[13px] text-kumo-subtle">
                          <summary className="inline-flex min-h-10 cursor-pointer items-center rounded-md font-medium">Thinking</summary>
                          <p className="mt-1 whitespace-pre-wrap">{part.text}</p>
                        </details>
                      );
                    case "tool-call":
                      return (
                        <ToolEntry
                          key={part.id}
                          call={part}
                          {...(results.get(part.id) ? { result: results.get(part.id)! } : {})}
                          running={streaming || runningTools.includes(part.name)}
                          companies={companies}
                        />
                      );
                    case "tool-result":
                      return <ToolEntry key={part.id} result={part} running={false} companies={companies} />;
                    case "image":
                      return <img key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="" className="image-outline max-w-full rounded-lg" />;
                  }
                })}
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
      })}
    </div>
  );
}
