import type { TaskAccess } from "../task-access";
import { recipient } from "./task-text";

/** Company text and prose references cannot create or expand the composer's recipient list. */
export class TaskCompanyScope {
  #domains: ReadonlySet<string> | undefined;

  update(access: TaskAccess | undefined): void {
    this.#domains = new Set(access?.companies ?? []);
  }

  allow(domain: string): boolean {
    // Direct protocol callers have no model; model hooks always initialize the scope.
    return this.#domains === undefined || this.#domains.has(recipient(domain));
  }

  receivedCompanyContent(): void { /* Structured authority is immutable throughout the turn. */ }
}
