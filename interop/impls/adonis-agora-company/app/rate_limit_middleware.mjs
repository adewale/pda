// The host's rate limit on its own API (`/api/*`, but not the OpenAPI document), armed by the
// interop `rate_limit` hook. Token-endpoint limits go through AuthKit's own limiter instead
// (server.mjs, `personalAgents.poppy.rateLimit`).
import { state } from './hooks.mjs';

export default class RateLimitMiddleware {
  async handle(ctx, next) {
    const path = (ctx.request.url() ?? '').split('?')[0];
    if (path.startsWith('/api/') && path !== '/api/openapi.json') {
      const retryAfter = state.takeLimit('resource');
      if (retryAfter !== null) {
        ctx.response.header('Retry-After', String(retryAfter));
        ctx.response.header('Cache-Control', 'no-store');
        return ctx.response.status(429).json({ error: 'rate_limited', error_description: 'Too many requests' });
      }
    }
    return next();
  }
}
