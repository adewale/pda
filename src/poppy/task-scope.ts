import { MARKER } from "../attachments";

function recipient(value: string): string {
  try { return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase().replace(/\.(?=:|$)/, ""); }
  catch { return ""; }
}

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
      const dataWords = new Set(filenames.flatMap(name => name.toLowerCase().split(/[^a-z0-9.@-]+/).map(word => word.replace(/\.+$/, ""))));
      const explicit = new Set<string>();
      this.#task = task.replace(MARKER, "")
        .replace(/\bhttps?:\/\/[^\s<>"\])]+/gi, value => { explicit.add(recipient(value)); return " "; })
        .replace(/(?<![a-z0-9.@-])(?:localhost|[a-z0-9.-]+\.[a-z0-9-]+\.?)(?::[0-9]+(?:[\\/?#][^\s<>"\])]*)?|[\\/?#][^\s<>"\])]*)/gi, value => { const named = recipient(value); if (!dataWords.has(named.replace(/:[0-9]+$/, ""))) explicit.add(named); return " "; })
        .replace(/[\\/?#][^\s<>"\]]*/g, "")
        .toLowerCase().split(/[^a-z0-9.@-]+/).filter(word => !dataWords.has(word.replace(/\.+$/, ""))).join(" ");
      this.#domains = explicit;
      // A literal destination already constrains the first call, not only
      // later calls after Company content. Filenames and emails aren't one.
      for (const word of this.#task.split(" ")) {
        const named = word.replace(/\.+$/, "");
        if (/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(named)) this.#domains.add(named);
      }
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
    const named = words.split(/[^a-z0-9.@-]+/).some((word) => word.replace(/\.+$/, "") === host);
    if (named || (!this.#foreign && this.#domains.size === 0 && words && (this.first?.(this.#key, host) ?? host) === host)) {
      this.#domains.add(host);
      return true;
    }
    return false;
  }

  receivedCompanyContent(): void { this.#foreign = true; }
}
