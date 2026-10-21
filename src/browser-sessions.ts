import { LifecycleCapability, type CapabilityWebSocketUpgradeContext } from "agents/lifecycle";
import { AuthError } from "./session";

/** Internal Worker → agent header, overwritten at the authenticated edge. */
export const BROWSER_SESSION_HEADER = "x-pda-browser-session";
const SESSION_TAG = "browser-session:";

/** Revocable app sessions. Company access and background work have separate authorization. */
export class BrowserSessions extends LifecycleCapability {
  readonly #ctx: DurableObjectState;
  readonly #mayUse: () => boolean;
  readonly #protected = new WeakSet<WebSocket>();

  constructor(ctx: DurableObjectState, mayUse: () => boolean) {
    super("browser-sessions");
    this.#ctx = ctx;
    this.#mayUse = mayUse;
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS browser_sessions (
      id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    )`);
  }

  /** Called only with a verified signed cookie at the Worker edge. Missing legacy sid fails there. */
  admit(id: string, expiresAt: number): boolean {
    const now = Date.now();
    if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
    this.#ctx.storage.sql.exec("DELETE FROM browser_sessions WHERE expires_at <= ?", now);
    this.#ctx.storage.sql.exec("INSERT OR IGNORE INTO browser_sessions (id, expires_at, revoked) VALUES (?, ?, 0)", id, expiresAt);
    return this.active(id);
  }

  active(id: string): boolean {
    const row = this.#ctx.storage.sql.exec("SELECT expires_at, revoked FROM browser_sessions WHERE id = ?", id).toArray()[0];
    return !!row && row.revoked === 0 && typeof row.expires_at === "number" && row.expires_at > Date.now() && this.#mayUse();
  }

  revoke(id: string, expiresAt: number): void {
    this.#ctx.storage.sql.exec("INSERT INTO browser_sessions (id, expires_at, revoked) VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET revoked = 1", id, expiresAt);
    for (const socket of this.#ctx.getWebSockets(`${SESSION_TAG}${id}`)) this.#close(socket);
  }

  tags(request: Request): string[] {
    const id = request.headers.get(BROWSER_SESSION_HEADER);
    if (!id || !this.active(id)) throw new AuthError("Session revoked");
    return [`${SESSION_TAG}${id}`];
  }

  #session(socket: WebSocket): string | undefined {
    return this.#ctx.getTags(socket).find(tag => tag.startsWith(SESSION_TAG))?.slice(SESSION_TAG.length);
  }

  allowed(socket: WebSocket): boolean {
    const id = this.#session(socket);
    return id !== undefined && this.active(id);
  }

  #close(socket: WebSocket): void {
    try { socket.close(1008, "Sign in again"); } catch { /* Already closed. */ }
  }

  /** Wrap the actual socket so captured references and every outbound capability recheck authority. */
  protect(socket: WebSocket): boolean {
    if (!this.allowed(socket)) { this.#close(socket); return false; }
    if (!this.#protected.has(socket)) {
      const send = socket.send.bind(socket);
      Object.defineProperty(socket, "send", { configurable: true, value: (message: string | ArrayBuffer | ArrayBufferView) => {
        if (this.allowed(socket)) send(message);
        else this.#close(socket);
      } });
      this.#protected.add(socket);
    }
    return true;
  }

  override onStart(): void {
    for (const socket of this.#ctx.getWebSockets()) this.protect(socket);
  }

  onWebSocketUpgrade({ request }: CapabilityWebSocketUpgradeContext): Response | undefined {
    const id = request.headers.get(BROWSER_SESSION_HEADER);
    return id && this.active(id) ? undefined : new Response("Unauthorized", { status: 401 });
  }

  async onWebSocketMessage(socket: WebSocket): Promise<boolean> {
    return !this.protect(socket);
  }
}
