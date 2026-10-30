import { MARKER, markersIn } from "../attachments";

/**
 * Photos selected in the User's task, not in Company text or tool arguments.
 * Selection is not an instruction to upload: the upload must still serve the
 * User's task, at a Company that task authorizes. An unselected file needs the
 * User's separate disclosure decision. No model tool can manufacture this
 * context by setting an `approved` flag.
 */
export class TaskFiles {
  private constructor(private readonly ids: ReadonlySet<string>) {}

  static none(): TaskFiles { return new TaskFiles(new Set()); }

  /** `task` and `history` contain only genuine User messages, never our notices. */
  static fromUser(task: string, history: readonly string[]): TaskFiles {
    const selected = new Set(markersIn(task));
    const names = new Map<string, Set<string>>();
    for (const text of history) {
      for (const match of text.matchAll(MARKER)) {
        const name = match[0].split(" · ")[1];
        if (!name) continue;
        const ids = names.get(name) ?? new Set<string>();
        ids.add(match[1]!);
        names.set(name, ids);
      }
    }
    // A filename must identify one photo and be named as a whole filename,
    // not appear inside another name. Ambiguous names keep the consent card.
    for (const [name, ids] of names) {
      if (ids.size === 1 && namesFile(task, name)) for (const id of ids) selected.add(id);
    }
    // Ordinary follow-ups can refer to the last User-selected photo(s).
    // A singular reference cannot silently choose among a batch of photos.
    const recent = history.slice().reverse().map(markersIn).find(ids => ids.length > 0) ?? [];
    const plural = /\b(?:these|those|my|the attached) (?:photos|pictures|images)\b/i.test(task);
    const singular = /\b(?:(?:this|that|my|the attached) (?:photo|picture|image)|the (?:photo|picture|image) I (?:attached|uploaded|sent))\b/i.test(task);
    if (selected.size === 0 && (plural || (singular && new Set(recent).size === 1))) for (const id of recent) selected.add(id);
    return new TaskFiles(selected);
  }

  includes(ids: readonly string[]): boolean { return ids.every(id => this.ids.has(id)); }
}

function namesFile(text: string, name: string): boolean {
  const part = /[\p{L}\p{N}_.-]/u;
  let at = text.indexOf(name);
  while (at >= 0) {
    const before = Array.from(text.slice(0, at)).at(-1) ?? "";
    const after = Array.from(text.slice(at + name.length))[0] ?? "";
    if (!part.test(before) && !part.test(after)) return true;
    at = text.indexOf(name, at + 1);
  }
  return false;
}
