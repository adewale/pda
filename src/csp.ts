/**
 * The Content-Security-Policy of every page we serve: the app's page (static
 * assets, through `public/_headers`, which a test keeps equal to this) and the
 * pages the Worker writes itself (the validator, the Poppy callback).
 *
 * Images load only from this origin or `data:`, so markdown or HTML the model
 * writes can't make the browser fetch a URL that carries data out. Scripts
 * come only from this origin (the theme script is a file, not inline), and
 * connections only go back to it (`'self'` covers the page's own WebSocket).
 * The one service worker (`/sw.js`, for notifications) and the web app
 * manifest come from this origin too. Inline styles stay allowed: the UI kit and the validator page use them.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

/** `response`, with the policy if it is a page. */
export function withPagePolicy(response: Response): Response {
  if (response.status === 101 || !/^text\/html\b/i.test(response.headers.get("Content-Type") ?? "")) return response;
  const page = new Response(response.body, response);
  page.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  return page;
}
