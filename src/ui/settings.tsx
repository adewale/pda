import { SignOutIcon } from "@phosphor-icons/react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Entitlement } from "../model-router";
import { Action, PageHeader, Section } from "./controls";
import { MemorySettings } from "./memory";
import { ModelSettings, type EntitlementState } from "./model";

export type Identity = { readonly email: string | null; readonly provider: "google" | "github" };

export const PROVIDER_NAME: Record<Identity["provider"], string> = { google: "Google", github: "GitHub" };

export type Theme = "system" | "light" | "dark";

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem("theme");
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const mode = dark ? "dark" : "light";
  document.documentElement.setAttribute("data-mode", mode);
  document.documentElement.style.colorScheme = mode;
}

/** One theme for the whole page; `index.html` applies the stored one before the page loads. */
const themeListeners = new Set<() => void>();
let currentTheme: Theme | null = null;

function getTheme(): Theme {
  return (currentTheme ??= storedTheme());
}

function setTheme(theme: Theme): void {
  currentTheme = theme;
  try {
    if (theme === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", theme);
  } catch {
    // Private windows may refuse storage; the choice still applies to this page.
  }
  applyTheme(theme);
  for (const listener of themeListeners) listener();
}

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

/** Light, dark, or whatever the device uses; remembered in this browser. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => "system" as Theme);
  return [theme, setTheme];
}

/** While the theme follows the device, follow it when the device changes. */
export function useFollowDeviceTheme(): void {
  const [theme] = useTheme();
  useEffect(() => {
    if (theme !== "system") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyTheme("system");
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [theme]);
}

type ClientIdentity = { state: "loading" } | { state: "ready"; clientId: string; clientName: string | null } | { state: "unavailable" };

/** The agent's public identity at Companies: its Poppy client metadata document, when this origin serves it. */
function useClientIdentity(): ClientIdentity {
  const [identity, setIdentity] = useState<ClientIdentity>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/poppy/client.json")
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { client_id?: unknown; client_name?: unknown };
        if (typeof body.client_id !== "string") throw new Error("no client_id");
        if (!cancelled) setIdentity({ state: "ready", clientId: body.client_id, clientName: typeof body.client_name === "string" ? body.client_name : null });
      })
      .catch(() => {
        if (!cancelled) setIdentity({ state: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return identity;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-[13px] font-medium text-kumo-subtle sm:pt-0.5">{term}</dt>
      <dd className="min-w-0 text-base">{children}</dd>
    </div>
  );
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "Match this device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

/** Settings: who is signed in, how the agent pays for its model, what it remembers, how the page looks, and which agent this is. */
export function SettingsPage({
  identity,
  entitlement,
  onEntitlement
}: {
  identity: Identity;
  entitlement: EntitlementState;
  onEntitlement: (next?: Entitlement) => void;
}) {
  const model = entitlement.state === "ready" ? entitlement.entitlement.model : null;
  const [theme, setTheme] = useTheme();
  const client = useClientIdentity();
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" />

      <Section title="Account">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl p-4 ring ring-kumo-hairline">
          <p className="min-w-0 flex-1 text-base text-pretty break-words">
            Signed in as <span className="font-medium">{identity.email ?? "your account"}</span> with {PROVIDER_NAME[identity.provider]}.
          </p>
          <form method="post" action="/logout">
            <Action type="submit" variant="secondary" icon={<SignOutIcon size={16} aria-hidden />}>
              Sign out of this agent
            </Action>
          </form>
        </div>
      </Section>

      <Section title="Model" description="Who pays for your agent's model calls: your own key, or this deployment's demo while it lasts.">
        <ModelSettings entitlement={entitlement} onChange={onEntitlement} />
      </Section>

      <Section title="Memory" description="Short notes your agent has saved about you. It sees the newest 50 with every message, even after older messages are summarised, and can search the rest. Delete any you don't want it to keep.">
        <MemorySettings />
      </Section>

      <Section title="Appearance">
        <fieldset className="rounded-xl p-4 ring ring-kumo-hairline">
          <legend className="sr-only">Theme</legend>
          <p aria-hidden className="mb-2 text-[13px] font-medium text-kumo-subtle">
            Theme
          </p>
          <div className="flex flex-wrap gap-2">
            {THEMES.map((option) => (
              <label
                key={option.value}
                className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-base ring ring-kumo-line transition-colors duration-150 has-checked:bg-kumo-tint has-checked:ring-kumo-focus/40 has-focus-visible:ring-2 has-focus-visible:ring-kumo-brand max-sm:min-h-11"
              >
                <input type="radio" name="theme" value={option.value} checked={theme === option.value} onChange={() => setTheme(option.value)} className="size-4" />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Agent" description="Read only. The models and identity are set when the agent is deployed.">
        <dl className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline">
          <Fact term="Model">
            {model ? (
              <>
                {model.name}
                <code className="ml-2 font-mono text-[13px] text-kumo-subtle">{model.id}</code>
              </>
            ) : (
              <span className="text-kumo-subtle">None until your agent has a key or the demo</span>
            )}
          </Fact>
          <Fact term="Identity at Companies">
            {client.state === "loading" ? (
              <span role="status" className="text-kumo-subtle">
                Loading the agent's identity
              </span>
            ) : client.state === "ready" ? (
              <>
                {client.clientName ? <span className="block">{client.clientName}</span> : null}
                <code className="block font-mono text-[13px] break-all text-kumo-subtle">{client.clientId}</code>
                <span className="mt-1 block text-[13px] text-pretty text-kumo-subtle">Companies see your agent as this client. It is the same for everyone who uses this deployment.</span>
              </>
            ) : (
              <span className="text-[13px] text-pretty text-kumo-subtle">This address doesn't publish the agent's identity. It is served only at the agent's public address.</span>
            )}
          </Fact>
        </dl>
      </Section>
    </div>
  );
}
