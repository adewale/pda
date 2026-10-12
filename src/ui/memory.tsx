import { useCallback, useEffect, useState } from "react";
import { Action } from "./controls";

/**
 * Settings' Memory section: the notes the agent keeps about its User
 * (src/tools/memory-store.ts), from `GET /api/memories`, each with a delete
 * button, and "Forget everything". The page talks to the person's own agent
 * through the Worker, same origin only; nobody else's notes can reach it.
 */

export type MemoryNote = { readonly id: number; readonly text: string; readonly source: "user" | "agent"; readonly createdAt: number };

type Notes = { state: "loading" } | { state: "ready"; notes: MemoryNote[]; limit: number } | { state: "unavailable" };

const WHOSE: Record<MemoryNote["source"], string> = { user: "You said", agent: "Your agent noted" };

function when(at: number): string {
  try {
    return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export function MemorySettings() {
  const [notes, setNotes] = useState<Notes>({ state: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/memories", { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { memories: MemoryNote[]; limit: number };
      setNotes({ state: "ready", notes: body.memories, limit: body.limit });
    } catch {
      setNotes({ state: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const forget = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok && response.status !== 404) throw new Error(String(response.status));
      setConfirming(false);
      await load();
    } catch {
      setError("Your agent couldn't forget that just now. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (notes.state === "loading") {
    return (
      <p role="status" className="rounded-xl p-4 text-base text-kumo-subtle ring ring-kumo-hairline">
        Loading your agent's notes
      </p>
    );
  }
  if (notes.state === "unavailable") {
    return <p className="rounded-xl p-4 text-base text-pretty text-kumo-subtle ring ring-kumo-hairline">Your agent's notes couldn't be loaded. Reload the page to try again.</p>;
  }
  return (
    <div className="space-y-3">
      {notes.notes.length === 0 ? (
        <p className="rounded-xl p-4 text-base text-pretty text-kumo-subtle ring ring-kumo-hairline">
          No notes yet. When you tell your agent something worth keeping, such as "remember I'm vegetarian", it saves a short note here.
        </p>
      ) : (
        <ul aria-label="Your agent's notes" className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline">
          {notes.notes.map((note) => (
            <li key={note.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-base text-pretty break-words">{note.text}</p>
                <p className="mt-0.5 text-[13px] text-kumo-subtle">
                  {WHOSE[note.source]}, {when(note.createdAt)}
                </p>
              </div>
              <Action variant="secondary" disabled={busy} aria-label={`Delete note: ${note.text.slice(0, 80)}`} onClick={() => void forget(`/api/memories/${note.id}`)}>
                Delete
              </Action>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-[13px] text-pretty text-kumo-subtle">
          {notes.notes.length} of {notes.limit} notes. Kept in your agent's storage until you delete them. Your agent never saves passwords, codes, keys or card numbers.
        </p>
        {notes.notes.length > 0 ? (
          confirming ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Forget everything?">
              <Action variant="secondary-destructive" disabled={busy} onClick={() => void forget("/api/memories")}>
                Forget all {notes.notes.length}
              </Action>
              <Action variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Keep them
              </Action>
            </div>
          ) : (
            <Action variant="secondary" onClick={() => setConfirming(true)}>
              Forget everything
            </Action>
          )
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-kumo-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
