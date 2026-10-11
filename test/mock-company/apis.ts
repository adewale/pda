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

/** The Company's OpenAPI API and MCP server (spec section 6). */
export class Apis {
  readonly #idempotency = new Map<string, { hash: string; status: number; body: unknown }>();
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
            description: "Search products by name.",
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
            annotations: { readOnlyHint: true }
          },
          {
            name: "exchange_item",
            description: "Exchange an item on an order. Proposes an operation when supported.",
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
