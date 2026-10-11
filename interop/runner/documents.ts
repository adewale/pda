/**
 * Discovery documents and client metadata, as the cell's recording served
 * them, through src/validator (spec section 8). The validator fetches from
 * a fetcher that answers only from the recording, so it judges exactly the
 * bytes and headers the other side saw.
 */
import { validateClient, validateCompany, type Fetcher, type Report } from "../../src/validator/index.ts";
import { form, type Exchange } from "./har.ts";
import type { Check, Side } from "./types.ts";

/** Answers each URL with its last recorded response; anything unrecorded fails like a network error. */
export function recordedFetcher(all: readonly Exchange[]): Fetcher {
  const latest = new Map<string, Exchange>();
  for (const x of all) if (x.method === "GET") latest.set(x.url.href, x);
  return async (request) => {
    const x = latest.get(request.url);
    if (!x) throw new TypeError("not in the recording");
    const headers = new Headers();
    for (const [name, value] of x.responseHeaders) headers.set(name, value);
    const nullBody = x.status === 204 || x.status === 304 || (x.status >= 300 && x.status < 400);
    return new Response(nullBody ? null : x.responseBody, { status: x.status, headers });
  };
}

/** Validator messages that only say a document wasn't in the recording. */
const NOT_RECORDED = new Set(["http-failed"]);

function toChecks(report: Report, side: Side, what: string): Check[] {
  return report.messages
    .filter((message) => (message.severity === "error" || message.severity === "warning") && !NOT_RECORDED.has(message.id))
    .map((message) => ({
      id: `validator.${message.id}`,
      side,
      severity: message.severity as "error" | "warning",
      exchange: null,
      detail: `${what}: ${message.text}`,
      source: "validator"
    }));
}

/** Validate every Company domain whose poppy.json, and every client_id whose metadata, the recording holds. */
export async function documentChecks(all: readonly Exchange[]): Promise<Check[]> {
  const fetcher = recordedFetcher(all);
  const checks: Check[] = [];
  const domains = new Set<string>();
  const clientIds = new Set<string>();
  for (const x of all) {
    if (x.probe) continue;
    if (x.direction === "to-company" && x.method === "GET" && x.url.pathname === "/.well-known/poppy.json") domains.add(x.url.host);
    const clientId = form(x)?.get("client_id");
    if (x.direction === "to-company" && clientId) clientIds.add(clientId);
  }
  for (const domain of domains) checks.push(...toChecks(await validateCompany(fetcher, domain), "company", domain));
  for (const clientId of clientIds) {
    if (!all.some((x) => x.url.href === clientId)) continue;
    checks.push(...toChecks(await validateClient(fetcher, clientId), "agent", clientId));
  }
  return checks;
}
