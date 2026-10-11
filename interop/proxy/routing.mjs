/**
 * Which container serves a name (interop spec section 3): a Company `x` at
 * `x.company.interop.test` and any subdomain of it, an agent `y` at
 * `y.agent.interop.test`. Containers carry the network aliases `company-x`
 * and `agent-y`. Anything else has no upstream.
 *
 * @param {string | null | undefined} hostHeader
 * @returns {string | null}
 */
export function upstreamFor(hostHeader) {
  const host = String(hostHeader ?? "").toLowerCase().replace(/:\d+$/, "");
  const company = /^(?:.+\.)?([a-z0-9-]{1,32})\.company\.interop\.test$/.exec(host);
  if (company) return `company-${company[1]}`;
  const agent = /^(?:.+\.)?([a-z0-9-]{1,32})\.agent\.interop\.test$/.exec(host);
  if (agent) return `agent-${agent[1]}`;
  return null;
}
