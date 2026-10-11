import { covers, PoppyClient, PoppyError, scopeSet } from "./client";
import type { Company, SignInType } from "./discovery";
import { isObject, type Json } from "./json";
import { randomId, sha256 } from "./jwt";
import { one } from "./store";
import type { ScopeInfo } from "./wire";

/** Pending sign-ins expire after this long (Guides: keep device flows short). */
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
      open: true,
      signInId: id,
      fields: company.signIn.mediated!.fields,
      scopes: info,
      reason: request.reason
    });
  }
  return { status: "waiting", type, signInId: id };
}

async function finish(
  client: PoppyClient,
  row: SignInRow,
  outcome: { ok: true; response: Json } | { ok: false; message: string }
): Promise<void> {
  const company = client.companyByIssuer(row.issuer);
  setStatus(client, row.id, outcome.ok ? "done" : "failed");
  let text: string;
  if (outcome.ok) {
    const response = outcome.response as Parameters<PoppyClient["completeSignIn"]>[3];
    await client.completeSignIn(company, row.label, row.account, response);
    const granted = scopeSet(response.scope);
    const missing = row.scopes.split(" ").filter((scope) => !granted.has(scope));
    text = missing.length
      ? `Signed in to ${company.name}, but the User approved fewer scopes than requested: granted "${response.scope ?? ""}", not granted "${missing.join(" ")}".`
      : `Signed in to ${company.name} with "${response.scope ?? ""}".`;
  } else {
    text = `Sign-in to ${company.name} didn't complete: ${outcome.message}`;
  }
  await client.host.showCard({ id: `signin-${row.id}`, kind: "notice", company: company.name, open: false, text });
  await client.host.notifyModel(`[system] ${text}`, `poppy-signin-${row.id}`);
}

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
    await finish(client, row, { ok: false, message: "the sign-in link expired" });
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
  try {
    const response = await client.tokenRequest(company, async () => {
      const session = client.session(company.issuer, row.label);
      return {
        grant_type: "authorization_code",
        code,
        redirect_uri: client.identity.redirectUri,
        code_verifier: secret.verifier,
        ...(session ? { session_id: session.session_id } : {})
      };
    });
    await finish(client, row, { ok: true, response: response as unknown as Json });
    return { ok: true, message: `Connected to ${company.name}. You can close this tab.` };
  } catch (error) {
    if (!(error instanceof PoppyError)) throw error;
    await finish(client, row, { ok: false, message: error.code });
    return { ok: false, message: `Sign-in to ${company.name} failed (${error.code}).` };
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
    await finish(client, row, { ok: false, message: "the code expired before the User approved" });
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
    const message =
      error.code === "access_denied"
        ? "the User declined"
        : error.code === "expired_token"
          ? "the code expired"
          : `the company returned ${error.code}`;
    await finish(client, row, { ok: false, message });
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
        open: true,
        signInId: row.id,
        sentTo,
        ...(typeof body.expires_at === "string" ? { expiresAt: body.expires_at } : {})
      });
      return "code";
    }
    case "expired":
      await finish(client, row, { ok: false, message: "the sign-in took too long" });
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
      { method: "POST", url: mediated.endpoint, body: { scope: row.scopes, credentials } },
      { label: row.label }
    );
    return mediatedResponse(client, row, body);
  } catch (error) {
    if (!(error instanceof PoppyError)) throw error;
    await finish(client, row, { ok: false, message: error.code });
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
      {
        method: "POST",
        url: `${company.signIn.mediated!.endpoint}/${encodeURIComponent(sign_in_id)}`,
        body: { code }
      },
      { label: row.label }
    );
    return mediatedResponse(client, row, body);
  } catch (error) {
    if (!(error instanceof PoppyError)) throw error;
    await finish(client, row, { ok: false, message: error.code });
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
    open: false,
    text: `Signed out of ${company.name}. Open tasks there continue signed out.`
  });
}
