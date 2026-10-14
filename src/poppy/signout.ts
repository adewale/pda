import { literal, reportError } from "../log";
import { PoppyError, type AccountRow, type PoppyClient } from "./client";
import type { Company } from "./discovery";
import { companyErrorCode } from "./error-codes";
import type { Issuer } from "./issuer";
import { isObject } from "./json";
import { randomId } from "./jwt";
import { newestRows, one, rows, type RowOf } from "../rows";
import { signOutsTable } from "./store";

/**
 * Signing out of an account (spec 4.9). The agent stops using the account at
 * once: that is what the User asked for. Its Account Token moves, still
 * sealed, from `poppy_accounts` to `poppy_signouts`, and is revoked from
 * there. A Company that refuses the revocation keeps the token live, so the
 * row keeps it and the agent tries again, a bounded number of times; the
 * User sees that the access is still live there, and can try again
 * themselves from the Companies page.
 *
 *   signOut ─▶ pending ─▶ revoked                (accepted, or already unknown there)
 *                │  ▲
 *                ▼  │ retry, Try again
 *              pending … ─▶ stopped ─▶ revoked   (Try again)
 *                                    └▶ expired  (the token ran out first)
 *
 * A step-up (4.4) replaces an account's Account Token with one for more
 * scopes, and the old token is revoked the same way, from a `step_up` row.
 * The account stays signed in with the new token, so no Session is left.
 * The User didn't ask for this revocation, so they hear of it only when the
 * Company doesn't accept it.
 */

/** After a refused revocation, try again after these waits; after the last, stop. */
export const SIGN_OUT_RETRY_MS: readonly number[] = [60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

/** Finished sign-outs kept for Activity; older ones are deleted. */
const FINISHED_KEPT = 50;

const signOutRow = signOutsTable.pick("id", "issuer", "account", "reason", "token", "scope", "expires_at", "status", "attempts", "last_error", "next_at", "created_at", "updated_at");
export type SignOutRow = RowOf<typeof signOutRow>;

/** How a sign-out went: the Company accepted it, the token had expired, or the Company didn't accept it (yet). */
export type SignOutOutcome = "revoked" | "expired" | "not_accepted";

function signOutById(client: PoppyClient, id: string): SignOutRow | undefined {
  return one(client.sql, signOutRow, "SELECT * FROM poppy_signouts WHERE id = ?", id);
}

/** A sign-out without its token, which never leaves this module: for the page, Activity and the model. */
const recordRow = signOutsTable.pick("id", "issuer", "account", "reason", "scope", "expires_at", "status", "attempts", "last_error", "next_at", "created_at", "updated_at");
export type SignOutRecord = RowOf<typeof recordRow>;
const RECORD_COLUMNS = "id, issuer, account, reason, scope, expires_at, status, attempts, last_error, next_at, created_at, updated_at";

/** Revocations the Company hasn't accepted, sign-outs and step-ups alike: still trying, or stopped. Oldest first. */
export function pendingSignOuts(client: PoppyClient, issuer?: Issuer): SignOutRecord[] {
  return issuer
    ? rows(client.sql, recordRow, `SELECT ${RECORD_COLUMNS} FROM poppy_signouts WHERE token IS NOT NULL AND issuer = ? ORDER BY created_at`, issuer)
    : rows(client.sql, recordRow, `SELECT ${RECORD_COLUMNS} FROM poppy_signouts WHERE token IS NOT NULL ORDER BY created_at`);
}

/** A revocation the Company hasn't accepted, for the model (`poppy_status`): so it can tell the User their access there is still live. */
export function signOutForModel(row: SignOutRecord) {
  const what =
    row.reason === "step_up"
      ? "When the User gave the agent more access to this account, the new access replaced the old, but the company didn't accept revoking the old access, so it is still live there. The account stays signed in with the new access; the agent no longer uses the old."
      : "The agent no longer uses this account, but the company didn't accept revoking its access, so that access is still live there.";
  return {
    account: row.account,
    reason: row.reason,
    error: row.last_error,
    attempts: row.attempts,
    accessLiveUntil: row.expires_at,
    nextTry: row.next_at,
    state:
      row.next_at === null
        ? `${what} The agent has stopped trying: the User can press Try again on the Companies page, or revoke the access at the company.`
        : `${what} The agent will try again by itself.`
  };
}

/** The newest `limit` sign-outs kept (and any at the same time as the last), newest first: for Activity. */
export function signOutRecords(client: PoppyClient, limit: number): SignOutRecord[] {
  return rows(client.sql, recordRow, ...newestRows("poppy_signouts", RECORD_COLUMNS, "created_at", limit));
}

/** Keep an account's Account Token, still sealed, to revoke. */
function keep(client: PoppyClient, row: AccountRow, reason: SignOutRow["reason"]): string {
  const id = randomId("so_");
  const now = Date.now();
  client.sql.exec(
    `INSERT INTO poppy_signouts (id, issuer, account, reason, token, scope, expires_at, status, attempts, last_error, next_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
    id,
    row.issuer,
    row.account,
    reason,
    row.token,
    row.scope,
    row.expires_at,
    now,
    now
  );
  return id;
}

/**
 * Stop using the account now: move its sealed Account Token to
 * `poppy_signouts` and delete the account, so Sessions signed in to it
 * continue signed out. Null when the agent holds no such account.
 */
function stopUsing(client: PoppyClient, issuer: Issuer, account: string): string | null {
  // Read without `account()`, which deletes an expired token unseen: an expired one is recorded too.
  const row = client.accounts(issuer).find((item) => item.account === account);
  if (!row) return null;
  const id = keep(client, row, "sign_out");
  client.deleteAccount(issuer, account);
  return id;
}

/** The token's done with: keep the record, drop the token, and keep only the newest finished records. */
function finish(client: PoppyClient, id: string, status: "revoked" | "expired", attempts: number): void {
  client.sql.exec(
    "UPDATE poppy_signouts SET token = NULL, status = ?, attempts = ?, next_at = NULL, updated_at = ? WHERE id = ?",
    status,
    attempts,
    Date.now(),
    id
  );
  client.sql.exec(
    `DELETE FROM poppy_signouts WHERE token IS NULL AND id NOT IN
       (SELECT id FROM poppy_signouts WHERE token IS NULL ORDER BY updated_at DESC LIMIT ?)`,
    FINISHED_KEPT
  );
}

/** Why a revocation wasn't accepted: the Company's code, or ours when no answer came. */
type Refusal = { readonly code: string; readonly retryAfterMs?: number; readonly final?: boolean };

/** Send the revocation (RFC 7009) once. Null when it's done: accepted, or the token is already unknown there. */
async function revoke(client: PoppyClient, company: Company, row: SignOutRow & { token: string }): Promise<Refusal | null> {
  let token: string;
  try {
    token = await client.sealer.open(row.token, client.accountContext(row.issuer, row.account));
  } catch (error) {
    // Sealed under a key this deployment no longer has: it can never be sent.
    reportError(error, { source: literal("poppy.signout"), severe: false });
    return { code: "unreadable", final: true };
  }
  try {
    const { status, body } = await client.oauthRequest(
      company,
      company.endpoints.revocation,
      async () => ({ token, token_type_hint: "refresh_token" }),
      { dpop: false }
    );
    if (status >= 200 && status < 300) return null;
    const code = isObject(body) && body.error !== undefined ? companyErrorCode(body.error, status) : `http_${status}`;
    // RFC 7009 2.2: a token the Company doesn't know, or no longer honours, needs no revoking.
    if (code === "invalid_token" || code === "invalid_grant") return null;
    return { code };
  } catch (error) {
    if (error instanceof PoppyError) {
      return { code: error.code, ...(error.is("rate_limited") && error.detail.retryAfter ? { retryAfterMs: error.detail.retryAfter * 1000 } : {}) };
    }
    reportError(error, { source: literal("poppy.signout"), severe: false });
    return { code: "no_answer" };
  }
}

/**
 * One try at revoking a sign-out's token, run under `client.exclusive` for
 * its Company. Returns how it went, and when to try again (null: not again
 * by itself), or null when there was nothing to do: no such sign-out, it's
 * finished, or another try is under way.
 */
async function attempt(client: PoppyClient, id: string): Promise<{ outcome: SignOutOutcome; next: number | null } | null> {
  const key = `signout|${id}`;
  if (client.inFlight.has(key)) return null;
  client.inFlight.add(key);
  try {
    const row = signOutById(client, id);
    if (!row || row.token === null) return null;
    const company = client.companyByIssuer(row.issuer);
    // Expired by itself: the Company no longer honours it, so there's nothing to send.
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      if (row.attempts === 0) leaveSessions(client, row);
      finish(client, id, "expired", row.attempts);
      await doneNotice(client, company, row, "expired");
      return { outcome: "expired", next: null };
    }
    const attempts = row.attempts + 1;
    const refusal = await revoke(client, company, { ...row, token: row.token });
    if (!refusal) {
      finish(client, id, "revoked", attempts);
      await doneNotice(client, company, row, "revoked");
      return { outcome: "revoked", next: null };
    }
    if (row.attempts === 0) leaveSessions(client, row);
    const wait = refusal.final ? undefined : SIGN_OUT_RETRY_MS[attempts - 1];
    // A rate limit's Retry-After is waited out in full.
    const next = wait === undefined ? null : client.host.now() + Math.max(wait, refusal.retryAfterMs ?? 0);
    client.sql.exec(
      "UPDATE poppy_signouts SET status = ?, attempts = ?, last_error = ?, next_at = ?, updated_at = ? WHERE id = ?",
      next === null ? "stopped" : "pending",
      attempts,
      refusal.code,
      next,
      Date.now(),
      id
    );
    await notAcceptedNotice(client, company, { ...row, attempts, last_error: refusal.code, next_at: next });
    return { outcome: "not_accepted", next };
  } finally {
    client.inFlight.delete(key);
  }
}

/**
 * The Company hasn't signed out the Sessions signed in with this token: it
 * didn't accept the revocation, or the token expired with no revocation
 * sent. Those Sessions may still be signed in there, and a signed-in Session
 * renews only with its Account Token (4.2), which the agent no longer uses,
 * never with the assertion (spec-issues S5). So they are left, and the next
 * request starts a new, signed-out Session. Only on the first try: by a
 * retry, a Session signed in to that account may be a new sign-in's. Never
 * after a step-up: the account is still signed in, with the new token.
 */
function leaveSessions(client: PoppyClient, row: Pick<SignOutRow, "issuer" | "account" | "reason">): void {
  if (row.reason === "step_up") return;
  for (const session of client.sessions(row.issuer)) {
    if (session.signed_in && session.account === row.account) client.abandonSession(row.issuer, session.label);
  }
}

/** The `poppy-revoke` job's id for a sign-out. */
const jobId = (id: string) => `signout-${id}`;

/** Try each now, under `client.exclusive` for their Company, and schedule the next try for each the Company refused. */
async function tryNow(client: PoppyClient, ids: readonly string[]): Promise<SignOutOutcome | null> {
  let outcome: SignOutOutcome | null = null;
  for (const id of ids) {
    const tried = await attempt(client, id);
    if (!tried) continue;
    outcome = tried.outcome;
    const issuer = signOutById(client, id)?.issuer;
    if (tried.next !== null && issuer) await client.host.schedule("poppy-revoke", tried.next, { id, issuer }, jobId(id));
  }
  return outcome;
}

/**
 * Sign out of one account (spec 4.9), from the User's "Sign out" on the
 * Companies page. With no such account, it tries again each revocation of
 * that account's the Company hasn't accepted. Returns how the last one went;
 * null when there was nothing to sign out. No renewal for the Company runs
 * beside it (`client.exclusive`), so none uses the account, or renews its
 * Sessions, mid-way.
 */
export function signOut(client: PoppyClient, issuer: Issuer, account: string): Promise<SignOutOutcome | null> {
  return client.exclusive(issuer, () => signOutNow(client, issuer, account));
}

async function signOutNow(client: PoppyClient, issuer: Issuer, account: string): Promise<SignOutOutcome | null> {
  const moved = stopUsing(client, issuer, account);
  const ids = moved ? [moved] : pendingSignOuts(client, issuer).filter((row) => row.account === account).map((row) => row.id);
  if (ids.length === 0) {
    const company = client.companyByIssuer(issuer);
    await client.host.showCard({
      id: `signout-${issuer}-${account}`,
      kind: "notice",
      company: company.name,
      domain: company.domain,
      open: false,
      text: `Signed out of ${company.name}. Open tasks there continue signed out.`
    });
    return null;
  }
  return tryNow(client, ids);
}

/**
 * "Try again" on the Companies page: one revocation the Company hasn't
 * accepted, a sign-out or a step-up's, tried again now. It never touches an
 * account the agent is signed in to. Null when there was nothing to try.
 */
export async function retryRevocation(client: PoppyClient, id: string): Promise<SignOutOutcome | null> {
  const row = signOutById(client, id);
  if (!row || row.token === null) return null;
  return client.exclusive(row.issuer, () => tryNow(client, [id]));
}

/**
 * After a step-up (4.4): keep the Account Token the new one replaced, to
 * revoke. Called as soon as the new token is stored, with nothing awaited
 * between, so the old one is never held nowhere. Null when nothing was
 * replaced.
 */
export function keepReplaced(client: PoppyClient, replaced: AccountRow | null): string | null {
  return replaced ? keep(client, replaced, "step_up") : null;
}

/**
 * Revoke a token `keepReplaced` kept, now. The sign-in has finished either
 * way, so this never throws: a try that fails part-way is picked up again on
 * the next start (`recoverSignOuts`).
 */
export async function revokeReplaced(client: PoppyClient, id: string | null): Promise<void> {
  if (id === null) return;
  await retryRevocation(client, id).catch((error: unknown) => reportError(error, { source: literal("poppy.signout"), severe: false }));
}

/**
 * On start: every revocation still pending (a token held, the agent still
 * trying) has its `poppy-revoke` job. One whose job is missing, because the
 * object stopped before its first try, or before or while scheduling the
 * next, gets it back: at its next try, or now when that is due or none was
 * set. A stopped one has none, by design.
 */
export async function recoverSignOuts(client: PoppyClient): Promise<void> {
  for (const row of pendingSignOuts(client)) {
    if (row.status !== "pending" || client.host.hasJob(jobId(row.id))) continue;
    const at = Math.max(row.next_at ?? 0, client.host.now());
    await client.host.schedule("poppy-revoke", at, { id: row.id, issuer: row.issuer }, jobId(row.id));
  }
}

/** The `poppy-revoke` job: try a sign-out again. Returns when to try next, or null when done or stopped. */
export async function retrySignOut(client: PoppyClient, id: string): Promise<number | null> {
  const row = signOutById(client, id);
  if (!row || row.token === null) return null;
  return (await client.exclusive(row.issuer, () => attempt(client, id)))?.next ?? null;
}

// ---------------------------------------------------------------- The User's notices

function yourAccount(company: Company, account: string): string {
  return account === "default" ? `your account at ${company.name}` : `your account “${account}” at ${company.name}`;
}

/** A date and time in the User's time zone when their page has said which, else UTC. */
function dateText(client: PoppyClient, at: number): string {
  const { locale, time_zone: timeZone } = client.host.userContext();
  try {
    const text = new Intl.DateTimeFormat(locale ?? "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: timeZone ?? "UTC" }).format(at);
    return timeZone ? text : `${text} UTC`;
  } catch {
    return new Date(at).toISOString();
  }
}

/** "in 1 minute", "in 10 minutes", "in 6 hours". */
function inTime(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * The revocation is done. A sign-out says so. A step-up's says nothing the
 * first time, since the User didn't ask for it; after a refusal it closes the
 * notice that said the old access was still live.
 */
async function doneNotice(client: PoppyClient, company: Company, row: SignOutRow, how: "revoked" | "expired"): Promise<void> {
  if (row.reason === "step_up" && row.attempts === 0) return;
  const text =
    row.reason === "step_up"
      ? how === "revoked"
        ? `${company.name} has now revoked the access your agent had to ${yourAccount(company, row.account)} before you gave it more. Your agent uses only the new access.`
        : `The access your agent had to ${yourAccount(company, row.account)} before you gave it more has ended there, so there is nothing left to revoke.`
      : how === "revoked"
        ? `Signed out of ${company.name}. Open tasks there continue signed out.`
        : `Signed out of ${company.name}. The access it granted had already ended, so there was nothing to revoke. Open tasks there continue signed out.`;
  await client.host.showCard({ id: `signout-${row.id}`, kind: "notice", company: company.name, domain: company.domain, open: false, text });
}

/** Said plainly: what the agent no longer uses, that the Company's access is still live, and what happens next. */
export function notAcceptedText(
  client: PoppyClient,
  company: Company,
  row: Pick<SignOutRow, "account" | "reason" | "attempts" | "last_error" | "next_at" | "expires_at">
): string {
  const code = row.last_error ?? "no_answer";
  const next =
    row.next_at === null
      ? `Your agent tried ${row.attempts} ${row.attempts === 1 ? "time" : "times"} and has stopped trying. To try again, open Companies, then ${company.name}, and press Try again.`
      : `Your agent will try again ${inTime(row.next_at - client.host.now())}.`;
  if (row.reason === "step_up") {
    const live =
      row.expires_at === null
        ? `until you revoke it at ${company.name}`
        : `until ${dateText(client, row.expires_at)}, unless you revoke it at ${company.name}`;
    return `After you gave your agent more access to ${yourAccount(company, row.account)}, ${company.name} didn't accept its request to revoke the access it had before (${code}). Your agent uses only the new access, but the old access stays live there ${live}. ${next}`;
  }
  const live =
    row.expires_at === null
      ? `The access ${company.name} granted stays live there until you revoke it at ${company.name}.`
      : `The access ${company.name} granted stays live there until ${dateText(client, row.expires_at)}, unless you revoke it at ${company.name}.`;
  return `Your agent no longer uses ${yourAccount(company, row.account)}, but ${company.name} didn't accept its request to revoke that access (${code}). ${live} ${next}`;
}

async function notAcceptedNotice(
  client: PoppyClient,
  company: Company,
  row: SignOutRow
): Promise<void> {
  await client.host.showCard({
    id: `signout-${row.id}`,
    kind: "notice",
    company: company.name,
    domain: company.domain,
    open: true,
    text: notAcceptedText(client, company, row)
  });
}
