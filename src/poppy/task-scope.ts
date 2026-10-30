import { domainFromInput } from "../domain";
import { MARKER } from "../attachments";

/** Company content cannot expand the set of Companies the User's task reaches. */
export class TaskCompanyScope {
  #task = "";
  #key = "";
  #domains = new Set<string>();
  #foreign = false;
  #enabled = false;

  update(task: string, foreign: boolean, key = task): void {
    this.#enabled = true;
    if (key !== this.#key) {
      this.#key = key;
      // A filename, email address or a URL's query/path is not the User
      // choosing another recipient. URLs name only their actual hostname.
      this.#task = task.replace(MARKER, "").replace(/\bhttps?:\/\/[^\s<>"\]]+/gi, value => {
        try { return new URL(value).hostname; } catch { return ""; }
      });
      this.#domains.clear();
      this.#foreign = false;
    }
    this.#foreign ||= foreign;
  }

  allow(domain: string): boolean {
    if (!this.#enabled) return true; // Direct protocol callers have no model or foreign prompt.
    const host = domainFromInput(domain);
    if (this.#domains.has(host)) return true;
    const words = this.#task.toLowerCase();
    const named = words.split(/[^a-z0-9.@-]+/).some((word) => word.replace(/\.+$/, "") === host);
    if (named || (!this.#foreign && this.#domains.size === 0 && words)) {
      this.#domains.add(host);
      return true;
    }
    return false;
  }

  receivedCompanyContent(): void { this.#foreign = true; }
}
