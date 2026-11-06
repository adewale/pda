import type { TaskAccess } from "../task-access";

/** File permission is the composer's explicit selection for this exact Company. Prose grants nothing. */
export class TaskFiles {
  private constructor(private readonly ids: ReadonlySet<string>) {}
  static none(): TaskFiles { return new TaskFiles(new Set()); }
  static selected(access: TaskAccess | undefined, company: string): TaskFiles {
    return new TaskFiles(new Set(access?.uploads.find(upload => upload.company === company)?.files ?? []));
  }
  includes(ids: readonly string[]): boolean { return ids.length > 0 && ids.every(id => this.ids.has(id)); }
}
