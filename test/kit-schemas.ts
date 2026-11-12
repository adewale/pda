import upstream from "../spec/upstream.json";
import { validateSchema as validate04 } from "../spec/company-kit-2026-11-11/kit/validate/schema.ts";
import type { AgentPayload } from "./mock-company/types";

/**
 * The official kit's JSON Schemas as an oracle for what our agent sends
 * (docs/poppy-0.4-upgrade.md, V0). The kit is written for Companies, so its
 * schemas judge our agent independently of our mock and validator: the
 * schemas and their validator are the pinned, unmodified kit files.
 *
 * Each payload the mock captured is checked against the schema for what it
 * is: the Session JWT and its delegation, the client metadata, an approval
 * (the `Poppy-Approval` header, or MCP `_meta`), and the JSON bodies of the
 * protocol's own endpoints. API bodies are the Company's to define, and the
 * kit has no schema for them.
 *
 * A request's kit is the version its `Poppy-Version` declares (3.4), else
 * the caller's default, 0.4, as for the client metadata, which a Company
 * fetches without one. The 0.3 kit stays pinned as history (decision 49).
 */

/** Schemas by kit, keyed by file name. A glob needs a literal path, so a re-pin updates this map (KIT_PATHS checks it). */
const SCHEMAS: Record<string, Record<string, object>> = {
  "0.4": fileNames(import.meta.glob("../spec/company-kit-2026-11-11/kit/schemas/*.schema.json", { eager: true, import: "default" }))
};
/** Each kit's own validator, so a kit is judged only by its own files. */
const VALIDATORS: Record<string, typeof validate04> = { "0.4": validate04 };
const KIT_PATHS: Record<string, string> = { "0.4": "spec/company-kit-2026-11-11" };
for (const [version, kit] of Object.entries(KIT_PATHS)) {
  const pin = upstream.pins.find((candidate) => candidate.protocolVersion === version);
  if (pin?.kit !== kit) throw new Error(`test/kit-schemas.ts reads the ${version} kit from ${kit}, but spec/upstream.json pins ${pin?.kit}`);
}

function fileNames(modules: Record<string, unknown>): Record<string, object> {
  return Object.fromEntries(Object.entries(modules).map(([path, schema]) => [path.slice(path.lastIndexOf("/") + 1), schema as object]));
}

/** The protocol endpoints whose JSON bodies a kit describes, by path on a mock Company host; a kit without the schema skips it. */
const BODY_SCHEMAS: readonly [RegExp, string][] = [
  [/^\/poppy\/conversations$/, "conversation-request.schema.json"],
  [/^\/poppy\/conversations\/[^/]+\/messages$/, "conversation-message-request.schema.json"],
  // Handoff, its cancel, and close carry a request ID (8.3).
  [/^\/poppy\/conversations\/[^/]+\/(?:handoff(?:\/cancel)?|close)$/, "conversation-action-request.schema.json"],
  [/^\/poppy\/feedback$/, "feedback-report.schema.json"],
  [/^\/poppy\/browser-session\/authorize$/, "browser-session-authorize.schema.json"]
];

/** Each schema error in what the agent sent, as `<what> (<schema>) <pointer>: <message>`. */
export function kitSchemaErrors(sent: readonly AgentPayload[], version = "0.4"): string[] {
  return checkSent(sent, version).errors;
}

/** The kit schemas that what the agent sent was checked against, so a test can show the check ran. */
export function kitSchemasApplied(sent: readonly AgentPayload[], version = "0.4"): string[] {
  return [...checkSent(sent, version).applied].sort();
}

function checkSent(sent: readonly AgentPayload[], fallback: string): { errors: string[]; applied: Set<string> } {
  const errors: string[] = [];
  const applied = new Set<string>();
  const check = (version: string, what: string, name: string, value: unknown) => {
    const schemas = SCHEMAS[version];
    if (!schemas) {
      errors.push(`${what}: Poppy-Version ${version} has no pinned kit`);
      return;
    }
    const schema = schemas[name];
    if (!schema) throw new Error(`The ${version} kit has no ${name}`);
    applied.add(name);
    for (const error of VALIDATORS[version]!(schema, value, schemas)) errors.push(`${what} (${name}) ${error.path || "/"}: ${error.message}`);
  };
  for (const payload of sent) {
    const where = `${payload.method} ${payload.url}`;
    const version = payload.version ?? fallback;
    if (payload.clientMetadata !== undefined) {
      for (const kit of Object.keys(SCHEMAS)) check(kit, `client metadata at ${payload.url}`, "client-metadata.schema.json", payload.clientMetadata);
    }
    if (payload.sessionJwt) check(version, `Session JWT of ${where}`, "session-jwt.schema.json", payload.sessionJwt);
    if (payload.delegation) check(version, `delegation of ${where}`, "delegation.schema.json", payload.delegation);
    if (payload.approval !== undefined) {
      const approval = parseDictionary(payload.approval);
      if (approval) check(version, `Poppy-Approval of ${where}`, "approval.schema.json", approval);
      else errors.push(`Poppy-Approval of ${where}: not an RFC 9651 Dictionary`);
    }
    if (payload.json === undefined || payload.method !== "POST") continue;
    const path = new URL(payload.url).pathname;
    const body = BODY_SCHEMAS.find(([pattern, name]) => pattern.test(path) && SCHEMAS[version]?.[name]);
    if (body) check(version, `body of ${where}`, body[1], payload.json);
    const meta = mcpApproval(payload.json);
    if (meta !== undefined) check(version, `MCP approval in ${where}`, "approval.schema.json", meta);
  }
  return { errors, applied };
}

/** The approval in an MCP `tools/call`'s `_meta` (Operations 6), if any. */
function mcpApproval(message: unknown): unknown {
  if (typeof message !== "object" || message === null || (message as { method?: unknown }).method !== "tools/call") return undefined;
  const meta = (message as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
  return meta?.["personalagentprotocol.org/approval"];
}

/**
 * An RFC 9651 Dictionary (4.2.2) as a plain object of its bare items:
 * Strings, Tokens, Integers, Decimals and Booleans, parameters dropped.
 * Null when it doesn't parse. Written here rather than shared with the
 * mock, so the oracle doesn't inherit the mock's reading.
 */
export function parseDictionary(field: string): Record<string, string | number | boolean> | null {
  const members: Record<string, string | number | boolean> = {};
  let rest = field.replace(/^ +| +$/g, "");
  const take = (pattern: RegExp): string | null => {
    const match = pattern.exec(rest);
    if (!match) return null;
    rest = rest.slice(match[0].length);
    return match[0];
  };
  const bareItem = (): string | number | boolean | null => {
    if (rest.startsWith('"')) {
      const quoted = take(/^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"/);
      return quoted === null ? null : quoted.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    if (rest.startsWith("?")) {
      const flag = take(/^\?[01]/);
      return flag === null ? null : flag === "?1";
    }
    const number = take(/^-?\d{1,15}(?:\.\d{1,3})?(?![\d.])/);
    if (number !== null) return Number(number);
    return take(/^[A-Za-z*][\x21\x23-\x27\x2a\x2b\x2d-\x3a\x41-\x5a\x5e-\x7a\x7c\x7e]*/);
  };
  while (rest !== "") {
    const key = take(/^[a-z*][a-z0-9_\-.*]*/);
    if (key === null) return null;
    let value: string | number | boolean | null = true;
    if (take(/^=/) !== null) value = bareItem();
    if (value === null) return null;
    while (take(/^;\s*/) !== null) {
      if (take(/^[a-z*][a-z0-9_\-.*]*/) === null) return null;
      if (take(/^=/) !== null && bareItem() === null) return null;
    }
    members[key] = value;
    if (rest === "") break;
    if (take(/^[ \t]*,[ \t]*/) === null || rest === "") return null;
  }
  return members;
}
