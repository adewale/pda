/**
 * `cloudflare:workers` for our adapters in Node: just enough for the mock
 * Company and the shared rate limiter, which extend `DurableObject` and use
 * `ctx.storage` and `ctx.id.name`. The esbuild bundle (build.mjs) maps the
 * module here; nothing else of the Workers runtime is used.
 */
export class DurableObject<E = unknown> {
  ctx: unknown;
  env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const env = {};

/** A Durable Object state with an in-memory key-value store and a name. */
export function memoryState(name: string) {
  const values = new Map<string, unknown>();
  return {
    id: { name, toString: () => name },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
      delete: async (key: string) => values.delete(key)
    }
  };
}
