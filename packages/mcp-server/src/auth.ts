import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export interface Principal {
  id: string;
  kind: "owner" | "agent";
  capabilities: string[];
}

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

/**
 * Owner administration key (UI, setup wizard, host operations).
 */
export const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || crypto.randomUUID();

/**
 * Dedicated agent key for loopback and delegating clients.
 * Distinct from INTERNAL_API_KEY to enforce separation of authority (B02 / INV-SEPARATION).
 */
export const AGENT_API_KEY = process.env.AGENT_API_KEY || `agent-${crypto.randomUUID()}`;

/**
 * Constant-time string comparison. Hashes both sides to fixed-length SHA-256
 * digests first, so the comparison is independent of input length (no length
 * side channel) and `crypto.timingSafeEqual` never throws on unequal-length
 * buffers.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/**
 * Authenticates requests and assigns an authenticated Principal.
 * Localhost origin or known session IDs do NOT authenticate on their own (INV-AUTH / SEC-02).
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: Missing or malformed Bearer token" });
    return;
  }

  const token = h.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "Unauthorized: Empty token" });
    return;
  }

  // 1. Owner Principal
  if (timingSafeEqualStr(token, INTERNAL_API_KEY)) {
    req.principal = {
      id: "owner-ui",
      kind: "owner",
      capabilities: ["*"],
    };
    return next();
  }

  // 2. Delegated Agent Principal
  if (timingSafeEqualStr(token, AGENT_API_KEY)) {
    req.principal = {
      id: "agent-session",
      kind: "agent",
      capabilities: ["mcp:tools:read", "mcp:tools:propose"],
    };
    return next();
  }

  // Unrecognized, expired or external token rejected (SEC-02)
  res.status(401).json({ error: "Unauthorized: Invalid or expired credentials" });
}

/**
 * Restricts an endpoint strictly to owner identity (SEC-05 / INV-SEPARATION).
 * Prevents agents from accessing raw env, secrets, or docker administration.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.principal || req.principal.kind !== "owner") {
    res.status(403).json({
      error: "Forbidden: Agent session is prohibited from accessing administrative routes",
      code: "ERR_FORBIDDEN_AGENT",
    });
    return;
  }
  next();
}
