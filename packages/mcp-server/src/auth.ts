import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  async getClient(clientId: string) { return this.clients.get(clientId); }
  async registerClient(metadata: OAuthClientInformationFull) { this.clients.set(metadata.client_id, metadata); return metadata; }
}

class JellyfinOAuthProvider implements OAuthServerProvider {
  clientsStore = new InMemoryClientsStore();
  private codes = new Map<string, { client: OAuthClientInformationFull; params: AuthorizationParams }>();
  private tokens = new Map<string, { clientId: string; scopes: string[]; expiresAt: number; type: "access" | "refresh" }>();

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const code = crypto.randomUUID();
    this.codes.set(code, { client, params });
    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state !== undefined) url.searchParams.set("state", params.state);
    res.redirect(url.toString());
  }

  async challengeForAuthorizationCode(_c: OAuthClientInformationFull, code: string) {
    return this.codes.get(code)?.params.codeChallenge || "none";
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const data = this.codes.get(code);
    if (!data || data.client.client_id !== client.client_id) throw new Error("Invalid code");
    this.codes.delete(code);
    const at = crypto.randomUUID(), rt = crypto.randomUUID();
    this.tokens.set(at, { clientId: client.client_id, scopes: data.params.scopes || [], expiresAt: Date.now() + 86400_000, type: "access" });
    this.tokens.set(rt, { clientId: client.client_id, scopes: data.params.scopes || [], expiresAt: Date.now() + 2592000_000, type: "refresh" });
    return { access_token: at, token_type: "bearer" as const, expires_in: 86400, refresh_token: rt, scope: (data.params.scopes || []).join(" ") } satisfies OAuthTokens;
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string) {
    const data = this.tokens.get(refreshToken);
    if (!data || data.type !== "refresh" || data.clientId !== client.client_id || data.expiresAt < Date.now()) throw new Error("Invalid refresh token");
    this.tokens.delete(refreshToken);
    const at = crypto.randomUUID(), rt = crypto.randomUUID();
    this.tokens.set(at, { clientId: client.client_id, scopes: data.scopes, expiresAt: Date.now() + 86400_000, type: "access" });
    this.tokens.set(rt, { clientId: client.client_id, scopes: data.scopes, expiresAt: Date.now() + 2592000_000, type: "refresh" });
    return { access_token: at, token_type: "bearer" as const, expires_in: 86400, refresh_token: rt, scope: data.scopes.join(" ") } satisfies OAuthTokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const data = this.tokens.get(token);
    if (!data || data.type !== "access" || data.expiresAt < Date.now()) throw new Error("Invalid token");
    return { token, clientId: data.clientId, scopes: data.scopes, expiresAt: Math.floor(data.expiresAt / 1000) };
  }
}

export const oauthProvider = new JellyfinOAuthProvider();

export const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || crypto.randomUUID();

/**
 * Constant-time string comparison. Hashes both sides to fixed-length SHA-256
 * digests first, so the comparison is independent of input length (no length
 * side channel) and `crypto.timingSafeEqual` never throws on unequal-length
 * buffers.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) {
    if (timingSafeEqualStr(h.slice(7), INTERNAL_API_KEY)) return next();
    try { await oauthProvider.verifyAccessToken(h.slice(7)); return next(); } catch {}
  }
  res.status(401).json({ error: "Unauthorized" });
}
