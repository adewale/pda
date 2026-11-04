/**
 * Operator signatures (spec 5.3; Guides, "Operator signatures and bot
 * defenses"): an RFC 9421 HTTP Message Signature on every request that
 * carries the Session header, in the Web Bot Auth profile
 * (draft-ietf-webbotauth-httpsig-protocol-00), so a Company's existing bot
 * defenses can recognize our operator before its application sees the
 * request. It is compatibility support, never authentication: the Company
 * still verifies the Session JWT itself, and its absence makes nothing
 * invalid. A SHOULD, so it is sent only when the deployment configures an
 * operator key (`POPPY_OPERATOR_KEY`).
 *
 * The operator key is an Ed25519 key of its own, separate from the keys in
 * `jwks_uri` and from the delegated Session keys (Guides). It is published,
 * with its JWK thumbprint as `kid`, at our origin's
 * `/.well-known/http-message-signatures-directory`, which `Signature-Agent`
 * names. The signature covers `@method`, `@authority`, `@path`, the
 * `Signature-Agent` member, `poppy-session`, and `authorization` when
 * present, as 5.3 requires. It doesn't cover the body (no Content-Digest),
 * which the draft leaves to the agent.
 */
import { calculateJwkThumbprint, exportJWK, importJWK, type JWK } from "jose";

import { ConfigError } from "../config";

export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const DIRECTORY_TYPE = "application/http-message-signatures-directory+json";
/** How long a request's signature verifies: long enough for a slow request, short enough to bound reuse (draft 5.2). */
const SIGNATURE_SECONDS = 300;
/** How long the directory's own possession proofs last (draft Appendix B.1), matching its cache lifetime. */
const DIRECTORY_SECONDS = 24 * 60 * 60;
const LABEL = "sig1";

export type OperatorKey = { readonly privateKey: CryptoKey; readonly publicJwk: JWK; readonly keyid: string };

type OperatorEnv = { readonly POPPY_OPERATOR_KEY?: string };

let cached: { source: string; key: Promise<OperatorKey> } | undefined;

/** The deployment's operator key, or null when none is configured (then no operator signatures are sent). */
export function operatorKey(env: OperatorEnv): Promise<OperatorKey> | null {
  const source = env.POPPY_OPERATOR_KEY?.trim();
  if (!source) return null;
  if (cached?.source !== source) cached = { source, key: importOperatorKey(source) };
  return cached.key;
}

async function importOperatorKey(source: string): Promise<OperatorKey> {
  let jwk: JWK;
  try {
    jwk = JSON.parse(source) as JWK;
  } catch {
    throw new ConfigError("POPPY_OPERATOR_KEY must be a private Ed25519 JWK");
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string") {
    throw new ConfigError("POPPY_OPERATOR_KEY must be a private Ed25519 JWK");
  }
  const privateKey = (await importJWK({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, "EdDSA")) as CryptoKey;
  const keyid = await calculateJwkThumbprint({ kty: "OKP", crv: "Ed25519", x: jwk.x }, "sha256");
  return { privateKey, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: keyid, use: "sig" }, keyid };
}

/** A new operator key as a private JWK, for `wrangler secret put POPPY_OPERATOR_KEY` (scripts/poppy-secrets.mjs). */
export async function newOperatorJwk(): Promise<JWK> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const { kty, crv, x, d } = await exportJWK(pair.privateKey);
  return { kty, crv, x, d };
}

/** RFC 8941 sf-string. */
const sfString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** RFC 9421 2.5's signature base, and the inner list that becomes `@signature-params`. */
function signatureBase(components: readonly (readonly [string, string])[], params: string): string {
  const list = `(${components.map(([id]) => id).join(" ")})${params}`;
  return [...components.map(([id, value]) => `${id}: ${value}`), `"@signature-params": ${list}`].join("\n");
}

async function sign(key: OperatorKey, base: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(base))));
}

/**
 * Sign a request that already carries its Session header, and its token and
 * DPoP proof when signed in (Guides: build those first). `agentOrigin` is our
 * origin, whose directory holds the key.
 */
export async function signRequest(key: OperatorKey, agentOrigin: string, request: { readonly method: string; readonly url: string; readonly headers: Headers }, now = Date.now()): Promise<void> {
  const url = new URL(request.url);
  const session = request.headers.get("Poppy-Session");
  if (!session) return;
  const agent = sfString(agentOrigin);
  request.headers.set("Signature-Agent", `${LABEL}=${agent}`);
  const authorization = request.headers.get("Authorization");
  const components: [string, string][] = [
    ['"@method"', request.method.toUpperCase()],
    ['"@authority"', url.host.toLowerCase()],
    ['"@path"', url.pathname || "/"],
    [`"signature-agent";key="${LABEL}"`, agent],
    ['"poppy-session"', session],
    ...(authorization ? [['"authorization"', authorization] as [string, string]] : [])
  ];
  const created = Math.floor(now / 1000);
  const params = `;created=${created};expires=${created + SIGNATURE_SECONDS};keyid=${sfString(key.keyid)};alg="ed25519";tag="web-bot-auth"`;
  const base = signatureBase(components, params);
  request.headers.set("Signature-Input", `${LABEL}=(${components.map(([id]) => id).join(" ")})${params}`);
  request.headers.set("Signature", `${LABEL}=:${await sign(key, base)}:`);
}

/**
 * Our key directory (draft 5.5.1), with one possession proof per key (draft
 * Appendix B.1): a response signature over the request's `@authority` and
 * the body's `content-digest`, tagged http-message-signatures-directory.
 */
export async function directoryResponse(key: OperatorKey | null, requestUrl: string, now = Date.now()): Promise<Response> {
  const body = JSON.stringify({ keys: key ? [key.publicJwk] : [] });
  const headers = new Headers({ "Content-Type": DIRECTORY_TYPE, "Cache-Control": "public, max-age=86400" });
  if (key) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
    const contentDigest = `sha-256=:${base64(digest)}:`;
    headers.set("Content-Digest", contentDigest);
    const created = Math.floor(now / 1000);
    const components: [string, string][] = [
      ['"@authority";req', new URL(requestUrl).host.toLowerCase()],
      ['"content-digest"', contentDigest]
    ];
    const params = `;created=${created};expires=${created + DIRECTORY_SECONDS};keyid=${sfString(key.keyid)};alg="ed25519";tag="http-message-signatures-directory"`;
    headers.set("Signature-Input", `${LABEL}=(${components.map(([id]) => id).join(" ")})${params}`);
    headers.set("Signature", `${LABEL}=:${await sign(key, signatureBase(components, params))}:`);
  }
  return new Response(body, { headers });
}

/**
 * Parse and verify a Web Bot Auth request signature against a key directory
 * (the mock Company's check, and our tests'). Returns what it covered, or a
 * reason it fails.
 */
export async function verifyRequest(
  request: { readonly method: string; readonly url: string; readonly headers: Headers },
  directory: { readonly keys: readonly JWK[] },
  now = Date.now()
): Promise<{ ok: true; components: string[]; agent: string } | { ok: false; reason: string }> {
  const input = request.headers.get("Signature-Input") ?? "";
  const signature = request.headers.get("Signature") ?? "";
  const agentHeader = request.headers.get("Signature-Agent") ?? "";
  const inputMatch = new RegExp(`^${LABEL}=\\(([^)]*)\\)(.*)$`).exec(input);
  const signatureMatch = new RegExp(`^${LABEL}=:([A-Za-z0-9+/=]+):$`).exec(signature);
  const agentMatch = new RegExp(`^${LABEL}=("(?:[^"\\\\]|\\\\.)*")$`).exec(agentHeader);
  if (!inputMatch || !signatureMatch || !agentMatch) return { ok: false, reason: "missing or malformed Signature, Signature-Input or Signature-Agent" };
  const ids = inputMatch[1]!.split(" ").filter(Boolean);
  const params = inputMatch[2]!;
  const param = (name: string) => new RegExp(`;${name}=("[^"]*"|\\d+)`).exec(params)?.[1]?.replace(/^"|"$/g, "");
  if (param("tag") !== "web-bot-auth") return { ok: false, reason: "tag isn't web-bot-auth" };
  const created = Number(param("created")), expires = Number(param("expires"));
  const seconds = Math.floor(now / 1000);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created > seconds + 60 || expires < seconds) return { ok: false, reason: "outside its created and expires" };
  const jwk = directory.keys.find((entry) => entry.kid === param("keyid"));
  if (!jwk) return { ok: false, reason: "keyid isn't in the directory" };
  const url = new URL(request.url);
  const value = (id: string): string | null => {
    if (id === '"@method"') return request.method.toUpperCase();
    if (id === '"@authority"') return url.host.toLowerCase();
    if (id === '"@path"') return url.pathname || "/";
    if (id === `"signature-agent";key="${LABEL}"`) return agentMatch[1]!;
    const header = /^"([a-z0-9-]+)"$/.exec(id)?.[1];
    return header ? request.headers.get(header) : null;
  };
  const components: [string, string][] = [];
  for (const id of ids) {
    const found = value(id);
    if (found === null) return { ok: false, reason: `covers ${id}, which the request doesn't have` };
    components.push([id, found]);
  }
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, Uint8Array.from(atob(signatureMatch[1]!), (c) => c.charCodeAt(0)), new TextEncoder().encode(signatureBase(components, params)));
  return ok ? { ok: true, components: ids, agent: JSON.parse(agentMatch[1]!) as string } : { ok: false, reason: "the signature doesn't verify" };
}
