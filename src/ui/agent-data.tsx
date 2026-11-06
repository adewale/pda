import { useState } from "react";
import { Action } from "./controls";

type UnrevokedAccess = { id: string; company: string; domain: string; code: string; liveUntil: number | null };

function whyUnrevoked(code: string): string {
  switch (code) {
    case "sign_in_unfinished": return "A sign-in received access but never finished, so your agent can't revoke it.";
    case "invalid_client":
    case "unauthorized_client": return "It doesn't accept this agent's identity, which can happen when the access was granted at an earlier address. Trying again is unlikely to help.";
    case "unreadable": return "This deployment can no longer read the stored credential, so it can't be sent.";
    case "not_signed_out": return "Your agent didn't get as far as revoking it.";
    case "no_sign_in": return "It no longer offers sign-in, so there's nowhere to send the revocation.";
    case "rate_limited": return "It asked your agent to wait. Trying again later may work.";
    case "no_answer":
    case "network":
    case "timeout": return "It didn't answer. Trying again later may work, unless the Company has closed.";
    default: return `It didn't accept the request (${code}). Trying again may work.`;
  }
}

const untilText = (at: number | null) => at === null
  ? "It stays listed there until you remove it, or the Company does."
  : `It stays listed there until ${new Date(at).toLocaleString()}, unless you remove it sooner.`;

/** One credential that couldn't be revoked, and what abandoning it would leave behind. */
function UnrevokedList({ items }: { items: readonly UnrevokedAccess[] }) {
  return <ul className="list-disc space-y-2 pl-5 text-base">
    {items.map(item => <li key={item.id}>
      <strong>{item.company}</strong> ({item.domain}). {whyUnrevoked(item.code)} {untilText(item.liveUntil)}
    </li>)}
  </ul>;
}

export function AgentDataSettings() {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unrevoked, setUnrevoked] = useState<readonly UnrevokedAccess[]>([]);
  const remove = async (abandon: readonly UnrevokedAccess[] = []) => {
    if (confirmation !== "DELETE") return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/agent-data", {
        method: "DELETE", credentials: "same-origin",
        headers: { "X-PDA-Delete": "delete-my-agent", ...(abandon.length ? { "Content-Type": "application/json" } : {}) },
        ...(abandon.length ? { body: JSON.stringify({ abandonRevocations: abandon.map(item => item.id) }) } : {})
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; unrevoked?: UnrevokedAccess[] };
        setUnrevoked(body.unrevoked ?? []);
        if (!body.unrevoked?.length) setError(body.error ?? "Deletion could not be completed. Try again.");
        return;
      }
      window.location.assign("/");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Deletion could not be completed.");
    } finally { setBusy(false); }
  };
  const keep = () => { setConfirming(false); setConfirmation(""); setUnrevoked([]); setError(null); };
  return <div className="space-y-3 rounded-xl p-4 ring ring-kumo-hairline">
    <p className="text-base text-pretty">Download your conversations, saved notes, photos and other local records. Stored credentials and browser sessions are omitted. The download contains personal information; keep it somewhere private.</p>
    <a className="inline-block min-h-10 underline" href="/api/agent-data" download="pda-personal-data.json">Download my data</a>
    <p className="text-base text-pretty">Deleting your agent stops its work, revokes Company access and removes its local conversations, notes, photos, schedules and keys. It signs out every device. Copies held by model providers or Companies are outside this deletion.</p>
    {unrevoked.length ? <div role="alert" className="space-y-3">
      <p className="text-base text-pretty">Your agent couldn't revoke its access at the Companies below. Your local data is still here, but your agent has stopped what it was doing and signed out of the Companies it could reach.</p>
      <UnrevokedList items={unrevoked} />
      <p className="text-base text-pretty">If you delete anyway, your agent destroys its only copy of each credential, so nothing can use that access afterwards. The Company may still show your agent as connected, and only you or the Company can remove that, from your account there.</p>
      <div className="flex flex-wrap gap-2">
        <Action variant="secondary" disabled={busy} onClick={() => void remove()}>{busy ? "Trying…" : "Try again"}</Action>
        <Action variant="secondary-destructive" disabled={busy} onClick={() => void remove(unrevoked)}>Delete anyway</Action>
        <Action variant="secondary" disabled={busy} onClick={keep}>Keep my agent</Action>
      </div>
    </div> : confirming ? <div className="space-y-2">
      <label className="block">Type DELETE to permanently delete your agent
        <input aria-label="Deletion confirmation" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.currentTarget.value)} disabled={busy} className="ml-2 min-h-10 rounded-md px-2 ring ring-kumo-line" />
      </label>
      <div className="flex flex-wrap gap-2">
        <Action variant="secondary-destructive" disabled={busy || confirmation !== "DELETE"} onClick={() => void remove()}>{busy ? "Stopping work and revoking access…" : "Permanently delete my agent"}</Action>
        <Action variant="secondary" disabled={busy} onClick={keep}>Keep my agent</Action>
      </div>
    </div> : <Action variant="secondary-destructive" onClick={() => setConfirming(true)}>Delete my agent</Action>}
    {error ? <p role="alert" className="text-kumo-danger">{error}</p> : null}
  </div>;
}
