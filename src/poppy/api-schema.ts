/** JSON Schema validation, local reference expansion and parameter diagnostics. */
import { type Json, isObject } from "./json";
import { type JsonBody, type OpenApiOperation, type OpenApiCall } from "./openapi-document";
import { type Company } from "./discovery";
import { PoppyError } from "./client";
import { type OutputUnit, Validator } from "@cfworker/json-schema";
import { given } from "./openapi-request";

export function resolveRef(root: Json, value: Json, depth = 0): Json {
  if (depth > 8 || !isObject(value) || typeof value.$ref !== "string") return value;
  const path = value.$ref.replace(/^#\//, "").split("/");
  let current: Json = root;
  for (const part of path) {
    if (!isObject(current)) return value;
    current = current[part.replace(/~1/g, "/").replace(/~0/g, "~")] ?? null;
  }
  return resolveRef(root, current, depth + 1);
}

/** One JSON Pointer reference token (RFC 6901). */
export function pointerPart(name: string): string {
  return name.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Where an operation's JSON request body schema is. `raw` is the operation's
 * `requestBody` as written (perhaps a `$ref`), `resolved` the object it names,
 * and `at` the pointer to `raw`. OpenAPI 3.0's schemas are read as draft 4
 * with `nullable` folded into `type`; 3.1's are JSON Schema 2020-12.
 */
export function jsonBodyOf(root: Json, raw: Json | undefined, resolved: Json | undefined, at: string): JsonBody | undefined {
  if (!isObject(resolved) || !isObject(resolved.content) || !isObject(root)) return undefined;
  const media = Object.keys(resolved.content).find((type) => /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i.test(type));
  if (!media || !isObject(resolved.content[media]) || (resolved.content[media] as Record<string, Json>).schema === undefined) return undefined;
  const base = isObject(raw) && typeof raw.$ref === "string" && raw.$ref.startsWith("#/") ? raw.$ref.slice(1) : at;
  const v30 = typeof root.openapi === "string" && root.openapi.startsWith("3.0.");
  return {
    required: resolved.required === true,
    root: v30 ? foldNullable(root) : root,
    pointer: `${base}/content/${pointerPart(media)}/schema`,
    draft: v30 ? "4" : "2020-12"
  };
}

/** OpenAPI 3.0's `nullable: true` as JSON Schema: `null` added to `type`. */
export function foldNullable(value: Json): Json {
  if (Array.isArray(value)) return value.map(foldNullable);
  if (!isObject(value)) return value;
  const out: Record<string, Json> = {};
  for (const [key, member] of Object.entries(value)) if (key !== "nullable") out[key] = foldNullable(member);
  if (value.nullable === true && typeof value.type === "string") out.type = [value.type, "null"];
  return out;
}

/** A schema with its `$ref`s written out, to a depth and a size, so the model sees the fields it must send. */
export function inlineRefs(root: Json, value: Json, depth = 0): Json {
  if (depth > 6) return value;
  const resolved = resolveRef(root, value);
  if (Array.isArray(resolved)) return resolved.map((member) => inlineRefs(root, member, depth + 1));
  if (!isObject(resolved)) return resolved;
  const out: Record<string, Json> = {};
  for (const [key, member] of Object.entries(resolved)) out[key] = inlineRefs(root, member, depth + 1);
  return out;
}

const BODY_BASE = "https://openapi.invalid/description";

/**
 * A JSON body is checked against the operation's request schema before a
 * card or a request, so a mistake comes back to the model as a correction,
 * not as the Company's 400 after the User approved it. A string where the
 * schema wants an object is the commonest: the model serialised the body
 * itself, and our client would serialise it again. Strings aren't parsed for
 * the model, as an API may take a JSON string. A schema we can't read
 * refuses nothing: the Company decides.
 */
export function checkBody(company: Company, op: OpenApiOperation, body: Json | undefined): void {
  const spec = op.jsonBody;
  if (!spec) return;
  if (body === undefined) {
    if (!spec.required) return;
    throw new PoppyError("invalid_body", `${op.method} ${op.path} (${op.operationId}) at ${company.name} needs a JSON body: see its requestBody in poppy_api_describe. Nothing was sent.`, 0);
  }
  let errors: readonly OutputUnit[];
  try {
    const validator = new Validator({ $ref: `${BODY_BASE}#${spec.pointer}` }, spec.draft, false);
    validator.addSchema(spec.root as never, BODY_BASE); // The library types a schema narrower than JSON; a schema it can't read throws, below.
    errors = validator.validate(body).errors;
  } catch {
    return;
  }
  if (errors.length === 0) return;
  const serialised = serialisedJson(errors, body, "body", `for ${op.operationId} at ${company.name}`);
  if (serialised) throw new PoppyError("invalid_body", `${serialised} Nothing was sent.`, 0);
  const shown = leafErrors(errors, "body");
  throw new PoppyError(
    "invalid_body",
    `body for ${op.operationId} at ${company.name} doesn't match its request schema: ${shown.join("; ")}. See its requestBody in poppy_api_describe. Nothing was sent.`,
    0
  );
}

/**
 * Where a schema refused a string of serialised JSON (an object or array),
 * a correction naming each such place; null when there is none.
 * The model serialised the value itself, at the top or deeper in, and our
 * client would serialise it again. Strings are never parsed for it.
 */
export function serialisedJson(errors: readonly OutputUnit[], value: Json, where: string, context: string): string | null {
  const found = new Map<string, "object" | "array">();
  for (const { instanceLocation } of errors) {
    const at = atPointer(value, instanceLocation.replace(/^#/, ""));
    if (typeof at !== "string" || !/^\s*[{[]/.test(at)) continue;
    try {
      const parsed: unknown = JSON.parse(at);
      if (parsed !== null && typeof parsed === "object") {
        found.set(`${where}${instanceLocation.replace(/^#/, "")}`, Array.isArray(parsed) ? "array" : "object");
      }
    } catch {
      // Not JSON: the schema's own errors say what's wrong.
    }
  }
  if (found.size === 0) return null;
  const names = [...found.keys()].join(", ");
  const as = found.size === 1 ? `a structured ${[...found.values()][0]}` : "structured values";
  return `${names} ${context} must be the JSON value itself, such as {"product": "prints"}, not a string containing serialised JSON: pass ${names} as ${as}.`;
}

/** The value at a JSON Pointer (RFC 6901) in `value`, or undefined. */
function atPointer(value: Json, pointer: string): Json | undefined {
  let current: Json | undefined = value;
  for (const part of pointer.split("/").slice(1)) {
    const name = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) current = current[Number(name)];
    else if (isObject(current)) current = current[name];
    else return undefined;
  }
  return current;
}

/** The JSON Schema dialects a description's schemas are read in. */
export type SchemaDraft = "4" | "7" | "2019-09" | "2020-12";

/** A value's errors against a schema, the leaves first; null when the schema can't be read (which refuses nothing). */
export function schemaErrors(schema: Json, value: Json, draft: SchemaDraft): readonly OutputUnit[] | null {
  try {
    return new Validator(schema as never, draft, false).validate(value).errors; // As in checkBody: the library's schema type is narrower than JSON.
  } catch {
    return null;
  }
}

/** The leaves of a validation: the wrappers ($ref, properties, allOf…) only say a child failed. */
export function leafErrors(errors: readonly OutputUnit[], where: string, limit = 5): string[] {
  const leaves = errors.filter((unit) => !/subschema had errors|does not match schema|did not match/i.test(unit.error));
  return (leaves.length ? leaves : errors).slice(0, limit).map((unit) => `${unit.instanceLocation.replace(/^#/, where) || where}: ${unit.error}`);
}

/**
 * The other readings of a parameter value: a path or query value is text on
 * the wire, so a number the model gives where the schema wants a string, or
 * a string that reads as the number or boolean it wants, is that value.
 */
function readings(value: string | number | boolean): Json[] {
  if (typeof value !== "string") return [String(value)];
  if (value === "true" || value === "false") return [value === "true"];
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value) ? [Number(value)] : [];
}

/**
 * Each parameter the call gives is checked against its schema before a card
 * or a request, as a JSON body is, so a mistake comes back to the model as a
 * correction. A value passes in any of its readings as text (`readings`).
 * A schema we can't read refuses nothing: the Company decides.
 */
export function checkParams(company: Pick<Company, "name">, op: OpenApiOperation, params: OpenApiCall["params"]): void {
  const problems: string[] = [];
  for (const { name, schema } of op.parameters) {
    const value = given(params, name);
    if (value === undefined) continue;
    if (op.parameters.some((parameter) => parameter.name === name && parameter.in === "header") && /[^\t\x20-\x7e]/.test(String(value))) {
      problems.push(`params.${name}: a header value must be one line of printable ASCII`);
      continue;
    }
    if (schema === undefined) continue;
    const errors = schemaErrors(schema, value, op.schemaDraft);
    if (!errors || errors.length === 0) continue;
    if (readings(value).some((reading) => schemaErrors(schema, reading, op.schemaDraft)?.length === 0)) continue;
    problems.push(...leafErrors(errors, `params.${name}`, 3));
  }
  if (problems.length === 0) return;
  throw new PoppyError(
    "invalid_params",
    `params for ${op.operationId} at ${company.name} don't match their schemas: ${problems.slice(0, 5).join("; ")}. See its parameters in poppy_api_describe. Nothing was sent.`,
    0
  );
}
