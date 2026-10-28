/**
 * What every host of our mock Company (test/mock-company) outside the
 * Workers runtime shares: the interop adapter (interop/impls/pda-mock) and
 * the Hypothesis suite's launcher (test/hypothesis/launcher.ts). One copy of
 * the placement under `<id>.company.interop.test`, the base settings, the
 * hooks and their names, and `GET /violations`'s body, so the two can't
 * drift. Interop-only; never in src/.
 */
import type { MockCompany } from "../../../test/mock-company/index.ts";
import { DEFAULT_CONFIG, placeCompanies, type MockConfig } from "../../../test/mock-company/types.ts";
import { basisOf, levelOfCheck, VIOLATION_IDS, violationId, type Basis, type Level, type ViolationId } from "../../../test/mock-company/violations.ts";

export const COMPANY_SUFFIX = "company.interop.test";

/**
 * Place the mock's Companies at `<id>.company.interop.test`, its `www.`,
 * `auth.`, `api.`, `mcp.` and `cdn.` hosts, and a second domain
 * `uk.<id>.company.interop.test` for poppy_domains.
 */
export function placeInteropCompanies(): void {
  placeCompanies({
    domain: (id) => `${id}.${COMPANY_SUFFIX}`,
    altDomain: (id) => `uk.${id}.${COMPANY_SUFFIX}`,
    idFromHost: (host) =>
      /^(?:(?:www|auth|api|mcp|cdn)\.)?(?:uk\.)?([a-z0-9-]+)\.company\.interop\.test$/.exec(host)?.[1] ?? null
  });
}

/**
 * Settings every host starts from: rotating Account Tokens (scenario R),
 * devices polled every second so Device Sign-In doesn't wait five, no API
 * of an unknown type (the conformance tests list one on purpose to check
 * agents skip it, but it breaks 6's MUST, and a reference Company keeps to
 * every MUST, docs/conformance-levels.md), and the print shop, for scenario
 * OU's photo upload and signed-out order.
 */
export const MOCK_BASE: Partial<MockConfig> = { rotateRefreshTokens: true, deviceInterval: 1, unknownApi: false, printShop: true };

/** A hook's refusal: its HTTP status and error code. */
export class HookError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string
  ) {
    super(detail);
  }
}

export type Params = Record<string, unknown>;
export type Hook = (params: Params) => Promise<unknown>;

export const str = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new HookError(400, "invalid_params", `${name} must be a non-empty string`);
  return value;
};

export const scopes = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

export function accountFor(account: unknown) {
  const id = typeof account === "string" ? account : DEFAULT_CONFIG.accounts[0]!.account;
  const found = DEFAULT_CONFIG.accounts.find((item) => item.account === id);
  if (!found) throw new HookError(400, "unknown_account", `No account ${id}`);
  return found;
}

/** The interop hooks (docs/interop-spec.md, section 5.3) against whichever mock `current` returns now. */
export function mockHooks(current: () => MockCompany): Record<string, Hook> {
  return {
    async fixture() {
      return {
        accounts: DEFAULT_CONFIG.accounts.map((item) => item.account),
        scopes: { read: ["orders:read"], write: ["orders:read", "orders:write"] },
        openapi_public: { api: "openapi", operation: "searchProducts", args: { params: { q: "jacket" } } },
        openapi: { api: "openapi", operation: "listOrders", args: {} },
        openapi_write: {
          api: "openapi",
          operation: "exchangeItem",
          args: { params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } }
        },
        mcp: { api: "mcp", tool: "search_products", args: { query: "jacket" } },
        // Scenario OU: a photo uploaded signed out, then an order of it that proposes an operation.
        openapi_upload: { api: "openapi", operation: "uploadPhoto", args: { files: { photo: "lake.jpg" } } },
        openapi_propose: {
          api: "openapi",
          operation: "orderPrints",
          args: {
            body: {
              email: "ada@example.com",
              ship_to: { name: "Ada Lovelace", line1: "12 St James's Square", city: "London", postal_code: "SW1Y 4JH", country: "GB" },
              items: [{ photo_id: "${upload_id}", copies: 1 }]
            }
          }
        },
        prompts: {
          hello: "Hello",
          operation: "I'd like to exchange the jacket on my order",
          sign_in: "Where is my order?"
        },
        otp_account: DEFAULT_CONFIG.accounts.find((item) => item.otp)?.account ?? null
      };
    },
    async approve_authorization(params) {
      const account = accountFor(params.account).account;
      const granted = scopes(params.scopes);
      const redirect = await current().approveAuthorization(str(params.url, "url"), {
        account,
        approve: true,
        ...(granted ? { scopes: granted } : {})
      });
      return { redirect };
    },
    async deny_authorization(params) {
      return { redirect: await current().approveAuthorization(str(params.url, "url"), { approve: false }) };
    },
    async approve_device(params) {
      const granted = scopes(params.scopes);
      await current().approveDevice(str(params.user_code, "user_code"), {
        account: accountFor(params.account).account,
        ...(granted ? { scopes: granted } : {})
      });
      return {};
    },
    async deny_device(params) {
      await current().denyDevice(str(params.user_code, "user_code"));
      return {};
    },
    async mediated_answers(params) {
      const account = accountFor(params.account);
      return { fields: { email: account.email, password: account.password } };
    },
    async last_one_time_code() {
      const code = await current().lastOneTimeCode();
      if (!code) throw new HookError(409, "no_code", "No one-time code has been sent");
      return { code };
    },
    async end_sessions() {
      return { ended: await current().endAllSessions() };
    },
    async staff_join(params) {
      await current().humanJoin(str(params.conversation, "conversation"), str(params.text, "text"));
      return {};
    },
    async staff_reply(params) {
      await current().say(str(params.conversation, "conversation"), str(params.text, "text"));
      return {};
    },
    /**
     * The mock's Company Agent proposes the exchange when the agent asks for
     * one (fixture `prompts.operation`) in a signed-in conversation; this
     * returns that proposal.
     */
    async propose_operation() {
      const state = await current().state();
      const proposed = state.operations.filter((item) => item.state === "proposed").at(-1);
      if (!proposed) {
        throw new HookError(409, "no_operation", "Nothing proposed: send fixture.prompts.operation in a signed-in conversation first");
      }
      return { operation: proposed.id };
    },
    /** No person is available for a queued handoff: back to `idle` with the Company Agent, which says why (7.9). */
    async staff_unavailable(params) {
      await current().staffUnavailable(str(params.conversation, "conversation"), str(params.text, "text"));
      return {};
    },
    /** The Company closes a conversation itself (7.12). */
    async company_close(params) {
      await current().closeConversation(str(params.conversation, "conversation"));
      return {};
    },
    /** The Company asks to talk with the User: a `user_requested` event with a `reason` (7.10). */
    async request_user(params) {
      const event = await current().pushEvent(str(params.conversation, "conversation"), { type: "user_requested", reason: str(params.reason, "reason") });
      return { event };
    },
    async require_nonce() {
      await current().configure({ requireNonce: true });
      return {};
    },
    async rate_limit(params) {
      const count = typeof params.requests === "number" ? params.requests : 1;
      const retryAfter = typeof params.retry_after === "number" ? params.retry_after : 1;
      await current().limitNext(params.endpoint === "token" ? "token" : "other", count, retryAfter);
      return {};
    },
    async expire_tokens() {
      return { expired: await current().expireAccessTokens() };
    },
    /** From now until reset, the issuer has a path, its metadata inserted before it (RFC 8414 3.1, S3). */
    async issuer_path(params) {
      const issuerPath = params.path === undefined ? "/tenant" : str(params.path, "path");
      if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(issuerPath)) throw new HookError(400, "invalid_path", `path must be like /tenant: ${JSON.stringify(issuerPath)}`);
      await current().configure({ issuerPath });
      return { path: issuerPath };
    }
  };
}

/**
 * `GET /violations`: every check the mock recorded, in order, by id, with
 * what it rests on (`basis`, test/mock-company/violations.ts), its `level`
 * (`failure`, `warning` or `tentative`; docs/conformance-levels.md) and its
 * detail. Both profiles report everything: the runner makes a failure an
 * error and the rest warnings, which never fail a cell, so nothing needs
 * leaving out for the reference Company. (An unknown id has no basis and
 * counts as a failure.)
 */
export function violationsBody(state: { readonly recorded: readonly string[] }): {
  violations: { id: string; basis: Basis | null; level: Level; detail: string }[];
} {
  const known = (id: string): id is ViolationId => (VIOLATION_IDS as readonly string[]).includes(id);
  return {
    violations: state.recorded.map((recorded) => {
      const id = violationId(recorded);
      const detail = recorded.replace(/^\[[^\]]+\]\s*/, "");
      return known(id) ? { id, basis: basisOf(id), level: levelOfCheck(id), detail } : { id, basis: null, level: "failure", detail };
    })
  };
}
