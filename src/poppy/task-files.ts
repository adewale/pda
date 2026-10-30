import { MARKER, markersIn } from "../attachments";
import { recipientCue, taskText } from "./task-text";

/**
 * Files available for the genuine User's task, never an instruction to upload.
 * The model must still determine that disclosure serves that task. Company
 * words and model-supplied permission flags cannot manufacture this context.
 */
export class TaskFiles {
  private constructor(private readonly ids: ReadonlySet<string>) {}

  static none(): TaskFiles { return new TaskFiles(new Set()); }

  /** Names are task data, not additional Company destinations. */
  static names(history: readonly string[]): readonly string[] {
    return [...new Set(history.flatMap(text => [...text.matchAll(MARKER)].map(match => match[0].split(" · ")[1] ?? "")).filter(Boolean))];
  }

  /** `task` and `history` are original placed User inputs, not model summaries. */
  static fromUser(task: string, history: readonly string[]): TaskFiles {
    const selected = new Set(markersIn(task));
    const narrative = taskText(task.replace(MARKER, "")).narrative;
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
    const spans = [...names].flatMap(([name, ids]) => fileSpans(narrative, name).map(span => ({ ...span, ids, name })));
    // Longest complete known filenames win over contained suffixes. Crossing
    // overlaps and duplicate names remain ambiguous rather than choosing a file.
    const maximal = maximalSpans(spans);
    for (const span of maximal) {
      if (span.selectable && span.ids.size === 1 && !maximal.some(other => other !== span && other.start < span.end && span.start < other.end)) {
        for (const id of span.ids) selected.add(id);
      }
    }
    // Even unresolved filename spans are data, not ordinary "this photo"
    // references. Network locators were already removed as opaque spans.
    // String offsets are UTF-16; replace spans without changing their offsets.
    const plain = spans.filter(span => span.selectable || (/[\s.]/u.test(span.name) && !recipientCue(narrative, span.start))).reduce((text, span) => text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end), narrative);
    const unresolvedName = [...plain.matchAll(/\S+/gu)].some(match => /\.(?:jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)["'”’»)\],.!?;:]*$/iu.test(match[0]) && !recipientCue(plain, match.index));
    const recent = history.slice().reverse().map(markersIn).find(ids => ids.length > 0) ?? [];
    // Match complete whitespace-delimited phrases, with sentence punctuation,
    // rather than borrowing a noun from any kind of filename continuation.
    const plural = /(?:^|\s)[(\["'“‘«]*(?:these|those|my|the attached) (?:photos|pictures|images)["'”’»)\].,!?;:]*(?=\s|$)/iu.test(plain);
    const singular = /(?:^|\s)[(\["'“‘«]*(?:(?:this|that|my|the attached) (?:photo|picture|image)|the (?:photo|picture|image) I (?:attached|uploaded|sent))["'”’»)\].,!?;:]*(?=\s|$)/iu.test(plain);
    if (selected.size === 0 && !unresolvedName && (plural || (singular && new Set(recent).size === 1))) for (const id of recent) selected.add(id);
    return new TaskFiles(selected);
  }

  includes(ids: readonly string[]): boolean { return ids.every(id => this.ids.has(id)); }
}

function fileSpans(text: string, name: string): { start: number; end: number; selectable: boolean }[] {
  return nameSpans(text, name).map(span => {
    const before = Array.from(text.slice(0, span.start)).at(-1) ?? "";
    const after = Array.from(text.slice(span.end))[0] ?? "";
    const quoted = ["''", '\"\"', "‘’", "“”", "«»"].includes(before + after);
    const selectable = !recipientCue(text, span.start) && (/\.(?:jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i.test(name) || quoted || /\b(?:named|called|filename is) $/i.test(text.slice(0, span.start)));
    return { ...span, selectable };
  });
}

export function maximalSpans<T extends { start: number; end: number }>(spans: readonly T[]): T[] {
  return spans.filter(span => !spans.some(other => other.start <= span.start && other.end >= span.end && (other.start < span.start || other.end > span.end)));
}

export function nameSpans(text: string, name: string): { start: number; end: number }[] {
  const part = /[\p{L}\p{M}\p{N}\p{Cf}_.-]/u;
  const spans: { start: number; end: number }[] = [];
  let at = text.indexOf(name);
  while (at >= 0) {
    const before = Array.from(text.slice(0, at)).at(-1) ?? "";
    const after = Array.from(text.slice(at + name.length))[0] ?? "";
    const sentenceEnd = /^\.(?:\s|$|["'”’])/u.test(text.slice(at + name.length));
    if (!part.test(before) && (!part.test(after) || sentenceEnd)) spans.push({ start: at, end: at + name.length });
    at = text.indexOf(name, at + 1);
  }
  return spans;
}
