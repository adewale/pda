import {
  Company,
  HttpError,
  json,
  randomId,
  resourceError,
  type Inbound,
  type ResourceContext
} from "./core";
import { parseApprovalHeader, type Operations } from "./operations";
import type { McpExchange, McpVersion } from "./types";

const MCP_LEGACY = "2025-06-18";
const MCP_MODERN = "2026-07-28";
/** Versions that open with `initialize` (MCP 2026-07-28 Versioning, "Terminology"): their header asks for a session, not per-request metadata. */
const LEGACY_MCP_VERSIONS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
/** The `_meta` keys MCP 2026-07-28 reserves for each request's protocol fields (Base Protocol, "_meta"). */
const MCP_META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo"
} as const;

type McpMessage = { readonly method: string; readonly params?: unknown };
type McpOutcome = { result: Record<string, unknown> } | { error: { code: number; message: string } };
type McpFailure = (status: number, code: number, message: string, data?: unknown) => Response;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A mirrored header's value (MCP 2026-07-28 Streamable HTTP, "Value Encoding"): Base64 UTF-8 between `=?base64?` and `?=`, else as sent. */
function headerValue(sent: string | null): string | null {
  if (sent === null) return null;
  const encoded = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(sent);
  if (!encoded) return sent;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded[1]!), (char) => char.charCodeAt(0)));
  } catch {
    return "\u0000undecodable";
  }
}

/** The arguments a tool mirrors into `Mcp-Param-{name}` headers: `x-mcp-header`, reached through `properties` alone. */
function headerParameters(schema: unknown, path: readonly string[] = []): { header: string; path: readonly string[] }[] {
  return Object.entries(record(record(schema)?.properties) ?? {}).flatMap(([key, child]) => {
    const here = [...path, key];
    const header = record(child)?.["x-mcp-header"];
    return [...(typeof header === "string" ? [{ header, path: here }] : []), ...headerParameters(child, here)];
  });
}

const PRODUCTS = [
  { sku: "stormline-m", name: "Stormline Jacket (M)", price: { amount: "180.00", currency: "USD" } },
  {
    sku: "stormline-insulated-m",
    name: "Stormline Insulated Jacket (M)",
    price: { amount: "250.00", currency: "USD" }
  }
];

function orderFor(account: string) {
  return {
    order_id: "ord_7Hk2",
    account,
    placed_at: "2026-09-30T10:15:00-07:00",
    items: [{ item_id: "itm_4Qa", sku: "stormline-m", name: "Stormline Jacket (M)" }]
  };
}

/** The print shop's largest photo. */
const PHOTO_LIMIT = 5 * 1024 * 1024;

type PrintOrder = {
  email?: unknown;
  ship_to?: { name?: unknown; line1?: unknown; city?: unknown; postal_code?: unknown; country?: unknown };
  items?: { photo_id?: unknown; copies: number }[];
};

type Part = { name: string | null; filename: string | null; disposition: string; bytes: Uint8Array };

/** The type of a photo the print shop takes, from its first bytes. */
function photoType(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** The parts of a `multipart/form-data` body (RFC 7578, RFC 2046 5.1), or null if it doesn't parse. */
function parseMultipart(body: Uint8Array, boundary: string): Part[] | null {
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const parts: Part[] = [];
  let at = indexOf(body, delimiter, 0);
  if (at === -1) return null;
  for (;;) {
    const start = at + delimiter.length;
    // `--` after a delimiter closes the body.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) return parts;
    const next = indexOf(body, encoder.encode(`\r\n--${boundary}`), start);
    if (next === -1) return null;
    const part = body.slice(start + 2, next);
    const split = indexOf(part, encoder.encode("\r\n\r\n"), 0);
    if (split === -1) return null;
    const headers = new TextDecoder().decode(part.slice(0, split));
    const disposition = /^content-disposition:\s*(.*)$/im.exec(headers)?.[1]?.trim() ?? "";
    const formData = /^form-data\b/i.test(disposition);
    parts.push({
      name: formData ? (/;\s*name="([^"]*)"/i.exec(disposition)?.[1] ?? null) : null,
      filename: /;\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? null,
      disposition,
      bytes: part.slice(split + 4)
    });
    at = next + 2;
  }
}

/** The Company's OpenAPI API and MCP server (spec section 7). */
export class Apis {
  readonly #idempotency = new Map<string, { hash: string; status: number; body: unknown }>();
  /** Idempotency-Keys sent on writes without an approval, which an approved request must not reuse (Ops 6). */
  readonly #unapprovedKeys = new Set<string>();
  /** The print shop's photos, each belonging to the Session that uploaded it. */
  readonly #photos = new Map<string, { sessionId: string; name: string; type: string; size: number }>();
  /** 2025-06-18 sessions by `Mcp-Session-Id`: the version `initialize` negotiated, and whether `notifications/initialized` came. */
  readonly #mcpSessions = new Map<string, { initialized: boolean; version: McpVersion }>();
  readonly #mcpLog: McpExchange[] = [];

  constructor(
    readonly company: Company,
    readonly operations: Operations
  ) {}

  openapiDocument() {
    const api = this.company.hosts.api;
    const { read, write } = this.company.orderScopes;
    // Each operation declares the scopes it needs in its security requirement.
    const secured = (...scopes: string[]) => (this.company.config.describesSecurity ? { security: [{ session: scopes }] } : {});
    return {
      openapi: "3.1.0",
      info: {
        title: `Mock Shop ${this.company.id} API`,
        version: "1.0.0",
        description:
          "Orders and exchanges. POST /orders/{order_id}/exchanges asks for the User's approval of its terms (Operations extension) from Personal Agents that support it."
      },
      servers: [{ url: this.company.config.openapiServerOverride ?? api }],
      components: {
        ...(this.company.config.describesSecurity
          ? {
              securitySchemes: {
                // The Company's access tokens (spec 7), with its scopes described (4.7).
                session: {
                  type: "oauth2",
                  description: "Personal Agent Protocol access token, with the Session header",
                  flows: {
                    authorizationCode: {
                      authorizationUrl: `${this.company.hosts.issuer.replace(/\/$/, "")}/authorize`,
                      tokenUrl: this.company.hosts.tokenEndpoint,
                      scopes: { [read]: "Read your orders", [write]: "Exchange items on your orders", addresses: "Read your saved addresses" }
                    }
                  }
                },
                // print-with-poppy's non-Poppy way in, which an agent never uses (docs/readings.md).
                ...(this.company.config.printShop
                  ? { guest: { type: "http", scheme: "bearer", description: "Non-Poppy compatibility token from POST /agent-sessions; no verified agent identity." } }
                  : {})
              }
            }
          : {}),
        schemas: {
          PrintOrder: {
            type: "object",
            additionalProperties: false,
            required: ["email", "ship_to", "items"],
            properties: {
              email: { type: "string", format: "email" },
              ship_to: { $ref: "#/components/schemas/Address" },
              items: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  required: ["photo_id", "copies"],
                  properties: { photo_id: { type: "string" }, copies: { type: "integer", minimum: 1, maximum: 100 } }
                }
              }
            }
          },
          Address: {
            type: "object",
            required: ["name", "line1", "city", "postal_code", "country"],
            properties: {
              name: { type: "string" },
              line1: { type: "string" },
              city: { type: "string" },
              postal_code: { type: "string" },
              country: { type: "string" }
            }
          }
        }
      },
      paths: {
        "/products": {
          get: {
            operationId: "searchProducts",
            summary: "Search products. Works signed out.",
            ...secured(),
            parameters: [
              { name: "q", in: "query", required: false, schema: { type: "string" } },
              // A header the model may fill, and one the agent never sends for it.
              { name: "Accept-Language", in: "header", required: false, schema: { type: "string", maxLength: 35 } },
              { name: "Cookie", in: "header", required: false, schema: { type: "string" } }
            ],
            responses: { "200": { description: "Matching products" } }
          }
        },
        "/orders": {
          get: {
            operationId: "listOrders",
            summary: `List the account's orders. Needs ${read}.`,
            ...secured(read),
            responses: { "200": { description: "Orders" } }
          }
        },
        "/addresses": {
          get: {
            operationId: "listAddresses",
            summary: "The account's saved shipping addresses. Needs addresses.",
            ...secured("addresses"),
            responses: { "200": { description: "Addresses" } }
          }
        },
        "/orders/{order_id}": {
          get: {
            operationId: "getOrder",
            summary: `One order. Needs ${read}.`,
            ...secured(read),
            parameters: [{ name: "order_id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "The order" }, "404": { description: "No such order" } }
          }
        },
        // Templated with no `parameters` declared, as some Companies' descriptions are
        // (Datalayer's Manzanita): the agent fills it from the call's arguments by name.
        "/orders/{order_id}/items/{item_id}": {
          get: {
            operationId: "getOrderItem",
            summary: `One item of an order. Needs ${read}.`,
            ...secured(read),
            responses: { "200": { description: "The item" }, "404": { description: "No such item" } }
          }
        },
        "/orders/{order_id}/exchanges": {
          post: {
            operationId: "exchangeItem",
            summary:
              `Exchange an item. Needs ${write}. Returns 403 approval_required with the terms to approve (Operations extension), or 201 with the exchange. Accepts Idempotency-Key.`,
            ...secured(write),
            parameters: [
              { name: "order_id", in: "path", required: true, schema: { type: "string" } },
              ...(this.company.config.exchangeTakesIdempotencyKey
                ? [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }]
                : [])
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["item_id", "replacement_sku"],
                    properties: { item_id: { type: "string" }, replacement_sku: { type: "string" } }
                  }
                }
              }
            },
            responses: { "201": { description: "Exchange placed" }, "403": { description: "approval_required: the User approves the operation's terms first" } }
          }
        },
        ...(this.company.config.openapiListsPoppyEndpoints ? this.#poppyPaths() : {}),
        ...(this.company.config.printShop ? this.#printPaths() : {})
      }
    };
  }

  /**
   * The print shop (`printShop`), described as print-with-poppy's store was at
   * `7ef69be` (since `c147418` its compatibility path has a description of its own): a
   * public catalog (a GET with no security), a non-Poppy compatibility
   * session endpoint (a POST with no security), and a photo upload and an
   * order that needs the User's approval, both signed out, each protected by
   * the Poppy Session or the compatibility token.
   */
  #printPaths() {
    const secured = this.company.config.describesSecurity ? { security: [{ session: [] }, { guest: [] }] } : {};
    // The transport's headers listed as arguments (printShopListsTransportHeaders).
    const transport = this.company.config.printShopListsTransportHeaders
      ? [
          { name: "Poppy-Session", in: "header", required: true, schema: { type: "string" }, description: "The Session JWT: htm, htu, iat, jti, sid and ath." },
          { name: "Authorization", in: "header", required: true, schema: { type: "string" } }
        ]
      : [];
    return {
      "/agent-sessions": {
        post: {
          operationId: "startGuestAgentSession",
          summary: "Start a plain HTTP compatibility session (not native Poppy authentication)",
          responses: { "201": { description: "A Bearer guest token" }, "404": { description: "not_available" } }
        }
      },
      "/catalog": {
        get: {
          operationId: "getCatalog",
          summary: "Products, USD prices, delivery estimate and payment mode",
          responses: { "200": { description: "The catalog" } }
        }
      },
      "/photos": {
        post: {
          operationId: "uploadPhoto",
          ...secured,
          ...(transport.length ? { parameters: transport } : {}),
          summary: `Upload one photo to print: JPEG, PNG or WebP, at most ${PHOTO_LIMIT / (1024 * 1024)} MB, in the field photo. Works signed out; the photo belongs to the Session.`,
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: { type: "object", required: ["photo"], properties: { photo: { type: "string", format: "binary" } } },
                encoding: { photo: { contentType: "image/jpeg, image/png, image/webp" } }
              }
            }
          },
          responses: { "201": { description: "The photo's id, name and type" }, "422": { description: "Not a photo we can print" } }
        }
      },
      "/prints": {
        post: {
          operationId: "orderPrints",
          ...secured,
          summary:
            "Order 4×6 in (6×4) prints of uploaded photos, shipped to an address. Works signed out. Returns 403 approval_required with the order's terms (Operations extension); nothing is ordered or charged until the User approves them. Needs an Idempotency-Key.",
          parameters: [...transport, { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 16, maxLength: 128 } }],
          requestBody: {
            required: true,
            content: {
              // By reference, as print-with-poppy's Proposal is: the agent must follow $refs to see the fields.
              "application/json": { schema: { $ref: "#/components/schemas/PrintOrder" } }
            }
          },
          responses: {
            "201": { description: "The order, to pay at its checkout link" },
            "403": { description: "approval_required with the terms, or extension_required: the Operations extension" }
          }
        }
      }
    };
  }

  /**
   * `POST /photos`: one photo, as `multipart/form-data` (RFC 7578). A body
   * without a boundary, or a part without a `form-data` name, is the
   * agent's error and recorded; anything else wrong is refused as the
   * store refuses it.
   */
  #uploadPhoto(inbound: Inbound, context: ResourceContext): Response {
    const co = this.company;
    const type = inbound.request.headers.get("Content-Type") ?? "";
    if (!/^multipart\/form-data\b/i.test(type)) return json({ error: "invalid_request", message: "Send the photo as multipart/form-data." }, 415);
    const boundary = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
    if (!boundary) {
      co.violation("upload.boundary", `multipart/form-data without a boundary: ${JSON.stringify(type)}`);
      return json({ error: "invalid_request", message: "multipart/form-data needs a boundary" }, 400);
    }
    const parts = parseMultipart(inbound.bodyBytes, boundary[1] ?? boundary[2]!);
    if (!parts) return json({ error: "invalid_request", message: "The multipart body doesn't parse" }, 400);
    for (const part of parts) {
      if (!part.name) {
        co.violation("upload.part-name", `multipart part without a form-data name (Content-Disposition: ${JSON.stringify(part.disposition)})`);
        return json({ error: "invalid_request", message: "Each part needs a Content-Disposition: form-data name" }, 400);
      }
    }
    if (parts.length !== 1 || parts[0]!.name !== "photo" || parts[0]!.filename === null) {
      return json({ error: "upload_limit", message: "Upload one photo, in the field photo, and nothing else." }, 413);
    }
    const photo = parts[0]!;
    if (photo.bytes.byteLength > PHOTO_LIMIT) return json({ error: "upload_limit", message: "Upload one photo, up to 5 MB." }, 413);
    const sniffed = photoType(photo.bytes);
    if (!sniffed) return json({ error: "invalid_image", message: "Upload a valid JPEG, PNG, or WebP photo." }, 422);
    const id = randomId("pho_", 9);
    const name = photo.filename || "photo";
    this.#photos.set(id, { sessionId: context.session.id, name, type: sniffed, size: photo.bytes.byteLength });
    return json({ id, name, type: sniffed, size: photo.bytes.byteLength }, 201);
  }

  /**
   * `POST /prints`: an order of the Session's photos, which needs the User's
   * approval of its terms (Ops 4). The description makes `Idempotency-Key`
   * required, so a write without one is refused, and recorded (Guides: send
   * one on writes that take one).
   */
  #orderPrints(inbound: Inbound, context: ResourceContext): Response {
    const co = this.company;
    if (!co.config.operations || !co.operationsVersion(context)) throw this.#extensionRequired("operations", context);
    const key = inbound.request.headers.get("Idempotency-Key");
    if (!key) {
      co.violation("idempotency.key-missing", `POST /prints without the Idempotency-Key its description requires`);
      return json({ error: "idempotency_key_required", message: "Send an Idempotency-Key of 16 to 128 characters." }, 400);
    }
    const header = inbound.request.headers.get("Poppy-Approval");
    const approval = header === null ? null : parseApprovalHeader(header);
    const scoped = `${idempotencyScope(context)}|${key}`;
    const seen = this.#idempotency.get(scoped);
    if (seen) {
      if (seen.hash !== inbound.bodyText) {
        co.violation("idempotency.key-reused", `Idempotency-Key ${key} reused with a different body`);
        return json({ error: "idempotency_conflict" }, 409);
      }
      return json(seen.body, seen.status);
    }
    const first = `${firstRequestScope(context)}|${key}`;
    if (header === null) this.#unapprovedKeys.add(first);
    else if (this.#unapprovedKeys.has(first)) co.violation("approval.idempotency-key-reused", `the approved request reused the first request's Idempotency-Key ${key}`);
    let order: PrintOrder;
    try {
      order = JSON.parse(inbound.bodyText || "null") as PrintOrder;
    } catch {
      return json({ error: "invalid_request", message: "The body isn't JSON" }, 400);
    }
    const ship = order?.ship_to;
    if (
      typeof order?.email !== "string" ||
      !order.email.includes("@") ||
      !ship ||
      ![ship.name, ship.line1, ship.city, ship.postal_code, ship.country].every((field) => typeof field === "string" && field.trim() !== "") ||
      !Array.isArray(order.items) ||
      order.items.length === 0
    ) {
      return json({ error: "invalid_request", message: "email, ship_to (name, line1, city, postal_code, country) and items are required" }, 400);
    }
    const lines: string[] = [];
    let copies = 0;
    for (const item of order.items) {
      const photo = typeof item?.photo_id === "string" ? this.#photos.get(item.photo_id) : undefined;
      if (!photo || photo.sessionId !== context.session.id) return json({ error: "unknown_photo", message: `No photo ${String(item?.photo_id)} in this Session` }, 422);
      if (!Number.isInteger(item.copies) || item.copies < 1 || item.copies > 100) return json({ error: "invalid_request", message: "copies is 1 to 100" }, 400);
      copies += item.copies;
      lines.push(`${item.copies} ${item.copies === 1 ? "copy" : "copies"} of ${photo.name}`);
    }
    const prints = (copies * 0.5 + 9.5).toFixed(2);
    const total = (Number(prints) + 5).toFixed(2);
    const address = `${ship.name}, ${ship.line1}, ${ship.city} ${ship.postal_code}, ${ship.country}`;
    const summary = `Print ${lines.join(" and ")} as 4×6 in (6×4) lustre prints and post them to ${address}. Confirmation to ${order.email}. Prints $${prints} + shipping $5.00 = $${total} USD, paid by card at a checkout link after approval. Can be cancelled until you pay.`;
    const terms = {
      product: "4x6 lustre print",
      items: order.items.map((item) => ({ photo_id: item.photo_id, copies: item.copies })),
      ship_to: ship,
      email: order.email,
      total: { amount: total, currency: "USD" },
      cancellable: true
    };
    const request = `${inbound.request.method} ${inbound.url.origin}${inbound.url.pathname} ${inbound.bodyText}`;
    const result = this.operations.prints(context, request, { summary, terms }, approval);
    if ("operation" in result) return json({ error: "approval_required", operation: result.operation }, 403);
    if ("declined" in result) return json({ error: "approval_declined", ...result.declined }, 403);
    // Only a performed order is kept: an approval_required answer is decided afresh each time.
    this.#idempotency.set(scoped, { hash: inbound.bodyText, ...result.performed });
    return json(result.performed.body, result.performed.status);
  }

  /** The Poppy endpoints, described as ordinary API paths (`openapiListsPoppyEndpoints`). */
  #poppyPaths() {
    const id = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });
    const object = { required: true, content: { "application/json": { schema: { type: "object" } } } };
    return {
      "/poppy/conversations/{conversation_id}/messages": {
        post: {
          operationId: "sendMessage",
          summary: "Send a message in a conversation.",
          parameters: [id("conversation_id")],
          requestBody: object,
          responses: { "202": { description: "Accepted" } }
        }
      }
    };
  }

  /** `extension_required` at an API, OpenAPI or MCP (3.3): in `WWW-Authenticate` under 0.3, in a JSON body under 0.4. */
  #extensionRequired(extension: string, context: ResourceContext): HttpError {
    if (context.session.declaration && context.session.declaration.version !== "0.3") return new HttpError(json({ error: "extension_required", extension }, 403));
    return new HttpError(json({}, 403, { "WWW-Authenticate": `Bearer error="extension_required", extension="${extension}"` }));
  }

  /**
   * The exchange. To an agent that lists Operations 2 it needs approval:
   * refused with the operation, then performed once on the same request
   * with `Poppy-Approval` (Ops 4, 6, 7).
   */
  #exchange(inbound: Inbound, context: ResourceContext): Response {
    const co = this.company;
    if (co.config.requiredExtension) throw this.#extensionRequired(co.config.requiredExtension, context);
    const usesOperations = co.config.operations && co.operationsVersion(context) && !co.config.actsWithoutProposing;
    if (!usesOperations) {
      if (co.config.requireOperationsExtension) throw this.#extensionRequired("operations", context);
      co.performExchange(context.account, "direct API call");
      return json({ exchange: { exchange_id: randomId("exc_", 6), order_id: "ord_7Hk2", state: "placed" } }, 201);
    }
    const header = inbound.request.headers.get("Poppy-Approval");
    const approval = header === null ? null : parseApprovalHeader(header);
    if (header !== null && (!approval || typeof approval.operation_id !== "string" || typeof approval.revision !== "string")) {
      co.violation("approval.header", `Poppy-Approval isn't an RFC 9651 Dictionary with operation_id and revision Strings: ${JSON.stringify(header)}`);
    }
    const key = inbound.request.headers.get("Idempotency-Key");
    const scoped = key ? `${idempotencyScope(context)}|${key}|${header ?? ""}` : null;
    if (key && header === null) this.#unapprovedKeys.add(`${firstRequestScope(context)}|${key}`);
    else if (key && this.#unapprovedKeys.has(`${firstRequestScope(context)}|${key}`)) {
      co.violation("approval.idempotency-key-reused", `the approved request reused the first request's Idempotency-Key ${key}`);
    }
    const seen = scoped ? this.#idempotency.get(scoped) : undefined;
    if (seen) return json(seen.body, seen.status);
    let asked: Record<string, unknown> = {};
    try {
      asked = JSON.parse(inbound.bodyText || "{}") as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const request = `${inbound.request.method} ${inbound.url.origin}${inbound.url.pathname} ${inbound.bodyText}`;
    const result = this.operations.exchange(context, request, asked, approval);
    const answer = "operation" in result
      ? { status: 403, body: { error: "approval_required", operation: result.operation } }
      : "declined" in result ? { status: 403, body: { error: "approval_declined", ...result.declined } }
      : result.performed;
    // Only a performed request is kept: approval_required and approval_declined are decided afresh.
    if (scoped && "performed" in result) this.#idempotency.set(scoped, { hash: inbound.bodyText, ...answer });
    return json(answer.body, answer.status);
  }

  /** OpenAPI routes on the API host. */
  rest(inbound: Inbound, context: ResourceContext): Response {
    const co = this.company;
    const { pathname } = inbound.url;
    const method = inbound.request.method;
    const { read, write } = co.orderScopes;
    // An API that names a `resource` takes only tokens issued for it (RFC 8707). Signed out there is no token (5.2).
    if (co.config.apiResource && context.token && context.token.resource !== co.hosts.api) {
      throw resourceError("DPoP", 401, "invalid_token");
    }
    if (co.config.printShop && method === "POST" && pathname === "/photos") return this.#uploadPhoto(inbound, context);
    if (co.config.printShop && method === "POST" && pathname === "/prints") return this.#orderPrints(inbound, context);
    if (co.config.printShop && method === "GET" && pathname === "/catalog") {
      return json({ products: [{ sku: "print-6x4", name: "4×6 in (6×4) lustre print", price: { amount: "10.00", currency: "USD" } }], shipping: { amount: "5.00", currency: "USD" } });
    }
    // The compatibility session is off, as the interop adapter sets print-with-poppy's (ALLOW_COMPAT_AGENT_SESSIONS=false).
    if (co.config.printShop && method === "POST" && pathname === "/agent-sessions") return json({ error: "not_available" }, 404);
    if (method === "GET" && pathname === "/products") {
      const query = (inbound.url.searchParams.get("q") ?? "").toLowerCase();
      return json({ products: PRODUCTS.filter((product) => product.name.toLowerCase().includes(query)) });
    }
    if (method === "GET" && pathname === "/orders") {
      co.requireScopes(context, [read]);
      return json({ orders: [orderFor(context.account!)] });
    }
    if (method === "GET" && pathname === "/addresses") {
      co.requireScopes(context, ["addresses"]);
      return json({ addresses: [{ address_id: "adr_1", city: "Portland" }] });
    }
    const item = /^\/orders\/([^/]+)\/items\/([^/]+)$/.exec(pathname);
    if (method === "GET" && item) {
      co.requireScopes(context, [read]);
      const found = orderFor(context.account!).items.find((entry) => entry.item_id === item[2]);
      if (item[1] !== "ord_7Hk2" || !found) return json({ error: "not_found" }, 404);
      return json(found);
    }
    const order = /^\/orders\/([^/]+)$/.exec(pathname);
    if (method === "GET" && order) {
      co.requireScopes(context, [read]);
      if (order[1] !== "ord_7Hk2") return json({ error: "not_found" }, 404);
      return json(orderFor(context.account!));
    }
    const exchange = /^\/orders\/([^/]+)\/exchanges$/.exec(pathname);
    if (method === "POST" && exchange) {
      co.requireScopes(context, [write]);
      return this.#exchange(inbound, context);
    }
    return json({ error: "not_found" }, 404);
  }

  // ---- MCP (Streamable HTTP: 2025-06-18's session, 2026-07-28's per-request metadata) ----

  protectedResourceMetadata() {
    const co = this.company;
    return {
      resource: co.hosts.mcpUrl,
      authorization_servers: co.config.mcpPrmOmitIssuer ? [] : [co.hosts.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [co.orderScopes.read, co.orderScopes.write]
    };
  }

  /** Every message the MCP server answered after the Session's checks, for `state().mcp`. */
  get mcpLog(): readonly McpExchange[] {
    return this.#mcpLog;
  }

  /**
   * The MCP server (7). Which lifecycle a request gets depends on
   * `mcpVersions` and on how the request opens: `initialize` asks for
   * 2025-06-18's session; per-request `_meta`, or a version header newer
   * than the legacy ones, asks for 2026-07-28. A dual-era server serves both
   * (MCP 2026-07-28 Versioning, "Backward Compatibility").
   */
  async mcp(inbound: Inbound): Promise<Response> {
    const co = this.company;
    if (inbound.request.method !== "POST") return new Response(null, { status: 405 });
    const headers = inbound.request.headers;
    const accept = headers.get("Accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      co.violation("mcp.accept", `MCP request must Accept application/json and text/event-stream, got ${JSON.stringify(accept)}`);
    }
    // MCP clients discover OAuth before they have a Poppy identity (spec 7).
    // A token we issued to a Personal Agent still requires its Session header.
    const authorization = headers.get("Authorization");
    const presented = authorization?.split(" ", 2)[1];
    if (!headers.has("Poppy-Session") && (!presented || !co.accessTokens.has(presented))) {
      const error = authorization ? { error: "invalid_token" } : {};
      return json(error, 401, { "WWW-Authenticate": `Bearer ${authorization ? 'error="invalid_token", ' : ""}resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", co.hosts.mcpUrl).href}"` });
    }
    const context = await co.authorizeResource(inbound, true);
    let parsed: unknown;
    try { parsed = JSON.parse(inbound.bodyText); } catch { parsed = null; }
    const message = record(parsed);
    const method = typeof message?.method === "string" ? message.method : null;
    const speaks = co.config.mcpVersions;
    const versionHeader = headers.get("MCP-Protocol-Version");
    const meta = record(record(message?.params)?._meta) ?? {};
    const modern = method !== "initialize" &&
      ((versionHeader !== null && !LEGACY_MCP_VERSIONS.includes(versionHeader)) || meta[MCP_META.protocolVersion] !== undefined || !speaks.includes(MCP_LEGACY));
    const answer = (response: Response, code: number | null = null): Response => {
      this.#mcpLog.push({
        method,
        lifecycle: modern ? "modern" : "legacy",
        status: response.status,
        code,
        protocolVersion: versionHeader,
        mcpSessionId: headers.has("Mcp-Session-Id"),
        poppySession: headers.has("Poppy-Session")
      });
      return response;
    };
    const id = typeof message?.id === "string" || typeof message?.id === "number" ? message.id : null;
    const failure: McpFailure = (status, code, text, data) =>
      answer(json({ jsonrpc: "2.0", id, error: { code, message: text, ...(data === undefined ? {} : { data }) } }, status), code);
    if (!message || method === null) return failure(400, -32700, "Parse error");
    const rpc: McpMessage = { method, params: message.params };
    if (method === "initialize") {
      // A modern-only server names what it does speak (MCP 2026-07-28 Versioning: "SHOULD name the protocol versions it supports in any error it returns to an initialize request").
      if (!speaks.includes(MCP_LEGACY)) return failure(400, -32022, "Unsupported protocol version", { supported: [...speaks], requested: record(rpc.params)?.protocolVersion ?? null });
      const session = randomId("mcp_", 8);
      this.#mcpSessions.set(session, { initialized: false, version: MCP_LEGACY });
      return answer(json({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: MCP_LEGACY, capabilities: { tools: {} }, serverInfo: { name: `mock-shop-${co.id}`, version: "1.0.0" } }
      }, 200, { "Mcp-Session-Id": session }));
    }
    if (modern) {
      // A legacy server reads a version it doesn't know as a bad request; its body is no 2026-07-28 error, so a dual-era client falls back.
      if (!speaks.includes(MCP_MODERN)) return failure(400, -32000, `Bad Request: Unsupported protocol version: ${versionHeader ?? "none"}`);
      // 2026-07-28 defines no client notifications over HTTP, nor headers for one.
      if (method.startsWith("notifications/")) return answer(new Response(null, { status: 202 }));
      const refused = this.#modernRequest(rpc, meta, headers, versionHeader, failure);
      if (refused) return refused;
    } else {
      const refused = this.#legacyRequest(rpc, headers, versionHeader, failure);
      if (refused) return refused;
      if (method.startsWith("notifications/")) return answer(new Response(null, { status: 202 }));
    }
    let result: McpOutcome;
    try {
      result = await this.#mcpMethod(rpc, context, modern);
    } catch (error) {
      if (error instanceof HttpError) answer(error.response);
      throw error;
    }
    // 2026-07-28 answers a method it doesn't implement with 404 (Streamable HTTP, "Protocol Version Header").
    if ("error" in result) return failure(modern && result.error.code === -32601 ? 404 : 200, result.error.code, result.error.message);
    const body = modern
      ? { resultType: "complete", ...result.result, _meta: { [MCP_META.serverInfo]: { name: `mock-shop-${co.id}`, version: "1.0.0" } } }
      : result.result;
    return answer(json({ jsonrpc: "2.0", id, result: body }));
  }

  /**
   * MCP 2026-07-28's checks, in the order a server can tell them apart. A
   * version it doesn't speak is answered with the versions it does, which a
   * dual-era client may provoke on purpose; everything else is the client's
   * mistake, recorded and refused with the error the binding names.
   */
  #modernRequest(rpc: McpMessage, meta: Record<string, unknown>, headers: Headers, versionHeader: string | null, failure: McpFailure): Response | null {
    const co = this.company;
    const speaks = co.config.mcpVersions;
    const metaVersion = meta[MCP_META.protocolVersion];
    const unsupported = () => failure(400, -32022, "Unsupported protocol version", { supported: [...speaks], requested: versionHeader ?? metaVersion ?? null });
    // A legacy request (its session's version) at a server that dropped that version.
    if (versionHeader !== null && versionHeader !== MCP_MODERN && (metaVersion === undefined || metaVersion === versionHeader)) return unsupported();
    if (typeof metaVersion !== "string" || record(meta[MCP_META.clientCapabilities]) === null) {
      co.violation("mcp.modern-meta", `${rpc.method}: _meta lacks ${typeof metaVersion !== "string" ? MCP_META.protocolVersion : MCP_META.clientCapabilities}`);
      return failure(400, -32602, "Invalid params: missing required _meta fields");
    }
    if (versionHeader !== metaVersion) {
      co.violation("mcp.modern-version-header", `${rpc.method}: MCP-Protocol-Version ${JSON.stringify(versionHeader)}, _meta ${JSON.stringify(metaVersion)}`);
      return failure(400, -32020, "Header mismatch: MCP-Protocol-Version");
    }
    if (metaVersion !== MCP_MODERN) return unsupported();
    if (record(meta[MCP_META.clientInfo]) === null) co.violation("mcp.modern-client-info", `${rpc.method} without ${MCP_META.clientInfo}`);
    const method = headers.get("Mcp-Method");
    if (method !== rpc.method) {
      co.violation("mcp.modern-method-header", `${rpc.method}: Mcp-Method ${JSON.stringify(method)}`);
      return failure(400, -32020, "Header mismatch: Mcp-Method");
    }
    if (rpc.method === "tools/call") {
      const params = record(rpc.params) ?? {};
      const name = headerValue(headers.get("Mcp-Name"));
      if (name !== params.name) {
        co.violation("mcp.modern-name-header", `tools/call ${JSON.stringify(params.name)}: Mcp-Name ${JSON.stringify(headers.get("Mcp-Name"))}`);
        return failure(400, -32020, "Header mismatch: Mcp-Name");
      }
      const tool = this.#mcpTools().find((item) => item.name === params.name);
      const args = record(params.arguments) ?? {};
      for (const { header, path } of tool ? headerParameters(tool.inputSchema) : []) {
        const value = path.reduce<unknown>((at, key) => { const object = record(at); return object && Object.hasOwn(object, key) ? object[key] : undefined; }, args);
        const sent = headers.get(`Mcp-Param-${header}`);
        const expected = value === undefined || value === null ? null : String(value);
        if (headerValue(sent) !== expected) {
          co.violation("mcp.modern-param-header", `tools/call ${String(params.name)}: Mcp-Param-${header} ${JSON.stringify(sent)} for ${JSON.stringify(value ?? null)}`);
          return failure(400, -32020, `Header mismatch: Mcp-Param-${header}`);
        }
      }
    }
    // Servers ignore it (MCP 2026-07-28 Streamable HTTP, "Backward Compatibility"); a client of this version has none to send.
    if (headers.has("Mcp-Session-Id")) co.violation("mcp.modern-session-id", `${rpc.method} with Mcp-Session-Id`);
    return null;
  }

  /** MCP 2025-06-18's checks: the session `initialize` returned, the version it negotiated, and `notifications/initialized` first. */
  #legacyRequest(rpc: McpMessage, headers: Headers, versionHeader: string | null, failure: McpFailure): Response | null {
    const co = this.company;
    const sessionId = headers.get("Mcp-Session-Id");
    if (sessionId === null) {
      co.violation("mcp.legacy-session", `${rpc.method} without Mcp-Session-Id`);
      return failure(400, -32000, "Bad Request: No valid session ID provided");
    }
    const session = this.#mcpSessions.get(sessionId);
    if (!session) return failure(404, -32001, "Session not found");
    if (versionHeader !== session.version) {
      co.violation("mcp.legacy-version-header", `${rpc.method}: MCP-Protocol-Version ${JSON.stringify(versionHeader)} in a ${session.version} session`);
      // 2025-06-18: a server that gets no header assumes 2025-03-26 and goes on; a wrong one is a bad request.
      if (versionHeader !== null) return failure(400, -32000, `Bad Request: Unsupported protocol version: ${versionHeader}`);
    }
    if (rpc.method === "notifications/initialized") session.initialized = true;
    else if (!session.initialized && rpc.method !== "ping" && !rpc.method.startsWith("notifications/")) {
      co.violation("mcp.legacy-initialized", `${rpc.method} before notifications/initialized`);
    }
    return null;
  }

  /** The tools, as both lifecycles list them; `x-mcp-header` is an annotation older clients skip. */
  #mcpTools() {
    const co = this.company;
    return [
      {
        name: "search_products",
        description: `Search products by name.${co.config.injection ? ` ${co.config.injection}` : ""}`,
        inputSchema: { type: "object", properties: { query: { type: "string", "x-mcp-header": "Query" } } },
        annotations: { readOnlyHint: true }
      },
      {
        name: "exchange_item",
        description: `Exchange an item on an order. Asks for the User's approval of its terms when supported.${co.config.injection ? ` ${co.config.injection}` : ""}`,
        inputSchema: {
          type: "object",
          required: ["order_id", "item_id", "replacement_sku"],
          properties: {
            order_id: { type: "string", "x-mcp-header": "Order-Id" },
            item_id: { type: "string" },
            replacement_sku: { type: "string" }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      }
    ];
  }

  /** What a method does, the same under either lifecycle; the caller frames it for its version. */
  async #mcpMethod(rpc: McpMessage, context: ResourceContext, modern: boolean): Promise<McpOutcome> {
    const co = this.company;
    if (rpc.method === "server/discover" && modern) {
      return { result: { supportedVersions: [...co.config.mcpVersions], capabilities: { tools: {} }, ttlMs: 3_600_000, cacheScope: "public" } };
    }
    if (rpc.method === "tools/list") {
      return { result: { tools: this.#mcpTools(), ...(modern ? { ttlMs: 300_000, cacheScope: "private" } : {}) } };
    }
    if (rpc.method === "tools/call") {
      const params = record(rpc.params) ?? {};
      const name = params.name;
      const args = (record(params.arguments) ?? {}) as Record<string, unknown>;
      if (name === "search_products") {
        const query = String(args.query ?? "").toLowerCase();
        const products = PRODUCTS.filter((product) => product.name.toLowerCase().includes(query));
        return { result: {
          content: [{ type: "text", text: products.map((product) => product.name).join(", ") || "No products" }],
          structuredContent: { products }
        } };
      }
      // 3.3: an extension the request doesn't declare refuses the call as at any API, here at the HTTP level.
      if (name === "exchange_item" && co.config.requiredExtension) throw this.#extensionRequired(co.config.requiredExtension, context);
      if (name === "exchange_item" && co.config.operations && co.operationsVersion(context) && !co.config.actsWithoutProposing) {
        co.requireScopes(context, [co.orderScopes.write], true);
        const meta = record(params._meta) ?? {};
        const given = meta["personalagentprotocol.org/approval"];
        const approval = typeof given === "object" && given !== null && !Array.isArray(given) ? (given as Record<string, unknown>) : null;
        if (given !== undefined && (!approval || typeof approval.operation_id !== "string" || typeof approval.revision !== "string")) {
          co.violation("approval.mcp-meta", "the approval in _meta isn't an object with operation_id and revision strings");
        }
        const result = this.operations.exchange(context, `tools/call exchange_item ${JSON.stringify(args)}`, args, approval);
        if ("operation" in result) {
          return { result: {
            isError: true,
            content: [{ type: "text", text: `Not done yet. This needs approval${result.operation.summary ? `: ${result.operation.summary}` : "."}` }],
            structuredContent: { operation: result.operation }
          } };
        }
        if ("declined" in result) {
          // 0.4 Ops 6: an error result, the decline's members and error in structuredContent.
          return { result: {
            isError: true,
            content: [{ type: "text", text: `Not done: ${result.declined.reason}` }],
            structuredContent: { error: "approval_declined", ...result.declined }
          } };
        }
        return { result: { content: [{ type: "text", text: "Exchange placed." }], structuredContent: result.performed.body as Record<string, unknown> } };
      }
      if (name === "exchange_item") {
        co.requireScopes(context, [co.orderScopes.write], true);
        if (co.config.requireOperationsExtension) {
          // An MCP server refuses one tool with an ordinary tool error, never extension_required (Ops 2).
          return { result: { isError: true, content: [{ type: "text", text: "Exchanging needs the Operations extension." }] } };
        }
        co.performExchange(context.account, "MCP tool call");
        return { result: { content: [{ type: "text", text: "Exchange placed." }], structuredContent: { exchange: { exchange_id: randomId("exc_", 6), order_id: "ord_7Hk2", state: "placed" } } } };
      }
      return { error: { code: -32602, message: `unknown tool ${String(name)}` } };
    }
    return { error: { code: -32601, message: `unknown method ${String(rpc.method)}` } };
  }
}

/**
 * Whose `Idempotency-Key`s a record belongs to: the Personal Agent, the User
 * and any account, not the Session (Guides, "Retries"), so a retry that a
 * new Session carries after `session_ended` still matches.
 */
function idempotencyScope(context: ResourceContext): string {
  return `${context.session.clientId}|${context.session.userId}|${context.account ?? ""}`;
}

/**
 * Whose first requests an approved request must not reuse the key of (Ops 6):
 * the Personal Agent and the User, without the account, because signing in
 * between the first request and the approval doesn't make the key new.
 */
function firstRequestScope(context: ResourceContext): string {
  return `${context.session.clientId}|${context.session.userId}`;
}
