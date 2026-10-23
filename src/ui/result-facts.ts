/**
 * What a Company answered, as a few facts a person can read, and raw text
 * with the queries taken out of its URLs. Pure, so it is tested on its own
 * (test/ui/result-facts.test.ts and a property in test/properties/).
 *
 * A URL's query or fragment can carry a signature or a token: a signed
 * preview link works for whoever holds it. The log never records one
 * (src/log.ts), and neither does the page: nothing here ever returns one.
 */

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\]+/gi;

/** Text with every URL's query and fragment replaced by "…": `https://a.example/p?sig=x` → `https://a.example/p?…`. */
export function redactQueries(text: string): string {
  return text.replace(URL_IN_TEXT, (url) => {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : `${url.slice(0, cut)}${url[cut]}…`;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names that may hold a credential: their values are never shown. */
const SECRET_KEY = /token|secret|password|passcode|key|sig|signature|credential|cookie|code/i;

const FACT_LIMIT = 5;
const VALUE_LIMIT = 40;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > VALUE_LIMIT ? `${flat.slice(0, VALUE_LIMIT - 1)}…` : flat;
}

/** A key as words: `lowResolution` → "low resolution". */
function words(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * An approval's raw result (the agent's `{"status":201,"body":{…}}`, cut at
 * 2,000 characters) as facts: the HTTP status, then up to five plain values
 * from the body's top level, width and height as one. Nested objects, arrays,
 * URLs and anything under a name that may hold a credential are left out.
 * Text that isn't such JSON gives no facts: it is the agent's own sentence,
 * which the card shows as it is.
 */
export function resultFacts(result: string | undefined): { status: number | null; facts: string[] } {
  if (!result) return { status: null, facts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // Cut short at 2,000 characters: the status is still at the start.
    const status = /^\{"status":(\d{3})\b/.exec(result);
    return { status: status ? Number(status[1]) : null, facts: [] };
  }
  if (!isRecord(parsed)) return { status: null, facts: [] };
  const status = typeof parsed.status === "number" && Number.isInteger(parsed.status) ? parsed.status : null;
  const body = parsed.body;
  const facts: string[] = [];
  if (Array.isArray(body)) facts.push(`${body.length} ${body.length === 1 ? "item" : "items"}`);
  if (isRecord(body)) {
    const { width, height } = body;
    const size = typeof width === "number" && typeof height === "number" ? `${width}×${height}` : null;
    let sizeShown = false;
    for (const [key, value] of Object.entries(body)) {
      if (facts.length >= FACT_LIMIT) break;
      if (SECRET_KEY.test(key)) continue;
      if (size && (key === "width" || key === "height")) {
        if (!sizeShown) facts.push(size);
        sizeShown = true;
        continue;
      }
      if (typeof value === "string") {
        if (value === "" || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
        facts.push(`${words(key)} ${clip(value)}`);
      } else if (typeof value === "number" && Number.isFinite(value)) {
        // A number this size is a time in milliseconds or seconds, not something to read.
        if (/(created|updated|_at$|time|date)/i.test(key)) continue;
        facts.push(`${words(key)} ${value}`);
      } else if (typeof value === "boolean") {
        if (value) facts.push(words(key));
      }
    }
  }
  // Whatever a key or value held, no fact carries a URL.
  return { status, facts: facts.filter((fact) => !fact.includes("://")) };
}
