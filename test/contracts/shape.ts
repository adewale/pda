/**
 * The shape of a wire value: its structure and types, never its values,
 * apart from the discriminators a contract names (an event's `type`, a
 * content block's `type`). Shapes are what `test/contracts/` records and
 * compares, so a fixture holds no prompt, answer, key or id, and a recording
 * made with a real key can be committed.
 */

export type Shape = string | { readonly [key: string]: Shape } | readonly Shape[];

/** Keys whose values are kept, because they name a variant rather than carry content. */
const DISCRIMINATORS = new Set(["type", "role", "object", "status", "stop_reason", "finish_reason", "stopReason"]);

/**
 * `value`'s shape: an object's keys, sorted, each with its member's shape; an
 * array's distinct element shapes, sorted; `string`, `number`, `boolean` or
 * `null` for a leaf, or a discriminator's own value, as `"=value"`.
 */
export function shapeOf(value: unknown, key?: string): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const elements = new Map<string, Shape>();
    for (const item of value) {
      const shape = shapeOf(item);
      elements.set(JSON.stringify(shape), shape);
    }
    return [...elements.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, shape]) => shape);
  }
  if (typeof value === "object") {
    const out: Record<string, Shape> = {};
    for (const name of Object.keys(value as object).sort()) out[name] = shapeOf((value as Record<string, unknown>)[name], name);
    return out;
  }
  if (typeof value === "string" && key !== undefined && DISCRIMINATORS.has(key)) return `=${value}`;
  return typeof value;
}

/** Every leaf path of a shape, `a.b[].c: string`, sorted: two shapes compare as these lists. */
export function paths(shape: Shape, at = ""): string[] {
  if (typeof shape === "string") return [`${at || "."}: ${shape}`];
  if (Array.isArray(shape)) return shape.length === 0 ? [`${at}[]: empty`] : shape.flatMap((element) => paths(element, `${at}[]`));
  const entries = Object.entries(shape);
  if (entries.length === 0) return [`${at || "."}: {}`];
  return entries.flatMap(([name, member]) => paths(member, at ? `${at}.${name}` : name));
}

/** An SSE body's events, `event:` and `data:` lines, each data parsed as JSON where it is. */
export function sseEvents(text: string): Array<{ event: string | undefined; data: unknown }> {
  const out: Array<{ event: string | undefined; data: unknown }> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    const joined = data.join("\n");
    let parsed: unknown = joined;
    try {
      parsed = JSON.parse(joined);
    } catch {
      // `[DONE]` and other plain data stay text.
    }
    out.push({ event, data: parsed });
  }
  return out;
}

/** A streamed response's shape: each kind of event (its `event:` name, or its data's `type`), with its data's shape merged. */
export function streamShape(text: string): Record<string, string[]> {
  const kinds = new Map<string, Set<string>>();
  for (const { event, data } of sseEvents(text)) {
    const kind = event ?? (typeof data === "object" && data !== null && typeof (data as { type?: unknown }).type === "string" ? (data as { type: string }).type : "data");
    const set = kinds.get(kind) ?? new Set<string>();
    for (const path of paths(shapeOf(data))) set.add(path);
    kinds.set(kind, set);
  }
  return Object.fromEntries([...kinds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, set]) => [kind, [...set].sort()]));
}

/**
 * What a fake's stream does that the recorded real one doesn't: event kinds
 * the real stream never sent, and paths of shared kinds the real one never
 * had (or had with another type). A fake may leave things out; it mustn't
 * invent them.
 */
export function inventedBy(fake: Record<string, string[]>, real: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [kind, fakePaths] of Object.entries(fake)) {
    const realPaths = real[kind];
    if (!realPaths) {
      out.push(`event ${kind}: never sent by the real API`);
      continue;
    }
    const known = new Set(realPaths);
    for (const path of fakePaths) if (!known.has(path)) out.push(`event ${kind}: ${path}`);
  }
  return out;
}
