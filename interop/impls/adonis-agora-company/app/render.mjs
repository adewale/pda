// The host's screens. AuthKit leaves rendering to the host app (`render(ctx, view, props)`); a real
// app uses Inertia or Edge. These are plain HTML forms with the same fields, so a person (or the
// adapter's hooks, acting as that person in a browser) uses AuthKit's own login and consent routes.
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;

function login(props) {
  return page(
    'Sign in',
    `<h1>Sign in</h1>${props.error ? `<p class="error">${esc(props.error)}</p>` : ''}
<form method="post" action="/account/login" id="login">
<input type="hidden" name="_csrf" value="${esc(props.csrfToken)}">
${props.returnTo ? `<input type="hidden" name="return_to" value="${esc(props.returnTo)}">` : ''}
<label>Email <input name="email" type="email"></label>
<label>Password <input name="password" type="password"></label>
<button type="submit">Sign in</button>
</form>`,
  );
}

function consent(props) {
  const r = props.request;
  if (!r) {
    // Device screen asking for a code, or an error.
    return page(
      'Connect an agent',
      `<h1>Connect an agent</h1>${props.error ? `<p class="error">${esc(props.error)}</p>` : ''}
<form method="get" action="${esc(props.action)}" id="code"><label>Code <input name="user_code"></label><button>Continue</button></form>`,
    );
  }
  const hidden = [
    ...(r.hidden ?? []),
    ...(r.userCode ? [{ name: 'user_code', value: r.userCode }] : []),
  ];
  return page(
    'Connect an agent',
    `<h1>${esc(r.agentName)} wants access to your account</h1>
<p>Agent: <code>${esc(r.agentOrigin)}</code>. Signed in as ${esc(props.account?.email)}.</p>
<form method="post" action="${esc(props.action)}" id="consent">
<input type="hidden" name="_csrf" value="${esc(props.csrfToken)}">
${hidden.map((h) => `<input type="hidden" name="${esc(h.name)}" value="${esc(h.value)}">`).join('\n')}
${(r.scopes ?? [])
  .map((s) => `<label><input type="checkbox" name="scope" value="${esc(s.id ?? s)}" checked> ${esc(s.description ?? s)}</label>`)
  .join('\n')}
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}

function done(props) {
  return page('Done', `<h1 data-status="${esc(props.status)}">${esc(props.status)}</h1>`);
}

export function render(ctx, view, props) {
  const html =
    view === 'account/login' ? login(props) : view === 'agents/consent' ? consent(props) : view === 'agents/done' ? done(props) : page(view, `<h1>${esc(view)}</h1>`);
  ctx.response.header('Content-Type', 'text/html; charset=utf-8');
  return ctx.response.send(html);
}
