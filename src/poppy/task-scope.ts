import { MARKER } from "../attachments";
import { maximalSpans, nameSpans } from "./task-files";
import { recipient, recipientCue, taskText } from "./task-text";

/** Company content cannot expand the set of Companies the User's task reaches. */
export class TaskCompanyScope {
  #task = "";
  #key = "";
  #domains = new Set<string>();
  #foreign = false;
  #enabled = false;

  constructor(private readonly first?: (key: string, candidate?: string) => string | undefined) {}

  update(task: string, foreign: boolean, key = task, filenames: readonly string[] = []): void {
    this.#enabled = true;
    if (key !== this.#key) {
      this.#key = key;
      // A filename, email address or a URL's query/path is not the User
      // choosing another recipient. URLs name only their actual host and port.
      const dataWords = new Set(filenames.flatMap(name => name.toLowerCase().split(/[^\p{L}\p{N}_.@-]+/u).map(word => word.replace(/\.+$/, ""))));
      const dataHosts = new Set([...filenames, ...dataWords].map(recipient));
      const base = task.replace(MARKER, "");
      const names = maximalSpans(filenames.flatMap(name => nameSpans(base, name).map(span => ({ ...span, name }))));
      const parsed = taskText(base);
      let ambiguousDestination = false;
      const narrative = names.reduce((text, span) => {
        if (text.slice(span.start, span.end) !== span.name) return text; // Already inside an opaque locator.
        const hostName = /^[\p{L}\p{N}_.:-]+$/u.test(span.name) && span.name.includes(".");
        if (hostName && recipientCue(base, span.start)) return text;
        ambiguousDestination ||= /\b(?:at|to|with|company|shop|store)\s+[^\s]*\./iu.test(span.name);
        return text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end);
      }, parsed.narrative);
      this.#task = narrative.replace(/[\\/?#][^\s<>"\]]*/g, "")
        .toLowerCase().split(/[^\p{L}\p{N}_.@-]+/u).join(" ");
      this.#domains = new Set(parsed.locators.filter(locator => {
        if (locator.qualified || !locator.host) return true;
        const compoundName = names.some(span => span.start < locator.start && locator.start < span.end);
        const allowed = !compoundName && (locator.named || !dataHosts.has(locator.host.replace(/:[0-9]+$/, "")));
        ambiguousDestination ||= !allowed;
        return allowed;
      }).map(locator => locator.host));
      // A literal destination already constrains the first call, not only
      // later calls after Company content. Filenames and emails aren't one.
      for (const word of this.#task.split(" ")) {
        const named = word.replace(/\.+$/, "");
        if (/^(?:[\p{L}\p{N}_-]+\.)+[\p{L}][\p{L}\p{N}_-]*$/u.test(named)) this.#domains.add(recipient(named));
      }
      if (ambiguousDestination) this.#domains.add(""); // Ambiguity cannot enable an inferred recipient.
      const remembered = this.first?.(key);
      if (remembered) this.#domains.add(remembered);
      this.#foreign = false;
    }
    this.#foreign ||= foreign;
  }

  allow(domain: string): boolean {
    if (!this.#enabled) return true; // Direct protocol callers have no model or foreign prompt.
    const host = recipient(domain);
    if (!host) return false;
    if (this.#domains.has(host)) return true;
    const words = this.#task.toLowerCase();
    const named = words.split(/[^\p{L}\p{N}_.@-]+/u).some((word) => word.replace(/\.+$/, "") === host);
    if (named || (!this.#foreign && this.#domains.size === 0 && words && (this.first?.(this.#key, host) ?? host) === host)) {
      this.#domains.add(host);
      return true;
    }
    return false;
  }

  receivedCompanyContent(): void { this.#foreign = true; }
}
