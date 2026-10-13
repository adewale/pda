import { reportError } from "../log";
import { covers, grantedScope, PoppyClient, PoppyError, registerSignInRecovery, scopeSet } from "./client";
import type { Company, SignInType } from "./discovery";
import { isObject, type Json } from "./json";
import { randomId, sha256 } from "./jwt";
import { EndpointRequest } from "./outgoing";
import { one, rows } from "./store";
import type { ScopeInfo } from "./wire";

/** Pending sign-ins expire after this long (the Guides suggest Companies give a device code about 10 minutes). */
const SIGN_IN_TTL_MS = 10 * 60 * 1000;

export const BUILTIN_SCOPES: Readonly<Record<string, string>> = {
  "poppy:read": "View account information, such as orders and bookings",
  "poppy:write": "Make changes, such as exchanging an item or updating a booking"
};

type SignInRow = {
  id: string;
  type: SignInType;
  issuer: string;
  label: string;
  account: string;
  scopes: string;
  secret: string;
  interval_seconds: number | null;
  expires_at: number;
  status: string;
};

export type SignInStart =
  | { readonly status: "signed_in"; readonly scope: string }
  | { readonly status: "waiting"; readonly type: SignInType; readonly signInId: string };

export function describeScopes(company: Company, scopes: readonly string[]): ScopeInfo[] {
  return scopes.map((scope) => ({
    scope,
    description: BUILTIN_SCOPES[scope] ?? company.customScopes[scope] ?? scope
  }));
}

/**
 * A device sign-in link the page may show as a link and a QR code: HTTPS, on
 * the Company's domain or the host of its issuer or device endpoint (spec
 * 4.6). Anything else, such as `javascript:`, `http:` or another site, is null.
 */
export function deviceLink(company: Company, value: unknown): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const hosts = [company.issuer, company.endpoints.deviceAuthorization]
    .filter((endpoint): endpoint is string => !!endpoint)
    .map((endpoint) => new URL(endpoint).hostname.toLowerCase());
  return host === company.domain || host.endsWith(`.${company.domain}`) || hosts.includes(host) ? url.href : null;
}

/** Which sign-in type to use: Direct, then Device, then Mediated (Guides, "Choosing how to sign in"). */
export function chooseSignInType(company: Company, scopes: readonly string[]): SignInType | null {
  const order: SignInType[] = ["direct", "device", "mediated"];
  for (const type of order) {
    const offered = company.signIn[type];
    if (offered && covers(offered.scopes.join(" "), scopes)) return type;
  }
  return null;
}

function sealContext(row: { id: string; issuer: string }): string {
  return `signin|${row.id}|${row.issuer}`;
}

function signIn(client: PoppyClient, id: string): SignInRow | undefined {
  return one<SignInRow>(client.sql, "SELECT * FROM poppy_signins WHERE id = ?", id);
}

function setStatus(client: PoppyClient, id: string, status: string): void {
  client.sql.exec("UPDATE poppy_signins SET status = ? WHERE id = ?", status, id);
}

/**
 * Start signing the User in at a Company for `scopes` (spec 4.4). An Account
 * Token that already covers them is used without asking. Otherwise the User
 * gets a card for the preferred type the Company offers; this returns while
 * they act, and the model is told when it finishes.
 */
export async function startSignIn(
  client: PoppyClient,
  company: Company,
  request: { label: string; scopes: readonly string[]; reason: string; account?: string; type?: SignInType }
): Promise<SignInStart> {
  const scopes = [...new Set(request.scopes)];
  if (scopes.length === 0) throw new PoppyError("invalid_scope", "Name at least one scope to request", 0);
  for (const scope of scopes) {
    if (!BUILTIN_SCOPES[scope] && !company.customScopes[scope]) {
      throw new PoppyError("invalid_scope", `${company.name} doesn't define the scope ${scope}`, 0);
    }
  }
  const account = request.account ?? "default";
  if (await client.signInWithAccount(company, request.label, scopes, request.account)) {
    return { status: "signed_in", scope: client.session(company.issuer, request.label)?.scope ?? "" };
  }
  const type = request.type ?? chooseSignInType(company, scopes);
  if (!type || !company.signIn[type] || !covers(company.signIn[type]!.scopes.join(" "), scopes)) {
    throw new PoppyError(
      "invalid_scope",
      `${company.name} offers no sign-in that can grant ${scopes.join(" ")}`,
      0
    );
  }
  // Direct and device exchanges sign in the current Session, so it must exist.
  await client.token(company, { label: request.label });

  const id = randomId("sgn_");
  const base = { id, issuer: company.issuer };
  const scopeText = scopes.join(" ");
  const info = describeScopes(company, scopes);
  const insert = (secret: string, stateHash: string | null, interval: number | null, expiresAt: number) =>
    client.sql.exec(
      `INSERT INTO poppy_signins (id, type, issuer, label, account, scopes, state_hash, secret, interval_seconds, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      type,
      company.issuer,
      request.label,
      account,
      scopeText,
      stateHash,
      secret,
      interval,
      expiresAt,
      Date.now()
    );

  if (type === "direct") {
    const state = randomId();
    const verifier = randomId("", 32);
    insert(
      await client.sealer.seal(JSON.stringify({ state, verifier }), sealContext(base)),
      await sha256(state),
      null,
      Date.now() + SIGN_IN_TTL_MS
    );
    const url = new URL(company.endpoints.authorization!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.identity.clientId);
    url.searchParams.set("redirect_uri", client.identity.redirectUri);
    url.searchParams.set("scope", scopeText);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await sha256(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    await client.host.showCard({
      id: `signin-${id}`,
      kind: "signin_link",
      company: company.name,
      domain: company.domain,
      open: true,
      signInId: id,
      url: url.href,
      scopes: info,
      reason: request.reason
    });
  } else if (type === "device") {
    const { status, body } = await client.oauthRequest(
      company,
      company.endpoints.deviceAuthorization!,
      async () => ({ scope: scopeText }),
      { dpop: false }
    );
    if (
      status !== 200 ||
      !isObject(body) ||
      typeof body.device_code !== "string" ||
      typeof body.user_code !== "string" ||
      typeof body.verification_uri !== "string"
    ) {
      const code = isObject(body) && typeof body.error === "string" ? body.error : "server_error";
      throw new PoppyError(code, `${company.name} refused the device sign-in (${code})`, status);
    }
    const verificationUri = deviceLink(company, body.verification_uri);
    if (!verificationUri) {
      throw new PoppyError("invalid_response", `${company.name}'s device sign-in link isn't an HTTPS page of theirs`, status);
    }
    const verificationUriComplete = deviceLink(company, body.verification_uri_complete);
    const interval = typeof body.interval === "number" && body.interval > 0 ? body.interval : 5;
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 600;
    const expiresAt = client.host.now() + expiresIn * 1000;
    // `device_code` stays private: sealed at rest, never shown (spec 4.6).
    insert(
      await client.sealer.seal(JSON.stringify({ device_code: body.device_code }), sealContext(base)),
      null,
      interval,
      expiresAt
    );
    await client.host.showCard({
      id: `signin-${id}`,
      kind: "signin_device",
      company: company.name,
      domain: company.domain,
      open: true,
      signInId: id,
      verificationUri,
      ...(verificationUriComplete ? { verificationUriComplete } : {}),
      userCode: body.user_code,
      expiresAt,
      scopes: info,
      reason: request.reason
    });
    await client.host.schedule("poppy-device", client.host.now() + interval * 1000, { id }, `device-${id}`);
  } else {
    insert(await client.sealer.seal("{}", sealContext(base)), null, null, Date.now() + SIGN_IN_TTL_MS);
    await client.host.showCard({
      id: `signin-${id}`,
      kind: "signin_credentials",
      company: company.name,
      domain: company.domain,
      open: true,
      signInId: id,
      fields: company.signIn.mediated!.fields,
      scopes: info,
      reason: request.reason
    });
  }
  return { status: "waiting", type, signInId: id };
}

type TokenResponse = Parameters<PoppyClient["completeSignIn"]>[3];

/** What a finished sign-in granted: `who` is "you" on the User's card and "the User" for the model. */
function signedInText(company: Company, row: SignInRow, scope: string, who: "you" | "the User"): string {
  const granted = scopeSet(scope);
  const missing = row.scopes.split(" ").filter((item) => !granted.has(item));
  return missing.length
    ? `Signed in to ${company.name}, but ${who} approved fewer scopes than requested: granted "${scope}", not granted "${missing.join(" ")}".`
    : `Signed in to ${company.name} with "${scope}".`;
}

/** Close the sign-in's card with how it ended, and tell the model, once; the card can word it for the User. */
async function report(client: PoppyClient, row: SignInRow, text: string, cardText = text): Promise<void> {
  const company = client.companyByIssuer(row.issuer);
  await client.host.showCard({ id: `signin-${row.id}`, kind: "notice", company: company.name, domain: company.domain, open: false, text: cardText });
  await client.host.notifyModel(`[system] ${text}`, `poppy-signin-${row.id}`);
}

/**
 * Ending a sign-in: with its tokens, or without, `expired` when it ran out
 * of time (the Company's `expired` or `expired_token`, or our own deadline),
 * so the Activity log can say so.
 */
async function finish(
  client: PoppyClient,
  row: SignInRow,
  outcome: { ok: true; response: Json } | { ok: false; message: string; expired?: boolean }
): Promise<void> {
  const company = client.companyByIssuer(row.issuer);
  setStatus(client, row.id, outcome.ok ? "done" : outcome.expired ? "expired" : "failed");
  let text: string;
  let cardText: string | undefined;
  if (outcome.ok) {
    const raw = outcome.response as TokenResponse;
    // An omitted `scope` grants what was asked for (RFC 6749 §5.1, N6).
    const response = { ...raw, scope: grantedScope(raw, row.scopes) };
    await client.completeSignIn(company, row.label, row.account, response);
    text = signedInText(company, row, response.scope, "the User");
    cardText = signedInText(company, row, response.scope, "you");
  } else {
    text = `Sign-in to ${company.name} didn't complete: ${outcome.message}`;
  }
  await report(client, row, text, cardText);
}

/** Refusals that mean the Session can't be signed in, and why, in the User's words. */
const NEW_SESSION: Readonly<Record<string, string>> = {
  // One account per Session (4.4): it is bound to another account.
  account_mismatch: "the Session belongs to another account",
  // It ended meanwhile (4.2).
  invalid_session: "the Session has ended"
};

/**
 * The Company refused the step that signs the Session in: a code exchange,
 * a device poll, or Mediated Sign-In. `account_mismatch` and
 * `invalid_session` mean that Session can never be signed in, so it is left
 * for a new one (spec 4.4) and the User's next sign-in starts there. Anything
 * else leaves the Session as it was. Nothing is retried: a code is single
 * use, and credentials are gone.
 */
async function refused(client: PoppyClient, row: SignInRow, code: string, message: string): Promise<void> {
  const reason = NEW_SESSION[code];
  if (!reason) {
    await finish(client, row, { ok: false, message });
    return;
  }
  client.abandonSession(row.issuer, row.label);
  await finish(client, row, {
    ok: false,
    message: `${reason} (${code}), so the agent continues in a new Session. Ask the User to sign in again.`
  });
}

// ---------------------------------------------------------------- Direct Sign-In's code exchange
//
// The code is single-use (4.5), so its exchange is recorded before it is
// sent, and its answer before it is used:
//
//   used ─▶ exchanging ─▶ exchanged ─▶ stored ─▶ done
//                │
//                └─▶ failed (refused, or interrupted with no answer)
//
// `exchanging` with no answer kept means the Company may have signed the
// Session in, and we hold no Account Token to renew it with. 4.2 renews a
// signed-in Session with the Account Token, and what the assertion gets
// there is undefined (spec-issues S5), so that Session is abandoned for a
// new one and the User starts the sign-in again. `exchanged` keeps the
// answer (sealed, without its Session Token), so the tokens are stored from
// it. `stored` only has the card and the notice left.

const EXCHANGE = (id: string) => `signin|${id}`;

/** The answer to a code exchange, kept until its tokens are stored: never the Session Token. */
type KeptAnswer = Omit<TokenResponse, "access_token">;

function keepable(response: TokenResponse): KeptAnswer {
  const { access_token: _sessionToken, ...kept } = response;
  return kept;
}

/** Store the tokens from a code exchange's answer, then close the card. Safe to repeat. */
async function finishExchange(client: PoppyClient, row: SignInRow, answer?: KeptAnswer): Promise<void> {
  const company = client.companyByIssuer(row.issuer);
  let scope: string;
  if (row.status === "stored") {
    scope = (JSON.parse(await client.sealer.open(row.secret, sealContext(row))) as { scope: string }).scope;
  } else {
    const kept = answer ?? (JSON.parse(await client.sealer.open(row.secret, sealContext(row))) as KeptAnswer);
    // An omitted `scope` grants what was asked for (RFC 6749 §5.1, N6).
    const response = { ...kept, access_token: "", scope: grantedScope(kept, row.scopes) } as TokenResponse;
    await client.completeSignIn(company, row.label, row.account, response);
    scope = response.scope ?? "";
    // The Account Token is in poppy_accounts now; this row keeps only the scope.
    client.sql.exec(
      "UPDATE poppy_signins SET status = 'stored', secret = ? WHERE id = ?",
      await client.sealer.seal(JSON.stringify({ scope }), sealContext(row)),
      row.id
    );
  }
  await report(client, row, signedInText(company, row, scope, "the User"), signedInText(company, row, scope, "you"));
  setStatus(client, row.id, "done");
}

/** No answer we can trust: start a new Session, and ask the User to sign in again. */
async function abandonExchange(client: PoppyClient, row: SignInRow): Promise<void> {
  const company = client.companyByIssuer(row.issuer);
  const session = client.session(row.issuer, row.label);
  // A Session we already hold signed in renews with its Account Token, never the assertion.
  if (session && !session.signed_in) client.abandonSession(row.issuer, row.label);
  setStatus(client, row.id, "failed");
  await report(
    client,
    row,
    `Sign-in to ${company.name} was interrupted before it finished, so the agent continues in a new Session. Ask the User to sign in again if the task needs it.`
  );
}

/**
 * Direct Sign-Ins left between sending the code and finishing (an
 * exception, or the object restarted): finish storing the tokens when their
 * answer was kept, otherwise start a new Session. Runs before any token for
 * the Company, on start, and on the next callback.
 */
export async function recoverSignIns(client: PoppyClient, issuer?: string): Promise<void> {
  const pending = rows<SignInRow>(
    client.sql,
    `SELECT * FROM poppy_signins WHERE status IN ('exchanging', 'exchanged', 'stored')${issuer ? " AND issuer = ?" : ""}`,
    ...(issuer ? [issuer] : [])
  );
  for (const found of pending) {
    const key = EXCHANGE(found.id);
    if (client.inFlight.has(key)) continue;
    client.inFlight.add(key);
    try {
      // Read again: another caller may have resolved it while this one waited.
      const row = signIn(client, found.id);
      if (row?.status === "exchanging") await abandonExchange(client, row);
      else if (row?.status === "exchanged" || row?.status === "stored") await finishExchange(client, row);
    } finally {
      client.inFlight.delete(key);
    }
  }
}

registerSignInRecovery(recoverSignIns);

/**
 * `GET /poppy/callback` for Direct Sign-In (spec 4.5): check `state` (single
 * use, this Company, not expired) and `iss`, then exchange the code at that
 * Company's token endpoint with the verifier and `session_id`.
 */
export async function completeDirectSignIn(client: PoppyClient, url: URL): Promise<{ ok: boolean; message: string }> {
  const state = url.searchParams.get("state");
  if (!state) return { ok: false, message: "This sign-in link is missing its state." };
  const row = one<SignInRow>(
    client.sql,
    "SELECT * FROM poppy_signins WHERE state_hash = ? AND type = 'direct'",
    await sha256(state)
  );
  if (!row || row.status !== "pending") {
    // A reload of an interrupted sign-in's callback: resolve it now.
    if (row) await recoverSignIns(client, row.issuer);
    return { ok: false, message: "This sign-in has expired or was already used. Start it again from the chat." };
  }
  // Single use, whatever happens next.
  setStatus(client, row.id, "used");
  const company = client.companyByIssuer(row.issuer);
  const secret = JSON.parse(await client.sealer.open(row.secret, sealContext(row))) as {
    state: string;
    verifier: string;
  };
  if (secret.state !== state || row.expires_at <= Date.now()) {
    await finish(client, row, { ok: false, message: "the sign-in link expired", expired: true });
    return { ok: false, message: "This sign-in has expired. Start it again from the chat." };
  }
  // The response must come from the Company we sent the User to (RFC 9207, spec 4.5).
  if (url.searchParams.get("iss") !== company.issuer) {
    await finish(client, row, { ok: false, message: "the response came from a different sign-in server" });
    return { ok: false, message: "This sign-in response didn't come from the expected company." };
  }
  const error = url.searchParams.get("error");
  if (error) {
    const message = error === "access_denied" ? "the User declined" : `the company returned ${error}`;
    await finish(client, row, { ok: false, message });
    return { ok: false, message: `Sign-in to ${company.name} didn't complete (${error}).` };
  }
  const code = url.searchParams.get("code");
  if (!code) {
    await finish(client, row, { ok: false, message: "no authorization code came back" });
    return { ok: false, message: "The company didn't send an authorization code." };
  }
  // The code is spent from here on: record that before sending it.
  const key = EXCHANGE(row.id);
  setStatus(client, row.id, "exchanging");
  client.inFlight.add(key);
  try {
    let response: TokenResponse;
    try {
      response = await client.tokenRequest(company, async () => {
        const session = client.session(company.issuer, row.label);
        return {
          grant_type: "authorization_code",
          code,
          redirect_uri: client.identity.redirectUri,
          code_verifier: secret.verifier,
          ...(session ? { session_id: session.session_id } : {})
        };
      });
    } catch (error) {
      if (error instanceof PoppyError && error.status >= 400 && error.status < 500) {
        // The Company refused the code: it didn't sign the Session in.
        await refused(client, row, error.code, error.code);
        return {
          ok: false,
          message: `Sign-in to ${company.name} failed (${error.code}).${NEW_SESSION[error.code] ? " Go back to the chat and sign in again." : ""}`
        };
      }
      // No answer, or one we can't read: the Company may have signed the Session in.
      await abandonExchange(client, row);
      return { ok: false, message: `Sign-in to ${company.name} was interrupted. Go back to the chat and start it again.` };
    }
    // Keep the answer before using it, so an interruption from here still stores its tokens.
    const answer = keepable(response);
    client.sql.exec(
      "UPDATE poppy_signins SET status = 'exchanged', secret = ? WHERE id = ?",
      await client.sealer.seal(JSON.stringify(answer), sealContext(row)),
      row.id
    );
    try {
      await finishExchange(client, signIn(client, row.id)!, answer);
    } catch (error) {
      reportError(error, { source: "poppy.signin_finish" });
      return { ok: false, message: `Signing in to ${company.name} didn't finish here. Go back to the chat; the agent finishes it the next time it works with ${company.name}.` };
    }
    return { ok: true, message: `Connected to ${company.name}. You can close this tab.` };
  } finally {
    client.inFlight.delete(key);
  }
}

/**
 * One Device Sign-In poll (spec 4.6), run as a durable job: every `interval`
 * seconds, 5 more after `slow_down`, until the User approves, declines or the
 * code expires. Returns when to poll next, or null when done.
 */
export async function pollDeviceSignIn(client: PoppyClient, id: string): Promise<number | null> {
  const row = signIn(client, id);
  if (!row || row.status !== "pending") return null;
  if (row.expires_at <= client.host.now()) {
    await finish(client, row, { ok: false, message: "the code expired before the User approved", expired: true });
    return null;
  }
  const company = client.companyByIssuer(row.issuer);
  const secret = JSON.parse(await client.sealer.open(row.secret, sealContext(row))) as { device_code: string };
  try {
    const response = await client.tokenRequest(company, async () => {
      const session = client.session(company.issuer, row.label);
      return {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: secret.device_code,
        ...(session ? { session_id: session.session_id } : {})
      };
    });
    await finish(client, row, { ok: true, response: response as unknown as Json });
    return null;
  } catch (error) {
    if (!(error instanceof PoppyError)) throw error;
    const interval = row.interval_seconds ?? 5;
    if (error.code === "authorization_pending") return client.host.now() + interval * 1000;
    if (error.code === "slow_down") {
      client.sql.exec("UPDATE poppy_signins SET interval_seconds = ? WHERE id = ?", interval + 5, id);
      return client.host.now() + (interval + 5) * 1000;
    }
    if (error.code === "rate_limited") return client.host.now() + (error.detail.retryAfter ?? interval) * 1000;
    if (error.code === "access_denied") await finish(client, row, { ok: false, message: "the User declined" });
    else if (error.code === "expired_token") await finish(client, row, { ok: false, message: "the code expired", expired: true });
    else await refused(client, row, error.code, `the company returned ${error.code}`);
    return null;
  }
}

/** The Mediated Sign-In endpoint's reply (spec 4.7). */
async function mediatedResponse(
  client: PoppyClient,
  row: SignInRow,
  body: Json
): Promise<"done" | "code" | "failed"> {
  if (!isObject(body)) {
    await finish(client, row, { ok: false, message: "the company's reply was unreadable" });
    return "failed";
  }
  const company = client.companyByIssuer(row.issuer);
  switch (body.status) {
    case "complete":
      await finish(client, row, { ok: true, response: body });
      return "done";
    case "code_required": {
      const signInId = typeof body.sign_in_id === "string" ? body.sign_in_id : null;
      if (!signInId || !/^[A-Za-z0-9_-]{1,256}$/.test(signInId)) {
        await finish(client, row, { ok: false, message: "the company's code request was malformed" });
        return "failed";
      }
      client.sql.exec(
        "UPDATE poppy_signins SET secret = ?, status = 'code' WHERE id = ?",
        await client.sealer.seal(JSON.stringify({ sign_in_id: signInId }), sealContext(row)),
        row.id
      );
      const sentTo = isObject(body.code) && typeof body.code.sent_to === "string" ? body.code.sent_to : "you";
      await client.host.showCard({
        id: `signin-${row.id}`,
        kind: "signin_code",
        company: company.name,
        domain: company.domain,
        open: true,
        signInId: row.id,
        sentTo,
        ...(typeof body.expires_at === "string" ? { expiresAt: body.expires_at } : {})
      });
      return "code";
    }
    case "expired":
      await finish(client, row, { ok: false, message: "the sign-in took too long", expired: true });
      return "failed";
    default:
      await finish(client, row, { ok: false, message: "the company didn't accept the sign-in" });
      return "failed";
  }
}

/**
 * Mediated Sign-In (spec 4.7). `values` come straight from the credentials
 * card, never through the model, and go only to `auth.mediated.endpoint`
 * from the verified `poppy.json`. They are not stored or logged, and are
 * dropped when this returns.
 */
export async function submitCredentials(
  client: PoppyClient,
  id: string,
  values: Readonly<Record<string, string>>
): Promise<"done" | "code" | "failed"> {
  const row = signIn(client, id);
  if (!row || row.type !== "mediated" || row.status !== "pending") return "failed";
  const company = client.companyByIssuer(row.issuer);
  const mediated = company.signIn.mediated;
  if (!mediated) return "failed";
  const credentials: Record<string, string> = {};
  for (const field of mediated.fields) {
    const value = values[field.name];
    if (typeof value !== "string" || value === "") return "failed";
    credentials[field.name] = value;
  }
  setStatus(client, id, "sent");
  try {
    const { body } = await client.resourceJson(
      company,
      EndpointRequest.to(company, { method: "POST", url: mediated.endpoint, body: { scope: row.scopes, credentials } }),
      { label: row.label }
    );
    return mediatedResponse(client, row, body);
  } catch (error) {
    if (!(error instanceof PoppyError)) throw error;
    await refused(client, row, error.code, error.code);
    return "failed";
  }
}

/** The one-time code for a Mediated Sign-In: only the code, from the same Session (spec 4.7). */
export async function submitSignInCode(
  client: PoppyClient,
  id: string,
  code: string
): Promise<"done" | "code" | "failed"> {
  const row = signIn(client, id);
  if (!row || row.type !== "mediated" || row.status !== "code") return "failed";
  const company = client.companyByIssuer(row.issuer);
  const { sign_in_id } = JSON.parse(await client.sealer.open(row.secret, sealContext(row))) as {
    sign_in_id: string;
  };
  try {
    const { body } = await client.resourceJson(
      company,
      EndpointRequest.to(company, {
        method: "POST",
        url: `${company.signIn.mediated!.endpoint}/${encodeURIComponent(sign_in_id)}`,
        body: { code }
      }),
      { label: row.label }
    );
    return mediatedResponse(client, row, body);
  } catch (error) {
    if (!(error instanceof PoppyError)) throw error;
    await refused(client, row, error.code, error.code);
    return "failed";
  }
}

export async function cancelSignIn(client: PoppyClient, id: string): Promise<void> {
  const row = signIn(client, id);
  if (!row || (row.status !== "pending" && row.status !== "code")) return;
  await finish(client, row, { ok: false, message: "the User cancelled it" });
}

/** Sign out of one account: revoke its Account Token (spec 4.9). */
export async function signOut(client: PoppyClient, issuer: string, account: string): Promise<void> {
  const company = client.companyByIssuer(issuer);
  await client.revokeAccount(company, account);
  await client.host.showCard({
    id: `signout-${issuer}-${account}`,
    kind: "notice",
    company: company.name,
    domain: company.domain,
    open: false,
    text: `Signed out of ${company.name}. Open tasks there continue signed out.`
  });
}
