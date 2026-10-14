/**
 * The pure half of `scripts/deps-check.mjs`: npm's JSON in, Markdown out. No
 * process, file or network access, so `test/deps-check.test.ts` runs it on
 * fixtures.
 */

/** What running npm gave: its parsed JSON, or why there was none. */
export type NpmResult = { json: unknown; error?: undefined } | { error: string; json?: undefined };

type Outdated = { current?: string; wanted?: string; latest?: string; type?: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const cell = (value: unknown) => String(value ?? "").replaceAll("|", "\\|");

/** A Markdown table. */
export function table(header: string[], rows: unknown[][]): string {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

const major = (version: unknown) => Number.parseInt(String(version).split(".")[0] ?? "", 10);

/**
 * npm's own failure, when its JSON is one: `{"error": {"code", "summary",
 * "detail"}}`, which `npm outdated` and `npm audit` print instead of a
 * report. A package named `error` would have versions, not a summary.
 */
export function npmError(json: unknown): string | null {
  if (!isObject(json) || !isObject(json.error)) return null;
  const error = json.error;
  if ("wanted" in error || "latest" in error || "current" in error) return null;
  if (!("summary" in error) && !("code" in error) && !("detail" in error)) return null;
  const said = [error.code, error.summary].filter((part) => typeof part === "string" && part !== "").join(": ");
  return said || JSON.stringify(error).slice(0, 500);
}

/** The "Outdated packages" section's lines. Information only: nothing here fails the check, an npm failure included. */
export function outdatedSection(result: NpmResult): string[] {
  const failure = result.error ?? npmError(result.json);
  if (failure !== null) return [`Couldn't list outdated packages: ${failure}`, ""];
  if (!isObject(result.json)) return [`Couldn't list outdated packages: npm outdated printed something that isn't an object`, ""];
  const listed = result.json;
  const names = Object.keys(listed).sort();
  if (names.length === 0) return ["Every direct dependency is at its latest version.", ""];
  const rows = names.map((name) => {
    const entry = listed[name];
    const info: Outdated = (Array.isArray(entry) ? entry[0] : entry) ?? {};
    const kind = info.type === "devDependencies" ? "dev" : info.type === "dependencies" ? "prod" : (info.type ?? "");
    const notes: string[] = [];
    if (info.current === undefined || info.current === "MISSING") notes.push("not installed");
    else {
      if (info.wanted !== info.current) notes.push("update in range");
      if (major(info.latest) > major(info.current)) notes.push("new major");
      else if (info.latest !== info.wanted) notes.push("outside range");
    }
    return [name, kind, info.current ?? "missing", info.wanted, info.latest, notes.join(", ")];
  });
  return [
    `${names.length} direct ${names.length === 1 ? "dependency is" : "dependencies are"} behind. ` +
      '"update in range": `npm update` would take it to Wanted; "outside range" and "new major": reaching Latest means changing `package.json`. Information only; nothing here fails the check.',
    "",
    table(["Package", "Type", "Current", "Wanted", "Latest", "Note"], rows),
    ""
  ];
}
