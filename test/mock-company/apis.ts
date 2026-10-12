import {
  Company,
  HttpError,
  json,
  randomId,
  resourceError,
  type Inbound,
  type ResourceContext
} from "./core";
import type { Operations } from "./operations";

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

/** The Company's OpenAPI API and MCP server (spec section 6). */
export class Apis {
  readonly #idempotency = new Map<string, { hash: string; status: number; body: unknown }>();
  /** The print shop's photos, each belonging to the Session that uploaded it. */
  readonly #photos = new Map<string, { sessionId: string; name: string; type: string; size: number }>();
  readonly #mcpSessions = new Set<string>();

  constructor(
    readonly company: Company,
    readonly operations: Operations
  ) {}

  openapiDocument() {
    const api = this.company.hosts.api;
    const { read, write } = this.company.orderScopes;
    // Each operation declares the scopes it needs in its security requirement.
    const secured = (...scopes: string[]) => ({ security: [{ session: scopes }] });
    return {
      openapi: "3.1.0",
      info: {
        title: `Mock Shop ${this.company.id} API`,
        version: "1.0.0",
        description:
          "Orders and exchanges. POST /orders/{order_id}/exchanges returns an operation (Operations extension) to Personal Agents that support it."
      },
      servers: [{ url: this.company.config.openapiServerOverride ?? api }],
      components: {
        securitySchemes: {
          session: { type: "http", scheme: "DPoP", description: "Personal Agent Protocol Session Token" }
        }
      },
      paths: {
        "/products": {
          get: {
            operationId: "searchProducts",
            summary: "Search products. Works signed out.",
            ...secured(),
            parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }],
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
              `Exchange an item. Needs ${write}. Returns 202 with an operation to confirm (Operations extension), or 201 with the exchange. Accepts Idempotency-Key.`,
            ...secured(write),
            parameters: [
              { name: "order_id", in: "path", required: true, schema: { type: "string" } },
              { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }
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
            responses: {
              "201": { description: "Exchange placed" },
              "202": { description: "Operation proposed; confirm it at the operations endpoint" }
            }
          }
        },
        ...(this.company.config.openapiListsPoppyEndpoints ? this.#poppyPaths() : {}),
        ...(this.company.config.printShop ? this.#printPaths() : {})
      }
    };
  }

  /** The print shop (`printShop`): a photo upload and an order that proposes an operation, both signed out. */
  #printPaths() {
    return {
      "/photos": {
        post: {
          operationId: "uploadPhoto",
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
          summary:
            "Propose an order of 4×6 in (6×4) prints of uploaded photos, shipped to an address. Works signed out. Returns 202 with an operation to confirm (Operations extension); nothing is ordered or charged until the User approves it. Needs an Idempotency-Key.",
          parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 16, maxLength: 128 } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "ship_to", "items"],
                  properties: {
                    email: { type: "string", format: "email" },
                    ship_to: {
                      type: "object",
                      required: ["name", "line1", "city", "postal_code", "country"],
                      properties: {
                        name: { type: "string" },
                        line1: { type: "string" },
                        city: { type: "string" },
                        postal_code: { type: "string" },
                        country: { type: "string" }
                      }
                    },
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
                }
              }
            }
          },
          responses: {
            "202": { description: "Operation proposed; confirm it at the operations endpoint" },
            "403": { description: "extension_required: the Operations extension" }
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
   * `POST /prints`: propose an order of the Session's photos as an operation
   * (Ops 4.1). The description makes `Idempotency-Key` required, so a write
   * without one is refused, and recorded (Guides: send one on writes that
   * take one).
   */
  #orderPrints(inbound: Inbound, context: ResourceContext): Response {
    const co = this.company;
    if (!co.config.operations || !context.client.listsOperations) {
      return json({ error: "extension_required", extension: "operations", message: "Ordering needs the Operations extension." }, 403);
    }
    const key = inbound.request.headers.get("Idempotency-Key");
    if (!key) {
      co.violation("idempotency.key-missing", `POST /prints without the Idempotency-Key its description requires`);
      return json({ error: "idempotency_key_required", message: "Send an Idempotency-Key of 16 to 128 characters." }, 400);
    }
    const scoped = `${context.session.id}|${key}`;
    const seen = this.#idempotency.get(scoped);
    if (seen) {
      if (seen.hash !== inbound.bodyText) {
        co.violation("idempotency.key-reused", `Idempotency-Key ${key} reused with a different body`);
        return json({ error: "idempotency_conflict" }, 409);
      }
      return json(seen.body, seen.status);
    }
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
    const result = { status: 202, body: { operation: this.operations.proposePrints(context, terms, summary) } };
    this.#idempotency.set(scoped, { hash: inbound.bodyText, ...result });
    return json(result.body, result.status);
  }

  /** The Poppy endpoints, described as ordinary API paths (`openapiListsPoppyEndpoints`). */
  #poppyPaths() {
    const id = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });
    const object = { required: true, content: { "application/json": { schema: { type: "object" } } } };
    return {
      "/poppy/operations/{operation_id}/confirm": {
        post: {
          operationId: "confirmOperation",
          summary: "Confirm an operation with the revision the User approved.",
          parameters: [id("operation_id")],
          requestBody: object,
          responses: { "200": { description: "The operation" } }
        }
      },
      "/poppy/operations/{operation_id}/cancel": {
        post: {
          operationId: "cancelOperation",
          summary: "Cancel an operation.",
          parameters: [id("operation_id")],
          responses: { "200": { description: "The operation" } }
        }
      },
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

  /** The exchange, as an operation or done at once. */
  #exchange(context: ResourceContext): { status: number; body: unknown } {
    const co = this.company;
    if (co.config.requiredExtension) {
      throw new HttpError(json({ error: "extension_required", extension: co.config.requiredExtension }, 403));
    }
    if (co.config.operations && context.client.listsOperations) {
      return { status: 202, body: { operation: this.operations.proposeExchange(context) } };
    }
    if (co.config.requireOperationsExtension) {
      throw new HttpError(json({ error: "extension_required", extension: "operations" }, 403));
    }
    co.performExchange(context.account, "direct API call");
    return {
      status: 201,
      body: { exchange: { exchange_id: randomId("exc_", 6), order_id: "ord_7Hk2", state: "placed" } }
    };
  }

  /** OpenAPI routes on the API host. */
  rest(inbound: Inbound, context: ResourceContext): Response {
    const co = this.company;
    const { pathname } = inbound.url;
    const method = inbound.request.method;
    const { read, write } = co.orderScopes;
    // An API that names a `resource` takes only tokens issued for it (RFC 8707).
    if (co.config.apiResource && context.token.resource !== co.hosts.api) {
      throw resourceError("DPoP", 401, "invalid_token");
    }
    if (co.config.printShop && method === "POST" && pathname === "/photos") return this.#uploadPhoto(inbound, context);
    if (co.config.printShop && method === "POST" && pathname === "/prints") return this.#orderPrints(inbound, context);
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
      const key = inbound.request.headers.get("Idempotency-Key");
      if (key) {
        const scoped = `${context.session.id}|${key}`;
        const seen = this.#idempotency.get(scoped);
        if (seen) {
          if (seen.hash !== inbound.bodyText) {
            co.violation("idempotency.key-reused", `Idempotency-Key ${key} reused with a different body`);
            return json({ error: "idempotency_key_conflict" }, 409);
          }
          return json(seen.body, seen.status);
        }
        const result = this.#exchange(context);
        this.#idempotency.set(scoped, { hash: inbound.bodyText, ...result });
        return json(result.body, result.status);
      }
      const result = this.#exchange(context);
      return json(result.body, result.status);
    }
    return json({ error: "not_found" }, 404);
  }

  // ---- MCP (Streamable HTTP, 2025-06-18) ----

  protectedResourceMetadata() {
    const co = this.company;
    return {
      resource: co.hosts.mcpUrl,
      authorization_servers: co.config.mcpPrmOmitIssuer ? [] : [co.hosts.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [co.orderScopes.read, co.orderScopes.write]
    };
  }

  async mcp(inbound: Inbound): Promise<Response> {
    const co = this.company;
    if (inbound.request.method !== "POST") return new Response(null, { status: 405 });
    const accept = inbound.request.headers.get("Accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      co.violation("mcp.accept", `MCP request must Accept application/json and text/event-stream, got ${JSON.stringify(accept)}`);
    }
    let context: ResourceContext;
    try {
      context = await co.authorizeResource(inbound, true);
    } catch (error) {
      if (error instanceof HttpError && error.response.status === 401) {
        throw resourceError("Bearer", 401, "invalid_token", {
          headers: {
            "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="https://mcp.${co.hosts.domain}/.well-known/oauth-protected-resource/mcp"`
          }
        });
      }
      throw error;
    }
    const rpc = JSON.parse(inbound.bodyText || "{}") as {
      jsonrpc?: string;
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    };
    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      json({ jsonrpc: "2.0", id: rpc.id ?? null, result }, 200, headers);
    const rpcError = (code: number, message: string) =>
      json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });
    if (rpc.method === "initialize") {
      const session = randomId("mcp_", 8);
      this.#mcpSessions.add(session);
      return reply(
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: `mock-shop-${co.id}`, version: "1.0.0" }
        },
        { "Mcp-Session-Id": session }
      );
    }
    if (rpc.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return reply({
        tools: [
          {
            name: "search_products",
            description: `Search products by name.${co.config.injection ? ` ${co.config.injection}` : ""}`,
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
            annotations: { readOnlyHint: true }
          },
          {
            name: "exchange_item",
            description: `Exchange an item on an order. Proposes an operation when supported.${co.config.injection ? ` ${co.config.injection}` : ""}`,
            inputSchema: {
              type: "object",
              required: ["order_id", "item_id", "replacement_sku"],
              properties: {
                order_id: { type: "string" },
                item_id: { type: "string" },
                replacement_sku: { type: "string" }
              }
            },
            annotations: { readOnlyHint: false, destructiveHint: false }
          }
        ]
      });
    }
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "search_products") {
        const query = String(args.query ?? "").toLowerCase();
        const products = PRODUCTS.filter((product) => product.name.toLowerCase().includes(query));
        return reply({
          content: [{ type: "text", text: products.map((product) => product.name).join(", ") || "No products" }],
          structuredContent: { products }
        });
      }
      if (name === "exchange_item") {
        co.requireScopes(context, [co.orderScopes.write], true);
        const result = this.#exchange(context);
        const body = result.body as { operation?: { summary: string } };
        if (body.operation) {
          return reply({
            content: [{ type: "text", text: `Proposed: ${body.operation.summary} Not done until confirmed.` }],
            structuredContent: body
          });
        }
        return reply({ content: [{ type: "text", text: "Exchange placed." }], structuredContent: body });
      }
      return rpcError(-32602, `unknown tool ${String(name)}`);
    }
    return rpcError(-32601, `unknown method ${String(rpc.method)}`);
  }
}
