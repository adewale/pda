import { PoppyError } from "./client";
import { protocolEndpoint, type Company } from "./discovery";
import type { Json } from "./json";
import { isPublicHost } from "../validator/fetch.ts";
import { departure, ours, show, shown } from "../diagnostic";

/** What one request to a Company carries, before the client adds its token and proof. */
export type RequestInit = {
  readonly method: string;
  readonly url: string;
  readonly body?: Json;
  /**
   * A `multipart/form-data` body instead of JSON (an OpenAPI upload). The
   * runtime writes its `Content-Type` with the boundary, and serialises it
   * again for each retry.
   */
  readonly form?: FormData;
  readonly headers?: Readonly<Record<string, string>>;
  readonly accept?: string;
  /** A long poll: how much longer than `timeouts.requestMs` the answer may take to start. */
  readonly waitMs?: number;
};

/**
 * A request the client's own code makes to an endpoint the Company's
 * `poppy.json` names: at or under a Poppy endpoint (conversations,
 * operations, Mediated Sign-In), or exactly an MCP server it lists. Made
 * only by `to` and `mcp`, which check where it goes; `PoppyClient.resource`
 * takes nothing else but a `CheckedApiRequest` (apis.ts), so no request
 * reaches a Company with a URL nobody checked.
 */
export class EndpointRequest {
  readonly #init: RequestInit;

  private constructor(init: RequestInit, readonly listed = false) {
    this.#init = init;
  }

  init(): RequestInit {
    return this.#init;
  }

  /** A request to one of the Company's Poppy endpoints, or a path under one. */
  static to(company: Company, init: RequestInit): EndpointRequest {
    const url = new URL(init.url);
    if (!protocolEndpoint(company, url)) {
      throw new PoppyError("invalid_request", departure(ours("the request's address"), shown`one of ${show.name(company.name)}'s Poppy endpoints, or a path under one`, show.url(url)), 0);
    }
    return new EndpointRequest(init);
  }

  /**
   * A request to exactly an endpoint the Company named for this Session in
   * a protocol response, such as 0.4's `feedback.endpoint` from the tasks
   * response, which 5.2 makes a Session destination (9.3). It may be on any
   * public HTTPS host (3, "Redirects and addresses"), so it carries the
   * Session header and never a token.
   */
  static listed(endpoint: string, init: RequestInit): EndpointRequest {
    if (init.url !== endpoint || !URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:" || !isPublicHost(new URL(endpoint))) {
      throw new PoppyError("invalid_request", departure(ours("the request's address"), ours("exactly the endpoint the Company named, on a public HTTPS host"), show.url(init.url)), 0);
    }
    return new EndpointRequest(init, true);
  }

  /** A JSON-RPC request to an MCP server the Company lists, at exactly its `url`. */
  static mcp(company: Company, init: RequestInit): EndpointRequest {
    if (!company.apis.some((api) => api.type === "mcp" && api.url === init.url)) {
      throw new PoppyError("no_api", departure(ours("the MCP request's address"), shown`exactly the URL of an MCP API ${show.name(company.name)} lists`, show.url(init.url)), 0);
    }
    return new EndpointRequest(init);
  }
}
