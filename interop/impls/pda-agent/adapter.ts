/**
 * Our Personal Agent as an interop agent (docs/interop-spec.md, section
 * 5.2). It drives src/poppy directly, never the model: the same PoppyClient,
 * sign-in, conversation, API and operations code the Durable Object runs,
 * in Node, with SQLite from node:sqlite in place of the Durable Object's and
 * jobs run when a step waits on them instead of by alarms.
 *
 * Port 8080: our client metadata and keys at `$INTEROP_ORIGIN/poppy/*.json`
 * (behind the recording proxy), and `/poppy/callback` for Direct Sign-In.
 * Port 8081: the manifest and control API, with `Authorization: Bearer $INTEROP_SECRET`.
 *
 * No relaxation of src/poppy is needed: `*.interop.test` names already pass
 * its public-host check, and Node trusts the run's CA via NODE_EXTRA_CA_CERTS.
 * `INTEROP_FAULT` breaks the agent on purpose, to prove attribution; it lives
 * only here, in the adapter's network seam, never in src/poppy.
 * In the live lane, `INTEROP_LIVE_CLIENT_ID` and `INTEROP_LIVE_KEY` give it
 * the interop test client our deployed Worker publishes (live-identity.ts).
 */
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT } from "jose";
import { memoryState } from "../shared/cloudflare-workers.ts";
import { authorized, body, failure, json, serve, setting } from "../shared/serve.ts";
import { memorySql } from "./sqlite.ts";
import { AttachmentError, migrateAttachments, saveAttachment } from "../../../src/attachments.ts";
import { callMcpTool, callOpenApi } from "../../../src/poppy/apis.ts";
import { PoppyClient, PoppyError, type JobName, type PoppyHost } from "../../../src/poppy/client.ts";
import { closeConversation, conversation as conversationRow, handoff, readConversation, sendMessage } from "../../../src/poppy/conversations.ts";
import { browse } from "../../../src/poppy/browser.ts";
import { FetchBrowser } from "../../../src/poppy/fetch-browser.ts";
import { DiscoveryError, isCompany, type Company, type SignInType } from "../../../src/poppy/discovery.ts";
import type { Fetcher } from "../../../src/poppy/fetch.ts";
import type { Json } from "../../../src/poppy/json.ts";
import { randomId } from "../../../src/poppy/jwt.ts";
import { currentKey } from "../../../src/poppy/keys.ts";
import { CompanyLimiter } from "../../../src/poppy/limiter.ts";
import { approveAndConfirm, cancelOperation, decideLocal, operation as operationOf, trackOperation } from "../../../src/poppy/operations.ts";
import { EndpointRequest } from "../../../src/poppy/outgoing.ts";
import { handleIdentityRoute } from "../../../src/poppy/routes.ts";
import {
  completeDirectSignIn,
  pollDeviceSignIn,
  signOut,
  startSignIn,
  submitCredentials,
  submitSignInCode
} from "../../../src/poppy/signin.ts";
import { approvalsTable, inboxTable, intentsTable, migrate, operationsTable, signInsTable } from "../../../src/poppy/store.ts";
import { rows } from "../../../src/rows.ts";
import type { Card } from "../../../src/poppy/wire.ts";
import { ATTACKS, AttackSetupError, runAttack, type AttackContext } from "./attacks.ts";
import { LiveIdentityClient, liveIdentityFrom } from "./live-identity.ts";

const NAME = process.env.INTEROP_NAME ?? "pda";
/** Interop-only: the adversarial Personal Agent (`evil-agent`). Off unless the registry sets it. */
const ADVERSARY = process.env.INTEROP_ADVERSARY === "agent";
const SECRET = setting("INTEROP_SECRET");
/** Live lane only: the interop test client's public client_id and its key, from the runner (live-identity.ts). */
const LIVE = liveIdentityFrom({ INTEROP_LIVE_CLIENT_ID: process.env.INTEROP_LIVE_CLIENT_ID ?? "", INTEROP_LIVE_KEY: process.env.INTEROP_LIVE_KEY ?? "" });
// Read once; nothing else in this process needs the key in its environment.
delete process.env.INTEROP_LIVE_KEY;
if (LIVE && ADVERSARY) throw new Error("The adversarial agent never takes the live identity");
const ORIGIN = LIVE?.origin ?? process.env.INTEROP_ORIGIN ?? `https://${NAME}.agent.interop.test`;
const COMMIT = process.env.INTEROP_COMMIT ?? "unknown";
/** Interop-only: break the agent on purpose. `assertion-typ` drops `typ` from client and Session assertions. */
const FAULT = process.env.INTEROP_FAULT ?? "";

const MANIFEST = {
  interop: 1,
  name: NAME,
  role: "agent",
  commit: COMMIT,
  poppy: ["0.1"],
  extensions: ["operations"],
  scenarios: ADVERSARY
    ? [...ATTACKS]
    : [
        "D", "S0", "N", "SD", "SV", "SVN", "SM", "SMC", "SX", "SXV", "C", "CI", "CS", "CA", "SO", "O", "OX", "OU", "SE", "R", "AO", "AM", "AS", "RL", "DP",
        "H", "DC", "W", "O2", "CM",
        // Honest agent against the fault-injection proxy (docs/adversarial-interop.md) and malicious Companies.
        "NREP", "CDUP", "CIDUP", "ODUP", "XH", "XI", "BX", "XB", "XN", "XO", "XP", "XE", "XR", "XT"
      ],
  // S1 "endpoint": a client assertion's aud is the endpoint it is sent to, then, after an invalid_client at the
  // device or revocation endpoint, the token endpoint (src/poppy/client.ts oauthRequest; docs/readings.md S1).
  readings: { S1: "endpoint", S2: "jwt-60s", S3: "insertion", S4: "omit", S23: "per-origin" },
  relaxations: [] as string[],
  ...(ADVERSARY ? { attacks: [...ATTACKS], adversarial: true } : {}),
  ...(FAULT ? { faults: [FAULT] } : {}),
  notes: ADVERSARY
    ? "Adversarial Personal Agent: raw attacks over the wire (interop/impls/pda-agent/attacks.ts); never src/poppy."
    : "Drives src/poppy directly (PoppyClient, signin, conversations, apis, operations); no model."
};

/** The armed attack, for the adversarial agent's `arm` then `attack` ops. */
let armed: { attack: string; params: Params } | null = null;

// ---------------------------------------------------------------- The agent, per reset

type Job = { fn: JobName; at: number; payload: Json };

type Agent = {
  client: PoppyClient;
  env: Env;
  jobs: Map<string, Job>;
  cards: Map<string, Card>;
  notes: string[];
  /** Labels are suffixed per reset, so module-level caches (MCP sessions) never carry over. */
  generation: string;
  /** The agent's own browser for the website (spec 5): src/poppy/fetch-browser.ts. */
  browser: FetchBrowser;
};

/**
 * Node has no `HTMLRewriter`, with which src/poppy/fetch-browser.ts reads a
 * page's text, links and forms. Interop-only stand-in: every page reads as
 * empty. Scenario W tests the browser Session join and the cookie on the
 * wire, not what a page says; page reading is tested in the Workers pool.
 */
if (!("HTMLRewriter" in globalThis)) {
  (globalThis as Record<string, unknown>).HTMLRewriter = class {
    on() {
      return this;
    }
    onDocument() {
      return this;
    }
    transform(response: Response) {
      return response;
    }
  };
}

async function signingKeys(): Promise<string> {
  const keys = [];
  for (const kid of [`k-${randomId("", 6)}`, `k-${randomId("", 6)}`]) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    keys.push({ ...(await exportJWK(privateKey)), kid, alg: "ES256", use: "sig" });
  }
  return JSON.stringify(keys);
}

/** Re-sign a JWT's claims without `typ` in its header (INTEROP_FAULT=assertion-typ). */
async function withoutTyp(jwt: string, env: Env): Promise<string> {
  const header = decodeProtectedHeader(jwt);
  const key = await currentKey(env);
  return new SignJWT(decodeJwt(jwt)).setProtectedHeader({ alg: String(header.alg), ...(header.kid ? { kid: header.kid } : {}) }).sign(key.privateKey);
}

/** Live lane: at most one request per `INTEROP_PACE_MS` to each host. */
const PACE_MS = Number(process.env.INTEROP_PACE_MS ?? "0");
const lastRequest = new Map<string, Promise<void>>();
function pace(host: string): Promise<void> {
  if (!(PACE_MS > 0)) return Promise.resolve();
  const previous = lastRequest.get(host) ?? Promise.resolve();
  const turn = previous.then(() => new Promise<void>((resolve) => setTimeout(resolve, PACE_MS)));
  lastRequest.set(host, turn);
  return previous;
}

/** Every outbound request: the network, through the proxy, with an optional fault. */
function fetcherFor(env: Env): Fetcher {
  return async (request) => {
    await pace(new URL(request.url).host);
    if (FAULT === "assertion-typ" && request.method === "POST" && (request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(await request.clone().text());
      let changed = false;
      for (const name of ["client_assertion", "assertion"]) {
        const value = form.get(name);
        if (value && value.split(".").length === 3) {
          form.set(name, await withoutTyp(value, env));
          changed = true;
        }
      }
      if (changed) return fetch(new Request(request, { body: form.toString() }));
    }
    return fetch(request);
  };
}

async function newAgent(): Promise<Agent> {
  const limiters = new Map<string, CompanyLimiter>();
  const env = {
    PUBLIC_ORIGIN: ORIGIN,
    POPPY_CLIENT_NAME: LIVE ? "Poppy Demo Agent (interop tests)" : `Interop agent ${NAME} (Poppy Demo Agent)`,
    POPPY_LOGO_URI: `${ORIGIN}/logo.png`,
    POPPY_SIGNING_JWKS: LIVE ? LIVE.signingJwks : await signingKeys(),
    TOKEN_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    CompanyLimiter: {
      getByName(name: string) {
        let limiter = limiters.get(name);
        if (!limiter) {
          limiter = new CompanyLimiter(memoryState(name) as never, {} as Env);
          limiters.set(name, limiter);
        }
        return limiter;
      }
    }
  } as unknown as Env;
  const sql = memorySql();
  migrate(sql);
  migrateAttachments(sql);
  const jobs = new Map<string, Job>();
  const cards = new Map<string, Card>();
  const notes: string[] = [];
  const host: PoppyHost = {
    env,
    sql,
    fetcher: fetcherFor(env),
    showCard: async (card) => {
      cards.set(card.id, card);
    },
    notifyModel: async (text) => {
      notes.push(text);
    },
    schedule: async (fn, at, payload, id) => {
      jobs.set(id, { fn, at, payload });
    },
    hasJob: (id) => jobs.has(id),
    pushDirect: () => undefined,
    userContext: () => ({ locale: "en-GB", time_zone: "Europe/London", user_available: true }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  };
  // The fetch-based browser of src/poppy (spec 5), on the adapter's network seam.
  const client = LIVE ? new LiveIdentityClient(host, LIVE) : new PoppyClient(host);
  return { client, env, jobs, cards, notes, generation: randomId("", 4), browser: new FetchBrowser(host.fetcher) };
}

let agent = await newAgent();

// ---------------------------------------------------------------- Steps

class StepError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

type Params = Record<string, unknown>;
const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new StepError(400, "invalid_params", `${name} must be a non-empty string`);
  return value;
};
const optional = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const label = (params: Params) => `${optional(params.label) ?? "main"}@${agent.generation}`;
const plainLabel = (value: string) => value.replace(/@[^@]*$/, "");

/** How long the `sse` op waits for a stream's response headers. */
const SSE_HEADER_DEADLINE_MS = 10_000;

async function company(domain: string): Promise<Company> {
  return agent.client.company(domain);
}

function sessionResult(company: Company, sessionLabel: string) {
  const session = agent.client.session(company.issuer, sessionLabel);
  if (!session) throw new StepError(500, "no_session", "No Session after the exchange");
  return {
    session_id: session.session_id,
    signed_in: session.signed_in === 1,
    scope: session.scope,
    ...(session.account ? { account: session.account } : {})
  };
}

/** Run a scheduled job until it reports done, waiting until each run is due. */
async function drain(id: string, run: (job: Job) => Promise<number | null>, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const job = agent.jobs.get(id);
    if (!job) return;
    const wait = job.at - Date.now();
    if (Date.now() + Math.max(0, wait) > deadline) return;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    agent.jobs.delete(id);
    const next = await run(job);
    if (next !== null && !agent.jobs.has(id)) agent.jobs.set(id, { ...job, at: next });
  }
}

/** The sign-in a step started, per Company and label, for `signin_continue`. */
const pending = new Map<string, { id: string; type: string; issuer: string; label: string }>();

function signInRow(id: string) {
  return rows(
    agent.client.sql,
    signInsTable.pick("status", "account", "label", "issuer"),
    "SELECT status, account, label, issuer FROM poppy_signins WHERE id = ?",
    id
  )[0];
}

/** Why a sign-in didn't complete, from what the agent told the model. */
function signInFailure(issuer: string): PoppyStepError {
  const note = [...agent.notes].reverse().find((line) => line.includes("didn't complete")) ?? "";
  // src/poppy/signin.ts words the outcome for the User; these are the codes behind its words.
  const worded: [RegExp, string][] = [
    [/the User declined/, "access_denied"],
    [/the code expired/, "expired_token"],
    [/the company returned ([a-z_]+)/, "$1"]
  ];
  const match = worded.map(([pattern, code]) => [pattern.exec(note), code] as const).find(([found]) => found);
  const code = match
    ? match[1].replace("$1", match[0]![1] ?? "")
    : (/\(([a-z_]+)\)/.exec(note)?.[1] ?? /: ([a-z_]+)$/.exec(note)?.[1] ?? "sign_in_failed");
  return new PoppyStepError(code, 0, `${issuer}: ${note}`);
}

/** A Poppy error the Company returned, or a refusal of ours: `{ok: false, poppy_error}`. */
class PoppyStepError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, detail: string) {
    super(detail);
    this.code = code;
    this.status = status;
  }
}

async function signedInResult(company: Company, sessionLabel: string, id: string) {
  const row = signInRow(id);
  if (row?.status !== "done") throw signInFailure(company.issuer);
  pending.delete(`${company.issuer}|${sessionLabel}`);
  const session = sessionResult(company, sessionLabel);
  return { signed_in: session.signed_in, account: session.account ?? null, scope: session.scope, session_id: session.session_id };
}

const STEPS: Record<string, (domain: string, params: Params) => Promise<unknown>> = {
  async discover(domain) {
    const found = await agent.client.lookup(domain);
    if (!isCompany(found)) return { issuer: null, website_only: true, name: found.name };
    return {
      issuer: found.issuer,
      poppy_version: found.protocolVersion,
      conversations: !!found.conversations,
      apis: found.apis.map((api) => api.type),
      sign_in: Object.keys(found.signIn),
      extensions: Object.keys(found.extensions)
    };
  },

  async session(domain, params) {
    const c = await company(domain);
    await agent.client.token(c, { label: label(params) });
    return sessionResult(c, label(params));
  },

  async signin(domain, params) {
    const c = await company(domain);
    const method = optional(params.method);
    if (method && method !== "direct" && method !== "device" && method !== "mediated") {
      throw new StepError(400, "invalid_params", `Unknown sign-in method ${method}`);
    }
    const scopes = Array.isArray(params.scopes) ? params.scopes.filter((s): s is string => typeof s === "string") : ["poppy:read"];
    const sessionLabel = label(params);
    const account = optional(params.account);
    const started = await startSignIn(agent.client, c, {
      label: sessionLabel,
      scopes,
      reason: "Interop scenario",
      ...(account ? { account } : {}),
      ...(method ? { type: method as SignInType } : {})
    });
    if (started.status === "signed_in") {
      const session = sessionResult(c, sessionLabel);
      return { signed_in: true, account: session.account ?? null, scope: started.scope };
    }
    pending.set(`${c.issuer}|${sessionLabel}`, { id: started.signInId, type: started.type, issuer: c.issuer, label: sessionLabel });
    const card = agent.cards.get(`signin-${started.signInId}`);
    if (card?.kind === "signin_link") return { pending: { type: "direct", url: card.url } };
    if (card?.kind === "signin_device") {
      return {
        pending: {
          type: "device",
          url: card.verificationUri,
          user_code: card.userCode,
          ...(card.verificationUriComplete ? { url_complete: card.verificationUriComplete } : {})
        }
      };
    }
    if (card?.kind === "signin_credentials") return { pending: { type: "mediated", fields: card.fields.map((field) => field.name) } };
    throw new StepError(500, "no_card", `Sign-in ${started.signInId} showed no card`);
  },

  async signin_continue(domain, params) {
    const c = await company(domain);
    const sessionLabel = label(params);
    const started = pending.get(`${c.issuer}|${sessionLabel}`);
    if (!started) throw new StepError(409, "no_pending_signin", "No sign-in in progress for this Company and label");
    if (started.type === "direct") {
      const callback = new URL(text(params.callback_url, "callback_url"));
      const outcome = await completeDirectSignIn(agent.client, callback);
      if (!outcome.ok) {
        const error = callback.searchParams.get("error");
        if (error) throw new PoppyStepError(error, 0, outcome.message);
        throw signInFailure(c.issuer);
      }
      return signedInResult(c, sessionLabel, started.id);
    }
    if (started.type === "device") {
      await drain(`device-${started.id}`, async () => pollDeviceSignIn(agent.client, started.id), 90_000);
      return signedInResult(c, sessionLabel, started.id);
    }
    // Mediated: the fields, then perhaps a one-time code.
    const row = signInRow(started.id);
    if (row?.status === "code") {
      const outcome = await submitSignInCode(agent.client, started.id, text(params.code, "code"));
      if (outcome === "code") return { pending: { type: "mediated", code_required: true } };
      return signedInResult(c, sessionLabel, started.id);
    }
    const fields = typeof params.fields === "object" && params.fields !== null ? (params.fields as Record<string, string>) : {};
    const outcome = await submitCredentials(agent.client, started.id, fields);
    if (outcome === "code") return { pending: { type: "mediated", code_required: true } };
    return signedInResult(c, sessionLabel, started.id);
  },

  async send(domain, params) {
    const c = await company(domain);
    const conversationId = optional(params.conversation);
    const parentConversationId = optional(params.parent_conversation);
    const callKey = optional(params.message_id) ?? randomId("call_");
    if (params.sender !== undefined && params.sender !== "agent" && params.sender !== "human") {
      throw new StepError(400, "invalid_params", "sender must be agent or human");
    }
    const sent = await sendMessage(agent.client, c, {
      // A Direct Conversation goes in its parent's Session (7.10).
      label: (parentConversationId ? conversationRow(agent.client, parentConversationId)?.label : undefined) ?? label(params),
      callKey,
      ...(conversationId ? { conversationId } : {}),
      ...(parentConversationId ? { parentConversationId } : {}),
      // The User's own words, as a Direct Conversation carries them (7.8, 7.10).
      sender: params.sender === "human" ? "human" : "agent",
      text: text(params.text, "text"),
      ...(typeof params.wait === "number" ? { wait: params.wait } : {})
    });
    const intent = rows(agent.client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `message|${callKey}`)[0];
    const messageId = intent ? (JSON.parse(intent.value) as { message: { id: string } }).message.id : null;
    return {
      conversation: sent.conversationId,
      message_id: messageId,
      status: sent.status,
      responder: sent.responder,
      messages: sent.replies.map((reply) => ({ role: "company", sender: reply.sender, text: reply.text ?? null, ...(reply.data !== undefined ? { data: reply.data } : {}) }))
    };
  },

  async read(_domain, params) {
    const id = text(params.conversation, "conversation");
    if (!conversationRow(agent.client, id)) throw new StepError(404, "unknown_conversation", `No conversation ${id}`);
    await readConversation(agent.client, id, typeof params.wait === "number" ? params.wait : 0);
    const row = conversationRow(agent.client, id)!;
    let events = rows(agent.client.sql, inboxTable.pick("event"), "SELECT event FROM poppy_inbox WHERE conversation_id = ? ORDER BY seq", id);
    // With a cursor, only what came after that event (the agent's inbox, in the order it arrived).
    const after = optional(params.cursor);
    const at = after ? events.findIndex((entry) => (JSON.parse(entry.event) as { id?: string }).id === after) : -1;
    if (at !== -1) events = events.slice(at + 1);
    return {
      messages: events.map((entry) => {
        const event = JSON.parse(entry.event) as { id: string; message: { role?: string; sender?: string; text?: string; data?: Json; operation?: { operation_id?: string } } };
        return {
          event: event.id,
          role: event.message.role ?? null,
          sender: event.message.sender ?? null,
          text: event.message.text ?? null,
          ...(event.message.operation?.operation_id ? { operation: event.message.operation.operation_id } : {})
        };
      }),
      cursor: row.cursor,
      has_more: false,
      status: row.status,
      responder: row.responder
    };
  },

  async sse(domain, params) {
    const c = await company(domain);
    const id = text(params.conversation, "conversation");
    const endpoint = c.conversations?.endpoint.replace(/\/+$/, "");
    if (!endpoint) throw new PoppyStepError("no_company_agent", 0, "No conversation endpoint");
    const url = new URL(`${endpoint}/${encodeURIComponent(id)}/events`);
    const cursor = optional(params.cursor);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("wait", String(typeof params.wait === "number" ? params.wait : 1));
    const opened = agent.client.resource(
      c,
      EndpointRequest.to(c, { method: "GET", url: url.href, accept: "text/event-stream", ...(cursor ? { headers: { "Last-Event-ID": cursor } } : {}) }),
      { label: label(params), ...(c.conversations?.resource ? { resource: c.conversations.resource } : {}) }
    );
    // A Company may hold an idle stream's headers until its first event: that is a stream with nothing new yet.
    const response = await Promise.race([opened, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SSE_HEADER_DEADLINE_MS))]);
    if (response === "timeout") {
      opened.then((late) => late.body?.cancel(), () => undefined);
      return { events: [], last_id: null, note: `no response headers within ${SSE_HEADER_DEADLINE_MS / 1000} s` };
    }
    const max = typeof params.max_events === "number" ? params.max_events : 50;
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      await response.body?.cancel();
      throw new PoppyStepError("not_streamed", response.status, `Answered ${type || "no content type"}`);
    }
    const events: { id: string | null; type: string; data: Json }[] = [];
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const deadline = Date.now() + 10_000;
    let buffer = "";
    try {
      while (events.length < max && Date.now() < deadline) {
        const next = await Promise.race([reader.read(), new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now())))]);
        if (next === "timeout" || next.done) break;
        buffer += next.value.replace(/\r\n?/g, "\n");
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1 && events.length < max) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let eventId: string | null = null;
          let eventType = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "id") eventId = value;
            else if (field === "event") eventType = value;
            else if (field === "data") data.push(value);
          }
          if (data.length === 0) continue;
          let payload: Json = data.join("\n");
          try {
            payload = JSON.parse(data.join("\n")) as Json;
          } catch {
            // Kept as text.
          }
          events.push({ id: eventId, type: eventType, data: payload });
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const ids = events.map((event) => event.id).filter((value): value is string => !!value);
    return { events, last_id: ids.at(-1) ?? null };
  },

  async api(domain, params) {
    const c = await company(domain);
    const args = typeof params.args === "object" && params.args !== null ? (params.args as Record<string, unknown>) : {};
    const api = optional(params.api) ?? "openapi";
    if (api === "mcp" || api.endsWith("/mcp")) {
      const result = await callMcpTool(agent.client, c, label(params), {
        ...(api.startsWith("https://") ? { apiUrl: api } : {}),
        tool: text(params.tool, "tool"),
        args: args as Json
      });
      return { status: 200, body: result };
    }
    const files = uploads(args.files);
    const result = await callOpenApi(agent.client, c, label(params), {
      ...(api.startsWith("https://") ? { apiUrl: api } : {}),
      operation: text(params.operation, "operation"),
      params: (args.params ?? {}) as Record<string, string>,
      ...(args.body !== undefined ? { body: args.body as Json } : {}),
      ...(files ? { files } : {}),
      callKey: randomId("call_")
    });
    // A write at a Company without the Operations extension, and any upload of the User's
    // file, waits for the User's approval (src/poppy/apis.ts): `held` is the approval
    // `approve_op` decides.
    if (isRecord(result) && typeof result.proposed === "string") return { held: result.proposed };
    // A proposal (Operations 4.1): the Company's 202, with the operation as the agent keeps it.
    if (isRecord(result) && isRecord(result.proposed) && typeof result.proposed.operation_id === "string") {
      const kept = operationOf(agent.client, c.issuer, result.proposed.operation_id);
      return { status: result.status ?? 202, body: { operation: kept ?? result.proposed } };
    }
    return apiResult(result);
  },

  /**
   * The agent's browser joins the Session (spec 5) as `poppy_browse` does:
   * src/poppy/browser.ts posts the browser assertion as a form from the
   * Session's own fetch-based browser context, which follows the 303 with
   * the Company's cookie, then loads `url`.
   */
  async web_join(domain, params) {
    const c = await company(domain);
    const url = text(params.url, "url");
    const page = (await browse(agent.client, agent.browser, c, label(params), { kind: "open", url })) as { url?: string; status?: number };
    return { joined: !!c.web?.browserSessionEndpoint, status: page.status ?? null, url: page.url ?? null };
  },

  /** Ask for a person at the Company (7.9); src/poppy sends a short summary for them first. */
  async handoff(domain, params) {
    const c = await company(domain);
    const id = text(params.conversation, "conversation");
    if (!conversationRow(agent.client, id)) throw new StepError(404, "unknown_conversation", `No conversation ${id}`);
    const summary = optional(params.text) ?? "The User would like to speak with someone at your company.";
    return handoff(agent.client, c, id, summary, randomId("call_"));
  },

  /** Close a conversation (7.12). */
  async close(domain, params) {
    const c = await company(domain);
    const id = text(params.conversation, "conversation");
    if (!conversationRow(agent.client, id)) throw new StepError(404, "unknown_conversation", `No conversation ${id}`);
    await closeConversation(agent.client, c, id);
    const row = conversationRow(agent.client, id)!;
    return { status: row.status, responder: row.responder };
  },

  /**
   * Send the confirm of an approved operation again, unchanged (Ops 5.2):
   * the request src/poppy's tracking job sends when a confirm's answer was
   * lost (Ops 6), with the approval it recorded. src/poppy itself never
   * confirms an operation it knows is no longer proposed, so the adapter
   * sends it through the client's own DPoP-bound request. The answer is the
   * Company's operation, as it returned it.
   */
  async confirm_again(domain, params) {
    const c = await company(domain);
    const id = text(params.operation, "operation");
    const row = rows(
      agent.client.sql,
      operationsTable.pick("approved_revision", "approved_by", "label"),
      "SELECT approved_revision, approved_by, label FROM poppy_operations WHERE issuer = ? AND operation_id = ?",
      c.issuer,
      id
    )[0];
    if (!row || row.approved_revision === null || !row.approved_by) throw new StepError(409, "not_confirmed", `The agent hasn't confirmed ${id}`);
    const endpoint = c.extensions.operations;
    if (!endpoint) throw new PoppyStepError("no_operations", 0, `${c.name} has no operations endpoint`);
    const { status, body } = await agent.client.resourceJson(
      c,
      EndpointRequest.to(c, {
        method: "POST",
        url: `${endpoint.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(id)}/confirm`,
        body: { revision: row.approved_revision, approved_by: row.approved_by }
      }),
      { label: row.label, ...(endpoint.resource ? { resource: endpoint.resource } : {}) }
    );
    const operation = isRecord(body) ? body : {};
    return { status: typeof operation.state === "string" ? operation.state : null, http_status: status, operation };
  },

  async approve_op(domain, params) {
    const c = await company(domain);
    const id = text(params.operation, "operation");
    if (id.startsWith("apr_")) return decideHeld(id, params.decision === "decline" ? "decline" : "approve");
    const operation = operationOf(agent.client, c.issuer, id);
    if (!operation) throw new StepError(404, "unknown_operation", `The agent has no operation ${id} from ${c.issuer}`);
    if (params.decision === "decline") {
      await cancelOperation(agent.client, c.issuer, id);
    } else {
      await approveAndConfirm(agent.client, c.issuer, id, operation.revision, "user");
      await drain(`op-${c.issuer}-${id}`, async () => trackOperation(agent.client, c.issuer, id), 30_000);
    }
    const after = operationOf(agent.client, c.issuer, id)!;
    return { status: after.state, revision: after.revision, ...(after.result?.summary ? { result: after.result.summary } : {}) };
  },

  async signout(domain, params) {
    const c = await company(domain);
    const session = agent.client.session(c.issuer, label(params));
    if (!session?.account) return { revoked: false };
    // The agent stops using the account either way; `revoked` says whether the Company accepted the revocation.
    const outcome = await signOut(agent.client, c.issuer, session.account);
    return { revoked: outcome !== "not_accepted" };
  },

  /**
   * Adversarial agent only (docs/adversarial-interop.md, Part B). `arm` stores an
   * attack; `attack` runs it as a raw wire attack. An unknown attack answers 501,
   * so the cell is `unsupported` (spec §5).
   */
  async arm(_domain, params) {
    if (!ADVERSARY) throw new StepError(501, "unsupported", "This adapter isn't the adversarial agent");
    const attack = text(params.attack, "attack");
    if (!ATTACKS.includes(attack as (typeof ATTACKS)[number])) throw new StepError(501, "unsupported", `Unknown attack ${attack}`);
    armed = { attack, params };
    return { armed: attack };
  },

  async attack(domain, params) {
    if (!ADVERSARY) throw new StepError(501, "unsupported", "This adapter isn't the adversarial agent");
    if (!armed) throw new StepError(409, "not_armed", "No attack armed; call arm first");
    const c = await company(domain);
    const ctx: AttackContext = { clientId: `${ORIGIN}/poppy/client.json`, signingJwks: agent.env.POPPY_SIGNING_JWKS as unknown as string, fetcher: (request) => fetch(request) };
    const result = await runAttack(ctx, c, armed.attack, { ...armed.params, ...params });
    if (result.poppy_error === "unsupported") throw new StepError(501, "unsupported", result.detail ?? "Attack unavailable");
    if (result.poppy_error) throw new PoppyStepError(result.poppy_error, result.status, result.detail ?? `${armed.attack} refused`);
    return { status: result.status, body: result.body };
  },

  /**
   * What the agent would show the User to identify a Company (XP, N14): the
   * verified `organization.domain` and issuer, and the unverified
   * `organization.name`. A misleading name can't impersonate another Company
   * because the agent anchors on the domain, which is verified against the
   * host the document was served for.
   */
  async display(domain) {
    const c = await company(domain);
    return { name: c.name, domain: c.domain, issuer: c.issuer };
  },

  async state() {
    return {
      sessions: agent.client.sessions().map((session) => ({
        issuer: session.issuer,
        label: plainLabel(session.label),
        session_id: session.session_id,
        signed_in: session.signed_in === 1,
        account: session.account,
        scope: session.scope
      })),
      accounts: agent.client.accounts().map((account) => ({ issuer: account.issuer, account: account.account, scope: account.scope }))
    };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An `api` step's files (spec section 5.2: each `{name, type, data}`, the
 * runner having read it from interop/files/), attached as the User attaches
 * a photo on the page: kept in the agent's own storage, and named to the API
 * tool by attachment id.
 */
function uploads(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const files: Record<string, string> = {};
  for (const [field, file] of Object.entries(value)) {
    if (!isRecord(file) || typeof file.data !== "string") throw new StepError(400, "invalid_params", `files.${field} must be {name, type, data}`);
    try {
      files[field] = saveAttachment(agent.client.sql, {
        name: typeof file.name === "string" ? file.name : null,
        bytes: new Uint8Array(Buffer.from(file.data, "base64"))
      }).id;
    } catch (error) {
      if (error instanceof AttachmentError) throw new StepError(400, "invalid_params", `files.${field}: ${error.message}`);
      throw error;
    }
  }
  return Object.keys(files).length ? files : undefined;
}

/**
 * An OpenAPI call's outcome as section 5.2 has it: a Poppy error from the
 * Company (`{"error": code}` with a 4xx or 5xx) is a refusal; any other
 * answer, an HTTP error included, is `{status, body}` with its real status.
 */
function apiResult(result: Json): unknown {
  if (isRecord(result) && typeof result.status === "number" && result.status >= 400) {
    const body = result.body;
    if (isRecord(body) && typeof body.error === "string") {
      throw new PoppyStepError(body.error, result.status, typeof body.error_description === "string" ? body.error_description : `HTTP ${result.status}`);
    }
  }
  return result;
}

/** The User's decision on a held write, through the same path the approval card takes. */
async function decideHeld(id: string, decision: "approve" | "decline") {
  await decideLocal(agent.client, id, decision);
  const row = rows(agent.client.sql, approvalsTable.pick("status", "result"), "SELECT status, result FROM poppy_approvals WHERE id = ?", id)[0];
  if (!row) throw new StepError(404, "unknown_operation", `The agent has no held write ${id}`);
  if (row.status === "failed") {
    const code = /\[([a-z_0-9]+)\]$/.exec(row.result ?? "")?.[1] ?? "approved_write_failed";
    throw new PoppyStepError(code, 0, row.result ?? "");
  }
  // No answer came: what the Company did is unknown, as a failure was before (docs/interop-spec.md 4).
  if (row.status === "unknown") throw new PoppyStepError("approved_write_failed", 0, row.result ?? "");
  // Sent, and the Company answered other than 2xx: the receipt says "answered 500 (server_error)".
  // A Poppy error is a refusal, as `api` gives it; an answer with no code is the response.
  if (row.status === "refused") {
    const answered = /answered (\d{3})(?: \(([^)]+)\))?/.exec(row.result ?? "");
    const status = Number(answered?.[1] ?? 0);
    if (answered?.[2]) throw new PoppyStepError(answered[2], status, row.result ?? "");
    return { status: "done", result: { status, body: null } };
  }
  if (row.status !== "done") return { status: row.status };
  let outcome: Json = null;
  try {
    outcome = JSON.parse(row.result ?? "null") as Json;
  } catch {
    // The executor's summary was cut short; keep the text.
    outcome = row.result;
  }
  return { status: "done", result: apiResult(outcome) as Json };
}

async function step(request: Request): Promise<Response> {
  const input = await body(request);
  const op = typeof input.op === "string" ? input.op : "";
  const run = STEPS[op];
  if (!run) return failure(501, "unsupported", `No op ${op}`);
  const domain = typeof input.company === "string" ? input.company : "";
  const params = typeof input.params === "object" && input.params !== null ? (input.params as Params) : {};
  try {
    return json({ ok: true, result: await run(domain, params) });
  } catch (error) {
    if (error instanceof AttackSetupError) return failure(500, "attack_setup_failed", error.message);
    if (error instanceof StepError) return failure(error.status, error.code, error.message);
    if (error instanceof PoppyStepError) return json({ ok: false, poppy_error: error.code, status: error.status, detail: error.message });
    if (error instanceof PoppyError) {
      return json({ ok: false, poppy_error: error.code, status: error.status, detail: error.message, ...(error.detail.extension ? { extension: error.detail.extension } : {}) });
    }
    if (error instanceof DiscoveryError) return json({ ok: false, poppy_error: "discovery_failed", status: 0, detail: error.message });
    console.error(`step ${op} failed`, error);
    return failure(500, "step_failed", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

async function control(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
  if (request.method === "GET" && url.pathname === "/manifest") return json(MANIFEST);
  if (!authorized(request, SECRET)) return failure(401, "unauthorized", "Control calls need Authorization: Bearer $INTEROP_SECRET");
  if (request.method === "POST" && url.pathname === "/reset") {
    agent = await newAgent();
    pending.clear();
    armed = null;
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/step") return step(request);
  if (request.method === "GET" && url.pathname === "/log") return json({ notes: agent.notes });
  return failure(404, "not_found", `${request.method} ${url.pathname}`);
}

/** Our identity documents, and Direct Sign-In's callback for a Company that redirects a browser to it. */
async function site(request: Request): Promise<Response> {
  const identity = await handleIdentityRoute(request, agent.env);
  if (identity) return identity;
  const url = new URL(request.url);
  if (url.pathname === "/poppy/callback" && request.method === "GET") {
    const outcome = await completeDirectSignIn(agent.client, url);
    return new Response(outcome.message, { status: outcome.ok ? 200 : 400, headers: { "content-type": "text/plain" } });
  }
  return new Response("Not found", { status: 404 });
}

serve(8080, site);
serve(8081, control);
console.log(`pda-agent: ${LIVE ? `live identity ${LIVE.clientId}` : ORIGIN} on 8080, control on 8081${FAULT ? `, fault ${FAULT}` : ""}`);
