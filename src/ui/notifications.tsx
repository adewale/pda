import { useCallback, useEffect, useState } from "react";
import { fromBase64url } from "../base64url";
import { Section } from "./controls";

/**
 * Settings' Notifications section: "Notifications on this device" (Web
 * Push, src/web-push.ts). Turning it on asks the browser's permission,
 * registers `/sw.js`, subscribes with the deployment's VAPID public key
 * (`GET /api/push/key`) and hands the subscription to the person's agent
 * (`POST /api/push/subscription`); turning it off unsubscribes and tells the
 * agent to forget it. Hidden when the deployment has no VAPID key.
 */

type State =
  | { readonly state: "loading" }
  | { readonly state: "hidden" }
  | { readonly state: "unsupported" }
  | { readonly state: "ready"; readonly key: string; readonly on: boolean; readonly denied: boolean };

const IOS_NOTE = "On iPhone and iPad, notifications reach only the app added to your Home Screen: in Safari, tap Share, then Add to Home Screen, and turn this on from there.";

function supported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export function NotificationSettings() {
  const [state, setState] = useState<State>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let key: string | null = null;
    try {
      const response = await fetch("/api/push/key", { credentials: "same-origin" });
      if (response.ok) key = ((await response.json()) as { publicKey?: unknown }).publicKey as string | null;
    } catch {
      key = null;
    }
    if (typeof key !== "string" || !key) return setState({ state: "hidden" });
    if (!supported()) return setState({ state: "unsupported" });
    let on = false;
    try {
      on = (await currentSubscription()) !== null && Notification.permission === "granted";
    } catch {
      on = false;
    }
    setState({ state: "ready", key, on, denied: Notification.permission === "denied" });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const turnOn = async (key: string) => {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setState({ state: "ready", key, on: false, denied: permission === "denied" });
      setError(permission === "denied" ? "This browser blocks notifications from your agent. Allow them in the browser's site settings, then try again." : null);
      return;
    }
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64url(key) });
    const response = await fetch("/api/push/subscription", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON())
    });
    if (!response.ok) {
      await subscription.unsubscribe();
      throw new Error(String(response.status));
    }
    setState({ state: "ready", key, on: true, denied: false });
  };

  const turnOff = async (key: string) => {
    const subscription = await currentSubscription();
    if (subscription) {
      const response = await fetch("/api/push/subscription", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint })
      });
      if (!response.ok && response.status !== 404) throw new Error(String(response.status));
      await subscription.unsubscribe();
    }
    setState({ state: "ready", key, on: false, denied: false });
  };

  if (state.state === "loading" || state.state === "hidden") return null;
  return (
    <Section title="Notifications" description="Your reminders, and a word when a scheduled task has run, on this device, even when this page is closed.">
      {state.state === "unsupported" ? (
        <p className="rounded-xl p-4 text-base text-pretty text-kumo-subtle ring ring-kumo-hairline">This browser can't show notifications from your agent. {IOS_NOTE}</p>
      ) : (
        <div className="space-y-2 rounded-xl p-4 ring ring-kumo-hairline">
          <label className="flex min-h-10 cursor-pointer items-center gap-3 text-base">
            <input
              type="checkbox"
              role="switch"
              className="size-5"
              checked={state.on}
              disabled={busy}
              aria-checked={state.on}
              onChange={() => {
                setBusy(true);
                setError(null);
                (state.on ? turnOff(state.key) : turnOn(state.key))
                  .catch(() => setError(state.on ? "Notifications couldn't be turned off just now. Try again." : "Notifications couldn't be turned on just now. Try again."))
                  .finally(() => setBusy(false));
              }}
            />
            Notifications on this device
          </label>
          <p className="text-[13px] text-pretty text-kumo-subtle">
            A notification says only “Reminder” and the reminder's words, or that a scheduled task ran. It goes through your browser's push service (Google, Mozilla, Apple or Microsoft), encrypted for this device. {IOS_NOTE}
          </p>
          {state.denied && !error ? <p className="text-[13px] text-kumo-danger">This browser blocks notifications from your agent. Allow them in the browser's site settings to turn this on.</p> : null}
          {error ? (
            <p role="alert" className="text-[13px] text-kumo-danger">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Section>
  );
}
