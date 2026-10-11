// Serves poppyseed's hooks protocol in front of any interop spec 5.3 Company adapter, so
// `poppyseed check <origin> --hooks http://127.0.0.1:$BRIDGE_PORT` can use it:
//
//   GET  /hooks   -> {"hooks": [...], "profile": {...}}
//   POST /{hook}  {"args": [...]} -> {"result": ...}
//
// Usage: ADAPTER=http://company:8081 INTEROP_SECRET=... node check-bridge.mjs
//
// Only hooks with a 5.3 equivalent are offered. poppyseed's siteSignIn (a site cookie),
// connections, disconnect and performed have none, so the checks that need them skip.
import http from 'node:http';

const ADAPTER = (process.env.ADAPTER ?? 'http://127.0.0.1:8081').replace(/\/+$/, '');
const PORT = Number(process.env.BRIDGE_PORT ?? 8090);
const auth = { authorization: `Bearer ${process.env.INTEROP_SECRET ?? ''}` };

async function hook(name, params = {}) {
  const r = await fetch(`${ADAPTER}/hooks/${name}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const body = await r.json();
  if (r.status !== 200) throw new Error(`${name}: ${r.status} ${JSON.stringify(body)}`);
  return 'result' in body ? body.result : body;
}

// poppyseed hook name -> [5.3 hook it needs, call]
const MAP = {
  endSession: ['end_sessions', id => hook('end_sessions', { session_id: id })],
  staffJoin: ['staff_join', id => hook('staff_join', { conversation: id })],
  staffReply: ['staff_reply', (id, text) => hook('staff_reply', { conversation: id, text })],
  lastCode: ['last_one_time_code', async () => (await hook('last_one_time_code')).code],
  settle: ['settle_operation', (id, state, summary) => hook('settle_operation', { operation: id, outcome: state, summary })]
};

async function listing() {
  const r = await fetch(`${ADAPTER}/hooks`, { headers: auth });
  const offered = (await r.json()).hooks ?? [];
  const hooks = Object.entries(MAP).filter(([, [needs]]) => offered.includes(needs)).map(([name]) => name);
  let profile;
  if (offered.includes('fixture')) {
    const f = await hook('fixture');
    profile = f.poppyseed_profile ?? (f.mcp ? { publicTool: { name: f.mcp.tool, arguments: f.mcp.args ?? {} } } : undefined);
  }
  return { hooks, profile };
}

http.createServer(async (req, res) => {
  const name = new URL(req.url, 'http://bridge').pathname.slice(1);
  try {
    if (req.method === 'GET' && name === 'hooks') return res.end(JSON.stringify(await listing()));
    if (req.method !== 'POST' || !MAP[name]) { res.writeHead(404); return res.end('not found'); }
    let s = '';
    for await (const c of req) s += c;
    const { args = [] } = JSON.parse(s || '{}');
    res.end(JSON.stringify({ result: (await MAP[name][1](...args)) ?? null }));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.message ?? e));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[bridge] poppyseed hooks on 127.0.0.1:${PORT} -> ${ADAPTER}`));
