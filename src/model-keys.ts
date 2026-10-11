import type { AuthContext, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { isKeyProvider, type KeyProvider } from "./config";
import type { Sealer } from "./poppy/store";

/**
 * A person's own model key, in their own agent's SQLite, sealed with the
 * `Sealer` (AES-GCM under `TOKEN_ENC_KEY`) with additional data binding it to
 * this agent and provider, so a sealed key copied to another agent, or
 * relabelled as another provider, fails to open.
 *
 * The key is opened only to make a model request (through pi-ai's
 * `CredentialStore`) or to check it with the provider. It is never sent to
 * the page, logged, put in the transcript or the Activity log, or reachable
 * by a model tool: the tools see Poppy, never this table.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS model_keys (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  provider TEXT NOT NULL,
  sealed TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  invalid_at INTEGER
)`;

/** What the page may know about the key: never the key, nor any part of it. */
export type KeyInfo = {
  readonly provider: KeyProvider;
  /** `invalid` after the provider refused it (401): no model calls until it is replaced. */
  readonly status: "valid" | "invalid";
  /** Pasted in Settings: the only way a key arrives. */
  readonly source: "pasted";
  readonly addedAt: number;
};

export const PROVIDER_LABEL: Record<KeyProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI"
};

/** The additional data a key is sealed with. */
export function keyContext(provider: KeyProvider, agent: string): string {
  return `model-key:v1:${provider}:${agent}`;
}

type Row = {
  provider: KeyProvider;
  sealed: string;
  status: "valid" | "invalid";
  source: "pasted";
  added_at: number;
};

/** The one key slot of one agent. */
export class ModelKeys {
  readonly #sql: SqlStorage;
  readonly #sealer: () => Sealer;
  readonly #agent: string;

  /** `agent` is the Durable Object's id; `sealer` is created on first use, so a missing `TOKEN_ENC_KEY` breaks only keys. */
  constructor(sql: SqlStorage, sealer: () => Sealer, agent: string) {
    this.#sql = sql;
    this.#sealer = sealer;
    this.#agent = agent;
    sql.exec(SCHEMA);
  }

  #row(): Row | undefined {
    const row = this.#sql.exec("SELECT provider, sealed, status, source, added_at FROM model_keys WHERE slot = 1").toArray()[0] as
      | (Omit<Row, "provider"> & { provider: string })
      | undefined;
    if (row && !isKeyProvider(row.provider)) {
      // A key for a provider this agent no longer takes (an OpenRouter key
      // stored before that lane was removed): deleted unopened, so the agent
      // falls back to the demo or "needs a key" instead of failing every call.
      this.#sql.exec("DELETE FROM model_keys WHERE slot = 1 AND provider = ?", row.provider);
      return undefined;
    }
    return row as Row | undefined;
  }

  info(): KeyInfo | null {
    const row = this.#row();
    return row ? { provider: row.provider, status: row.status, source: row.source, addedAt: row.added_at } : null;
  }

  /** Seal and store a key, replacing any other. */
  async put(provider: KeyProvider, key: string): Promise<void> {
    const sealed = await this.#sealer().seal(key, keyContext(provider, this.#agent));
    this.#sql.exec(
      `INSERT OR REPLACE INTO model_keys (slot, provider, sealed, status, source, added_at, invalid_at)
       VALUES (1, ?, ?, 'valid', 'pasted', ?, NULL)`,
      provider,
      sealed,
      Date.now()
    );
  }

  remove(): void {
    this.#sql.exec("DELETE FROM model_keys");
  }

  /** The provider refused the key: stop using it, keep it so Settings can say which. */
  markInvalid(): void {
    this.#sql.exec("UPDATE model_keys SET status = 'invalid', invalid_at = ? WHERE slot = 1", Date.now());
  }

  /** The plaintext key for `provider`, only while it is valid. Re-seals a key sealed under the previous `TOKEN_ENC_KEY`. */
  async open(provider: string): Promise<string | undefined> {
    const row = this.#row();
    if (!row || row.provider !== provider || row.status !== "valid") return undefined;
    const sealer = this.#sealer();
    const context = keyContext(row.provider, this.#agent);
    const { plaintext, current } = await sealer.openChecked(row.sealed, context);
    if (!current) {
      this.#sql.exec(
        "UPDATE model_keys SET sealed = ? WHERE slot = 1 AND sealed = ?",
        await sealer.seal(plaintext, context),
        row.sealed
      );
    }
    return plaintext;
  }
}

/**
 * pi-ai's credential store over the sealed key. Read-only: pi never writes
 * keys here, Settings does.
 */
export class SealedCredentialStore implements CredentialStore {
  readonly #keys: ModelKeys;

  constructor(keys: ModelKeys) {
    this.#keys = keys;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const key = await this.#keys.open(providerId);
    return key === undefined ? undefined : { type: "api_key", key };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const info = this.#keys.info();
    return info?.status === "valid" ? [{ providerId: info.provider, type: "api_key" }] : [];
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    // pi asks only to refresh OAuth credentials, which are never stored here.
    const current = await this.read(providerId);
    await fn(current);
    return current;
  }

  async delete(): Promise<void> {
    // Keys are removed from Settings only.
  }
}

/**
 * No ambient credentials. pi-ai's default auth context reads `process.env`,
 * which under `nodejs_compat` holds this Worker's vars and secrets: a stray
 * `ANTHROPIC_API_KEY` secret would otherwise become everyone's key.
 */
export const NO_AMBIENT_AUTH: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false
};

const PREFIX: Record<KeyProvider, string> = { anthropic: "sk-ant-", openai: "sk-" };

/** A format problem with a pasted key, or null. Never repeats the key. */
export function keyFormatProblem(provider: KeyProvider, key: string): string | null {
  if (key.length < 20 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) {
    return `That doesn't look like an ${PROVIDER_LABEL[provider]} API key.`;
  }
  if (!key.startsWith(PREFIX[provider])) {
    return `${PROVIDER_LABEL[provider]} API keys start with ${PREFIX[provider]}.`;
  }
  return null;
}

/** A free, read-only request that only a working key passes: list models. No tokens are spent. */
export function keyCheckRequest(provider: KeyProvider, key: string): Request {
  switch (provider) {
    case "anthropic":
      return new Request("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }
      });
    case "openai":
      return new Request("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  }
}

export type KeyCheck = { ok: true } | { ok: false; status: 400 | 502; error: string };

/** Ask the provider whether the key works. The answer's body is never read into a message. */
export async function checkKey(
  provider: KeyProvider,
  key: string,
  fetcher: (request: Request) => Promise<Response>
): Promise<KeyCheck> {
  let response: Response;
  try {
    response = await fetcher(keyCheckRequest(provider, key));
  } catch {
    return { ok: false, status: 502, error: `Couldn't reach ${PROVIDER_LABEL[provider]} to check the key. Try again.` };
  }
  await response.body?.cancel();
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: 400, error: `${PROVIDER_LABEL[provider]} refused that key.` };
  }
  return { ok: false, status: 502, error: `${PROVIDER_LABEL[provider]} answered ${response.status}; the key wasn't saved. Try again.` };
}

/** `text` with the key, and anything shaped like a provider key, replaced. For error messages that reach the transcript. */
export function redactKeys(text: string, key?: string): string {
  let out = key ? text.split(key).join("[key]") : text;
  out = out.replace(/\bsk-[A-Za-z0-9_*.-]{6,}/g, "[key]");
  return out;
}

/** A provider's error that means the key itself was refused. */
export function isKeyRefused(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return /\b401\b|authentication_error|invalid_api_key|invalid x-api-key|incorrect api key|unauthorized/i.test(errorMessage);
}
