import { KeyIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type { Entitlement } from "../model-router";
import { Action, ActionLink } from "./controls";

/**
 * How the agent pays for its model calls, from `GET /api/entitlement`: the
 * person's own key, the operator's demo (with today's spend against its cap),
 * or nothing, in which case the agent can't call a model at all. The page
 * sends a key once, to `POST /api/model-key`, and never sees it again: the
 * Worker answers with the provider and state only.
 */

export type EntitlementState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly entitlement: Entitlement }
  | { readonly state: "unavailable" };

const PROVIDER: Record<"anthropic" | "openai" | "openrouter", string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter"
};

/** Set by the OpenRouter callback's redirect back to Settings. */
const OPENROUTER_RESULT: Record<string, string> = {
  connected: "OpenRouter is connected. Your agent uses your OpenRouter key from now on.",
  denied: "OpenRouter wasn't connected: the sign-in was cancelled.",
  state: "OpenRouter wasn't connected: that sign-in link expired or was started elsewhere. Try again.",
  code: "OpenRouter wasn't connected: it didn't send a code back. Try again.",
  exchange: "OpenRouter wasn't connected: it didn't issue a key. Try again."
};

/** The entitlement, refreshed on demand. One per page; Settings and the banner share it. */
export function useEntitlement(): [EntitlementState, (next?: Entitlement) => void] {
  const [value, setValue] = useState<EntitlementState>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/entitlement", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const entitlement = (await response.json()) as Entitlement;
        if (!cancelled) setValue({ state: "ready", entitlement });
      })
      .catch(() => {
        if (!cancelled) setValue({ state: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [generation]);
  const refresh = useCallback((next?: Entitlement) => {
    if (next) setValue({ state: "ready", entitlement: next });
    else setGeneration((count) => count + 1);
  }, []);
  return [value, refresh];
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Shown above every place while the agent can't call a model. */
export function ModelBanner({ entitlement, onSettings }: { entitlement: EntitlementState; onSettings: (() => void) | null }) {
  if (entitlement.state !== "ready" || entitlement.entitlement.lane !== "none") return null;
  const { reason, key } = entitlement.entitlement;
  const text =
    reason === "key_invalid"
      ? `${key ? PROVIDER[key.provider] : "Your provider"} refused your key, so your agent isn't calling the model.`
      : reason === "user_cap"
        ? "You've used today's demo allowance. Your agent resumes at midnight UTC, or with your own key."
        : reason === "domain_cap"
          ? "Your organisation has used today's demo allowance. Your agent resumes at midnight UTC, or with your own key."
          : "Your agent needs a model key before it can answer.";
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline bg-kumo-warning-tint px-4 py-2 text-[13px] text-kumo-default">
      <WarningIcon size={16} aria-hidden className="shrink-0 text-kumo-warning" />
      <p className="min-w-0 flex-1 text-pretty">{text}</p>
      {onSettings ? (
        <a
          href="/settings"
          className="font-medium text-kumo-link underline-offset-2 hover:underline"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onSettings();
          }}
        >
          Add a key in Settings
        </a>
      ) : null}
    </div>
  );
}

/** Today's demo spend against the cap: a meter, with the numbers in words too. */
function DemoMeter({ demo }: { demo: NonNullable<Entitlement["demo"]> }) {
  const used = demo.capUsd > 0 ? Math.min(1, demo.spentUsd / demo.capUsd) : 1;
  const label = `${dollars(demo.spentUsd)} of ${dollars(demo.capUsd)} used today`;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium text-kumo-default">Demo allowance</span>
        <span className="text-kumo-subtle tabular-nums">{label}</span>
      </div>
      <div
        role="meter"
        aria-label="Demo allowance used today"
        aria-valuemin={0}
        aria-valuemax={demo.capUsd}
        aria-valuenow={Math.min(demo.spentUsd, demo.capUsd)}
        aria-valuetext={label}
        className="h-2 overflow-hidden rounded-full bg-kumo-recessed"
      >
        <div className={`h-full rounded-full ${used >= 1 ? "bg-kumo-warning" : "bg-kumo-brand"}`} style={{ width: `${Math.round(used * 100)}%` }} />
      </div>
      <p className="text-[13px] text-kumo-subtle">
        Resets at midnight UTC.{demo.domainCapped ? " Your organisation has used its allowance for today." : ""}
      </p>
    </div>
  );
}

/** Where the agent's model calls come from now, in one sentence. */
function Status({ entitlement }: { entitlement: Entitlement }) {
  const { lane, reason, key, model } = entitlement;
  if (lane === "own_key" && key) {
    return (
      <p className="text-base text-pretty">
        Using your <span className="font-medium">{PROVIDER[key.provider]}</span> key
        {key.source === "openrouter" ? ", connected through OpenRouter" : ""}
        {model ? <> for {model.name}</> : null}. Added {new Date(key.addedAt).toLocaleDateString()}.
      </p>
    );
  }
  if (reason === "key_invalid" && key) {
    return (
      <p className="text-base text-pretty text-kumo-danger">
        {PROVIDER[key.provider]} refused your key, so your agent has stopped calling the model. It won't fall back to the demo. Add a working key.
      </p>
    );
  }
  if (lane === "demo") {
    return <p className="text-base text-pretty">Using the demo{model ? <> ({model.name})</> : null}: this deployment's operator pays, up to a daily allowance.</p>;
  }
  if (reason === "user_cap" || reason === "domain_cap") {
    return <p className="text-base text-pretty text-kumo-warning">The demo allowance is used up for today. Add your own key to keep going now.</p>;
  }
  return <p className="text-base text-pretty text-kumo-warning">Needs a key: your agent can't call a model until you add one.</p>;
}

/** Paste a key (sent once, never shown again), remove it, or connect OpenRouter. */
function KeyForm({ entitlement, onChange }: { entitlement: Entitlement; onChange: (next: Entitlement) => void }) {
  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { key: useId(), error: useId() };
  const field =
    "mt-1 block w-full rounded-lg bg-kumo-base px-3 py-2 font-mono text-base text-kumo-default ring ring-kumo-line placeholder:text-kumo-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand aria-invalid:ring-kumo-danger";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim()) {
      setError("Paste a key.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/model-key", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key: key.trim() })
      });
      const body = (await response.json().catch(() => ({}))) as Entitlement & { error?: string };
      if (!response.ok) {
        setError(body.error ?? `That didn't work (${response.status}).`);
        return;
      }
      setKey("");
      onChange(body);
    } catch {
      setError("Couldn't reach your agent. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/model-key", { method: "DELETE", credentials: "same-origin" });
      if (response.ok) onChange((await response.json()) as Entitlement);
      else setError(`Couldn't remove the key (${response.status}).`);
    } finally {
      setBusy(false);
    }
  };

  const hasKey = entitlement.key !== null;
  return (
    <div className="space-y-4">
      <form noValidate onSubmit={submit} className="space-y-3" aria-label={hasKey ? "Replace your model key" : "Add your model key"}>
        <fieldset>
          <legend className="text-[13px] font-medium text-kumo-default">{hasKey ? "Replace it with a key from" : "Your key from"}</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {(["anthropic", "openai"] as const).map((value) => (
              <label
                key={value}
                className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-base ring ring-kumo-line transition-colors duration-150 has-checked:bg-kumo-tint has-checked:ring-kumo-focus/40 has-focus-visible:ring-2 has-focus-visible:ring-kumo-brand max-sm:min-h-11"
              >
                <input type="radio" name="model-key-provider" value={value} checked={provider === value} onChange={() => setProvider(value)} className="size-4" />
                {PROVIDER[value]}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor={ids.key} className="block text-[13px] font-medium text-kumo-default">
            API key
          </label>
          <input
            id={ids.key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={field}
            placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
            value={key}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? ids.error : undefined}
            onChange={(event) => setKey(event.target.value)}
          />
          {error ? (
            <p id={ids.error} role="alert" className="mt-1 text-[13px] text-kumo-danger">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasKey ? (
            <Action type="button" variant="secondary" disabled={busy} onClick={() => void remove()}>
              Remove key
            </Action>
          ) : null}
          <Action type="submit" variant="primary" loading={busy} icon={<KeyIcon size={16} aria-hidden />}>
            Check and save key
          </Action>
        </div>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-hairline pt-4">
        <p className="min-w-0 flex-1 text-[13px] text-pretty text-kumo-subtle">Or sign in to OpenRouter, which gives your agent a key you can cap and revoke there.</p>
        <ActionLink href="/auth/openrouter/start" variant="secondary">
          Connect OpenRouter
        </ActionLink>
      </div>
    </div>
  );
}

/** Settings' Model section: status, the demo meter, and the key panel. */
export function ModelSettings({ entitlement, onChange }: { entitlement: EntitlementState; onChange: (next?: Entitlement) => void }) {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("model_key") ?? url.searchParams.get("model_key_error");
    if (!result) return;
    url.searchParams.delete("model_key");
    url.searchParams.delete("model_key_error");
    window.history.replaceState(null, "", url);
    setNotice(OPENROUTER_RESULT[result] ?? "OpenRouter wasn't connected. Try again.");
  }, []);

  if (entitlement.state === "loading") {
    return (
      <p role="status" className="rounded-xl p-4 text-[13px] text-kumo-subtle ring ring-kumo-hairline">
        Loading how your agent pays for its model
      </p>
    );
  }
  if (entitlement.state === "unavailable") {
    return <p className="rounded-xl p-4 text-[13px] text-kumo-subtle ring ring-kumo-hairline">Couldn't load your model settings. Reload the page to try again.</p>;
  }
  const current = entitlement.entitlement;
  return (
    <div className="space-y-4 rounded-xl p-4 ring ring-kumo-hairline">
      {notice ? (
        <p role="status" className="text-[13px] text-pretty text-kumo-default">
          {notice}
        </p>
      ) : null}
      <Status entitlement={current} />
      {current.demo && current.lane !== "own_key" ? <DemoMeter demo={current.demo} /> : null}
      <KeyForm entitlement={current} onChange={(next) => onChange(next)} />
      <p className="text-[13px] text-pretty text-kumo-subtle">
        Your key is checked with the provider, then encrypted and kept in your agent. It's never shown again, here or anywhere. Whoever runs this
        deployment can technically read it, so prefer a key with a spend limit: an OpenRouter key with a credit limit is the safest choice.
      </p>
    </div>
  );
}
