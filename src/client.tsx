import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface
} from "@cloudflare/kumo";
import {
  BrainIcon,
  CheckCircleIcon,
  GearIcon,
  MoonIcon,
  GithubLogoIcon,
  GoogleLogoIcon,
  PaperPlaneRightIcon,
  SignOutIcon,
  StopIcon,
  StorefrontIcon,
  SunIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import { DirectConversations, PoppyCards, PoppySettings } from "./poppy-ui";
import type { TranscriptMessage, TranscriptPart } from "./protocol";
import { usePiSession } from "./use-pi-session";
import "./styles.css";

const MODEL = "Claude Opus 5.5";

/** Who is signed in, from `/api/me`; the Worker checks the session cookie. */
type Me =
  | { readonly state: "loading" }
  | {
      readonly state: "signed-in";
      readonly email: string | null;
      readonly provider: "google" | "github";
    }
  | { readonly state: "signed-out"; readonly message: string | null };

/** Set by the Worker's OAuth callback when a sign-in did not complete. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  state: "That sign-in link expired. Please try again.",
  code: "The provider did not complete sign-in. Please try again.",
  token: "The provider did not confirm who you are. Please try again.",
  profile: "The provider did not share your account id. Please try again.",
  not_allowed: "That account isn't on this agent's allowlist. Ask the owner to add it, or sign in with another account."
};

function takeSignInError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("signin_error");
  if (code === null) return null;
  url.searchParams.delete("signin_error");
  window.history.replaceState(null, "", url);
  return SIGN_IN_ERRORS[code] ?? "Sign-in failed. Please try again.";
}

function useMe(): Me {
  const [me, setMe] = useState<Me>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "same-origin" })
      .then(async (response) => {
        if (cancelled) return;
        if (response.ok) {
          const body = (await response.json()) as {
            email: string | null;
            provider: "google" | "github";
          };
          setMe({ state: "signed-in", ...body });
        } else if (response.status === 401) {
          setMe({ state: "signed-out", message: takeSignInError() });
        } else {
          setMe({
            state: "signed-out",
            message: `Sign-in is not set up yet: ${await response.text()}`
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMe({ state: "signed-out", message: String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return me;
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ToolCallCard({
  part,
  running
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
  running: boolean;
}) {
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {running ? (
          <GearIcon size={14} className="animate-spin text-kumo-inactive" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {part.name}
        </span>
        <Badge variant="secondary">{running ? "Running" : "Called"}</Badge>
      </summary>
      <div className="border-t border-kumo-line px-3 py-3">
        <p className="mb-1 text-xs font-semibold text-kumo-subtle">
          Arguments
        </p>
        <JsonBlock value={part.arguments} />
      </div>
    </details>
  );
}

function ToolResultCard({
  part
}: {
  part: Extract<TranscriptPart, { type: "tool-result" }>;
}) {
  const text = part.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n");
  const images = part.content.filter((content) => content.type === "image");
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {part.error ? (
          <XCircleIcon size={14} className="text-kumo-danger" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold">{part.name}</span>
          {text ? <span className="ml-2 text-kumo-subtle">{text}</span> : null}
        </span>
        <Badge variant={part.error ? "destructive" : "secondary"}>
          {part.error ? "Failed" : "Done"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        {text ? (
          <div>
            <p className="mb-1 text-xs font-semibold text-kumo-subtle">
              Result
            </p>
            <JsonBlock value={text} />
          </div>
        ) : null}
        {images.map((image, index) =>
          image.type === "image" ? (
            <img
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`${part.name} output`}
              className="max-w-full rounded-lg"
            />
          ) : null
        )}
        {part.details !== undefined ? (
          <div>
            <p className="mb-1 text-xs font-semibold text-kumo-subtle">
              Details
            </p>
            <JsonBlock value={part.details} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function AssistantPart({
  part,
  running
}: {
  part: TranscriptPart;
  running: boolean;
}) {
  switch (part.type) {
    case "text":
      return (
        <Streamdown
          className="sd-theme text-sm leading-6"
          plugins={{ code }}
          controls={false}
        >
          {part.text}
        </Streamdown>
      );
    case "thinking":
      return (
        <details className="rounded-xl border border-kumo-line px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
            Thinking
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
            {part.text}
          </p>
        </details>
      );
    case "tool-call":
      return <ToolCallCard part={part} running={running} />;
    case "tool-result":
      return <ToolResultCard part={part} />;
    case "image":
      return (
        <img
          src={`data:${part.mimeType};base64,${part.data}`}
          alt=""
          className="max-w-full rounded-lg"
        />
      );
  }
}

function UserMessage({ message }: { message: TranscriptMessage }) {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed text-kumo-inverse">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly string[];
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
        <BrainIcon size={17} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, index) => (
          <AssistantPart
            key={`${message.id}-${index}`}
            part={part}
            running={
              streaming &&
              part.type === "tool-call" &&
              runningTools.includes(part.name)
            }
          />
        ))}
        {streaming ? <span className="streaming-cursor" /> : null}
        {message.error ? (
          <div
            role="alert"
            className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {message.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolMessage({ message }: { message: TranscriptMessage }) {
  return (
    <div className="ml-11 space-y-2">
      {message.parts.map((part, index) =>
        part.type === "tool-result" ? (
          <ToolResultCard key={`${message.id}-${index}`} part={part} />
        ) : null
      )}
    </div>
  );
}

function Message({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly string[];
}) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return (
        <AssistantMessage
          message={message}
          streaming={streaming}
          runningTools={runningTools}
        />
      );
    case "tool":
      return <ToolMessage message={message} />;
    case "notice":
      return message.parts.length === 0 ? null : (
        <p className="text-center text-xs text-kumo-inactive">
          {message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")}
        </p>
      );
  }
}

/** Shown instead of the chat when `/api/me` says no one is signed in. */
function SignedOut({ message }: { message: string | null }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-kumo-elevated px-4 text-kumo-default">
      <Surface className="max-w-md rounded-xl p-6 ring ring-kumo-line">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
            <BrainIcon size={20} weight="bold" />
          </div>
          <h1 className="text-base font-semibold">Personal agent</h1>
        </div>
        <p className="text-sm text-kumo-subtle">
          Sign in to reach your own agent. Each account gets one private,
          continuous conversation.
        </p>
        {message ? (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-kumo-danger/10 px-3 py-2 text-sm text-kumo-danger"
          >
            {message}
          </p>
        ) : null}
        <div className="mt-5 flex flex-col gap-2">
          <a
            href="/auth/google"
            className="flex items-center justify-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-4 py-2.5 text-sm font-medium hover:bg-kumo-elevated"
          >
            <GoogleLogoIcon size={18} weight="bold" />
            Sign in with Google
          </a>
          <a
            href="/auth/github"
            className="flex items-center justify-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-4 py-2.5 text-sm font-medium hover:bg-kumo-elevated"
          >
            <GithubLogoIcon size={18} weight="bold" />
            Sign in with GitHub
          </a>
        </div>
      </Surface>
    </div>
  );
}

function SignOutButton() {
  return (
    <form method="post" action="/logout">
      <Button
        type="submit"
        variant="ghost"
        shape="square"
        aria-label="Sign out"
        icon={<SignOutIcon size={16} />}
      />
    </form>
  );
}

function Chat({
  email,
  provider
}: {
  email: string | null;
  provider: "google" | "github";
}) {
  const [prompt, setPrompt] = useState("");
  const [companiesOpen, setCompaniesOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const {
    poppy,
    sendPoppy,
    status,
    messages,
    live,
    running,
    tools: running_,
    queued,
    retry,
    error,
    submit: submitPrompt,
    abort
  } = usePiSession();
  const runningTools = running_.map((tool) => tool.name);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running, poppy.cards, poppy.direct]);

  const connected = status === "open";

  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    submitPrompt(text, whenBusy);
  };

  const empty = messages.length === 0 && !live && !running;

  return (
    <div
      className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        companiesOpen ? "lg:grid-cols-[minmax(480px,1fr)_minmax(300px,26vw)]" : "grid-cols-1"
      }`}
    >
      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-4 sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
                <BrainIcon size={20} weight="bold" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">
                  Personal agent
                </h1>
                <p className="truncate text-xs text-kumo-subtle">
                  {email ?? "Signed in"} ·{" "}
                  {provider === "google" ? "Google" : "GitHub"}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {MODEL}
              </Badge>
              <Badge variant={connected ? "success" : "secondary"}>
                {connected
                  ? "Live"
                  : status === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <Button
                variant="ghost"
                shape="square"
                aria-label="Companies"
                aria-expanded={companiesOpen}
                onClick={() => setCompaniesOpen((open) => !open)}
                icon={<StorefrontIcon size={16} />}
              />
              <ModeToggle />
              <SignOutButton />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-5">
            {empty ? (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<BrainIcon size={32} />}
                  title="Ask your agent anything"
                  description="It keeps this one conversation, so it remembers what you tell it."
                />
              </div>
            ) : null}

            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                runningTools={runningTools}
              />
            ))}

            {live ? (
              <Message message={live} streaming runningTools={runningTools} />
            ) : null}

            {running && !live ? (
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
                  <BrainIcon size={17} weight="bold" />
                </div>
                <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
                  <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                    <GearIcon size={15} className="animate-spin" />
                    {retry
                      ? `Retrying: ${retry.error}`
                      : runningTools.length > 0
                        ? `Running ${runningTools.join(", ")}`
                        : "Waiting for the model"}
                  </div>
                </Surface>
              </div>
            ) : null}

            {running_.map((tool) =>
              tool.output ? (
                <pre
                  key={tool.callId}
                  className="ml-11 max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs"
                >
                  {tool.output}
                </pre>
              ) : null
            )}

            {queued > 0 ? (
              <p className="ml-11 text-xs text-kumo-subtle">
                {queued} queued behind this run
              </p>
            ) : null}

            <PoppyCards view={poppy} send={sendPoppy} />
            <DirectConversations view={poppy} send={sendPoppy} />

            {error ? (
              <div
                role="alert"
                className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
              >
                {error}
              </div>
            ) : null}

            <div ref={endRef} />
          </div>
        </main>

        <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="mx-auto max-w-3xl px-4 pt-4 sm:px-5"
          >
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
              <InputArea
                value={prompt}
                onValueChange={setPrompt}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  running
                    ? "Queue a follow-up, or steer the running turn"
                    : "Message your agent"
                }
                aria-label="Message your agent"
                disabled={!connected}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              {running ? (
                <div className="mb-0.5 flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Steer"
                    disabled={prompt.trim() === ""}
                    onClick={() => submit("steer")}
                  >
                    Steer
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop"
                    onClick={abort}
                    icon={<StopIcon size={18} weight="fill" />}
                  />
                </div>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!connected || prompt.trim() === ""}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
          <div className="flex items-center justify-center gap-2 px-5 py-3">
            <span className="hidden text-xs text-kumo-subtle sm:inline">
              Enter to send · Shift+Enter for a new line
            </span>
            <span className="hidden text-kumo-line sm:inline">·</span>
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </section>
      {companiesOpen ? (
        <PoppySettings view={poppy} send={sendPoppy} onClose={() => setCompaniesOpen(false)} />
      ) : null}
    </div>
  );
}

function App() {
  const me = useMe();
  if (me.state === "loading") {
    return <div className="h-dvh bg-kumo-elevated" />;
  }
  if (me.state === "signed-out") return <SignedOut message={me.message} />;
  return <Chat email={me.email} provider={me.provider} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
