import crypto from "node:crypto";
import type { Principal, PrincipalKind } from "@mediabox/contracts";

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: "ERR_INVALID_TOKEN" | "ERR_TOKEN_EXPIRED" | "ERR_TOKEN_REVOKED" | "ERR_SESSION_MISMATCH",
    public readonly statusCode: number = 401
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionRecord {
  sessionId: string;
  token: string;
  principal: Principal;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface CreateSessionOptions {
  id?: string;
  kind?: PrincipalKind;
  capabilities?: string[];
  ttlMs?: number;
  audience?: string;
}

/**
 * Constant-time string comparison preventing timing attacks.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export class SessionManager {
  private readonly installationId: string;
  private credentialVersion: number = 1;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tokenToSession = new Map<string, string>();
  private readonly revocationListeners: Array<(sessionId: string) => void> = [];

  constructor(installationId?: string) {
    this.installationId = installationId || process.env.MEDIABOX_INSTALLATION_ID || "mediabox-default";
  }

  public getInstallationId(): string {
    return this.installationId;
  }

  public getCredentialVersion(): number {
    return this.credentialVersion;
  }

  /**
   * Registers a listener triggered whenever a session is explicitly revoked.
   * Useful for instantly terminating active transports (e.g., live MCP SSE/HTTP connections).
   */
  public onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.revocationListeners.push(listener);
    return () => {
      const idx = this.revocationListeners.indexOf(listener);
      if (idx !== -1) this.revocationListeners.splice(idx, 1);
    };
  }

  /**
   * Creates and registers a delegated short-lived session.
   */
  public createSession(options: CreateSessionOptions = {}): { sessionId: string; token: string; principal: Principal } {
    const sessionId = crypto.randomUUID();
    const token = `ssec_${crypto.randomBytes(32).toString("hex")}`;
    const now = Date.now();
    const ttlMs = options.ttlMs ?? 3600_000; // default 1 hour
    const expiresAt = now + ttlMs;
    const kind = options.kind ?? "agent-session";

    const defaultCaps: Record<PrincipalKind, string[]> = {
      "owner": ["*"],
      "owner-ui": ["*"],
      "agent": ["mcp:tools:read", "mcp:tools:propose"],
      "agent-session": ["mcp:tools:read", "mcp:tools:propose"],
      "installer": ["setup:deploy", "setup:admin"],
      "executor": ["operations:execute"],
      "external-client": ["mcp:tools:read", "mcp:tools:propose"],
    };

    const principal: Principal = {
      id: options.id ?? (kind === "owner-ui" ? "owner-ui" : `agent-${sessionId.slice(0, 8)}`),
      installationId: this.installationId,
      kind,
      capabilities: options.capabilities ?? defaultCaps[kind],
      audience: options.audience ?? "mediabox-local",
      sessionId,
      expiresAt,
      credentialVersion: this.credentialVersion,
    };

    const record: SessionRecord = {
      sessionId,
      token,
      principal,
      createdAt: now,
      expiresAt,
      revoked: false,
    };

    this.sessions.set(sessionId, record);
    this.tokenToSession.set(token, sessionId);

    return { sessionId, token, principal };
  }

  /**
   * Validates a bearer token and resolves the caller's Principal.
   * Recognizes static master keys (INTERNAL_API_KEY, AGENT_API_KEY) and delegated dynamic tokens.
   */
  public validateToken(token: string, internalApiKey?: string, agentApiKey?: string): Principal {
    if (!token || typeof token !== "string") {
      throw new SessionError("Unauthorized: Missing or empty token", "ERR_INVALID_TOKEN", 401);
    }

    const trimmed = token.trim();

    // 1. Static Owner Key
    if (internalApiKey && timingSafeEqualStr(trimmed, internalApiKey)) {
      return {
        id: "owner-ui",
        installationId: this.installationId,
        kind: "owner",
        capabilities: ["*"],
        audience: "mediabox-local",
        sessionId: "owner-master-session",
        expiresAt: Date.now() + 86400_000,
        credentialVersion: this.credentialVersion,
      };
    }

    // 2. Static Agent Key
    if (agentApiKey && timingSafeEqualStr(trimmed, agentApiKey)) {
      return {
        id: "agent-session",
        installationId: this.installationId,
        kind: "agent",
        capabilities: ["mcp:tools:read", "mcp:tools:propose"],
        audience: "mediabox-local",
        sessionId: "agent-static-session",
        expiresAt: Date.now() + 3600_000,
        credentialVersion: this.credentialVersion,
      };
    }

    // 3. Dynamic Delegated Tokens
    const sessionId = this.tokenToSession.get(trimmed);
    if (!sessionId) {
      throw new SessionError("Unauthorized: Invalid credentials", "ERR_INVALID_TOKEN", 401);
    }

    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new SessionError("Unauthorized: Invalid credentials", "ERR_INVALID_TOKEN", 401);
    }

    if (record.revoked || record.principal.credentialVersion < this.credentialVersion) {
      throw new SessionError("Unauthorized: Session has been revoked", "ERR_TOKEN_REVOKED", 401);
    }

    if (Date.now() > record.expiresAt) {
      throw new SessionError("Unauthorized: Session token has expired", "ERR_TOKEN_EXPIRED", 401);
    }

    return { ...record.principal };
  }

  /**
   * Revokes an active session by its ID.
   */
  public revokeSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;

    record.revoked = true;

    // Notify listeners (e.g., active transport cleanup)
    for (const listener of this.revocationListeners) {
      try {
        listener(sessionId);
      } catch {
        // Suppress listener errors during revocation broadcast
      }
    }
    return true;
  }

  /**
   * Global revocation: increments credentialVersion and invalidates all dynamic sessions.
   */
  public revokeAllSessions(): void {
    this.credentialVersion += 1;
    for (const record of this.sessions.values()) {
      record.revoked = true;
    }
    const sessionIds = Array.from(this.sessions.keys());

    for (const sId of sessionIds) {
      for (const listener of this.revocationListeners) {
        try {
          listener(sId);
        } catch {
          // Suppress listener errors
        }
      }
    }
  }

  /**
   * Lists all currently active, non-revoked, unexpired sessions.
   */
  public listActiveSessions(): Array<{ sessionId: string; principal: Principal; createdAt: number; expiresAt: number }> {
    const active: Array<{ sessionId: string; principal: Principal; createdAt: number; expiresAt: number }> = [];
    const now = Date.now();
    for (const record of this.sessions.values()) {
      if (!record.revoked && now <= record.expiresAt && record.principal.credentialVersion >= this.credentialVersion) {
        active.push({
          sessionId: record.sessionId,
          principal: { ...record.principal },
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        });
      }
    }
    return active;
  }

  /**
   * Checks whether a session ID is currently active and valid.
   */
  public isSessionActive(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || record.revoked) return false;
    if (record.principal.credentialVersion < this.credentialVersion) return false;
    if (Date.now() > record.expiresAt) return false;
    return true;
  }

  /**
   * Cleans up expired sessions from memory.
   */
  public purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [sId, record] of this.sessions.entries()) {
      if (now > record.expiresAt || record.revoked) {
        this.sessions.delete(sId);
        this.tokenToSession.delete(record.token);
        purged++;
      }
    }
    return purged;
  }

  /**
   * Resets all sessions and listeners (for test setups).
   */
  public resetForTesting(): void {
    this.sessions.clear();
    this.tokenToSession.clear();
    this.revocationListeners.length = 0;
    this.credentialVersion = 1;
  }
}

export const defaultSessionManager = new SessionManager();
