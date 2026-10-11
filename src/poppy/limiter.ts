import { DurableObject } from "cloudflare:workers";

/** What one Company has told us about our `client_id`'s limits. */
export type LimitState = {
  /** Epoch ms before which no request should be sent to this Company. */
  readonly blockedUntil: number;
  /** From `RateLimit`: requests left in the current window, if known. */
  readonly remaining: number | null;
  /** Epoch ms when `remaining` resets, if known. */
  readonly resetAt: number | null;
};

const EMPTY: LimitState = { blockedUntil: 0, remaining: null, resetAt: null };

/**
 * One per Company issuer. Companies rate-limit by `client_id`, and every
 * person's agent shares ours, so limits are tracked here and shared across
 * all Users and tasks (Guides, "Rate limits") instead of each agent finding
 * them on its own.
 */
export class CompanyLimiter extends DurableObject<Env> {
  #state: LimitState | undefined;

  async #load(): Promise<LimitState> {
    this.#state ??= (await this.ctx.storage.get<LimitState>("state")) ?? EMPTY;
    return this.#state;
  }

  async #save(state: LimitState): Promise<void> {
    this.#state = state;
    await this.ctx.storage.put("state", state);
  }

  /** How long to wait before sending, in ms; 0 means go ahead. */
  async delay(): Promise<number> {
    const state = await this.#load();
    const now = Date.now();
    if (state.blockedUntil > now) return state.blockedUntil - now;
    if (state.remaining !== null && state.remaining <= 0 && state.resetAt && state.resetAt > now) {
      return state.resetAt - now;
    }
    return 0;
  }

  /** A 429 or 503 with `Retry-After`: nobody sends before then. */
  async blockUntil(epochMs: number): Promise<void> {
    const state = await this.#load();
    if (epochMs > state.blockedUntil) await this.#save({ ...state, blockedUntil: epochMs });
  }

  /** The `RateLimit` header's remaining count and reset, after a response. */
  async observe(remaining: number, resetAt: number): Promise<void> {
    const state = await this.#load();
    await this.#save({ ...state, remaining, resetAt });
  }

  async state(): Promise<LimitState> {
    return this.#load();
  }
}
