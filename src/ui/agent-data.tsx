import { useState } from "react";
import { Action } from "./controls";

export function AgentDataSettings() {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (confirmation !== "DELETE") return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/agent-data", { method: "DELETE", credentials: "same-origin", headers: { "X-PDA-Delete": "delete-my-agent" } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; companies?: string[] };
        throw new Error(`${body.error ?? "Deletion could not be completed. Try again."}${body.companies?.length ? ` Companies: ${body.companies.join(", ")}. Revoke access at those Companies or retry after their services recover.` : ""}`);
      }
      window.location.assign("/");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Deletion could not be completed.");
    } finally { setBusy(false); }
  };
  return <div className="space-y-3 rounded-xl p-4 ring ring-kumo-hairline">
    <p className="text-base text-pretty">Download your conversations, saved notes, photos and other local records. Stored credentials and browser sessions are omitted. The download contains personal information; keep it somewhere private.</p>
    <a className="inline-block min-h-10 underline" href="/api/agent-data" download="pda-personal-data.json">Download my data</a>
    <p className="text-base text-pretty">Deleting your agent stops its work, revokes Company access and removes its local conversations, notes, photos, schedules and keys. It signs out every device. Copies held by model providers or Companies are outside this deletion.</p>
    {confirming ? <div className="space-y-2">
      <label className="block">Type DELETE to permanently delete your agent
        <input aria-label="Deletion confirmation" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.currentTarget.value)} disabled={busy} className="ml-2 min-h-10 rounded-md px-2 ring ring-kumo-line" />
      </label>
      <div className="flex flex-wrap gap-2">
        <Action variant="secondary-destructive" disabled={busy || confirmation !== "DELETE"} onClick={() => void remove()}>{busy ? "Stopping work and revoking access…" : "Permanently delete my agent"}</Action>
        <Action variant="secondary" disabled={busy} onClick={() => { setConfirming(false); setConfirmation(""); }}>Keep my agent</Action>
      </div>
    </div> : <Action variant="secondary-destructive" onClick={() => setConfirming(true)}>Delete my agent</Action>}
    {error ? <p role="alert" className="text-kumo-danger">{error}</p> : null}
  </div>;
}
