import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import type { Principal, PrincipalKind } from "@mediabox/contracts";
import { defaultSessionManager, SessionError, timingSafeEqualStr } from "./security/session.js";

export type { Principal, PrincipalKind };
export { timingSafeEqualStr };

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
 * Returns true if the principal has owner identity (owner or owner-ui).
 */
export function isOwner(principal?: Principal): boolean {
  return principal?.kind === "owner" || principal?.kind === "owner-ui";
}

/**
 * Returns true if the principal has agent identity (agent or agent-session).
 */
export function isAgent(principal?: Principal): boolean {
  return principal?.kind === "agent" || principal?.kind === "agent-session";
}

/**
 * Authenticates requests and assigns an authenticated Principal.
 * Resolves static keys and delegated dynamic sessions.
 * Localhost origin or known session IDs do NOT authenticate on their own (INV-AUTH / SEC-02 / ID-05).
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Unauthorized: Missing or malformed Bearer token",
      code: "ERR_UNAUTHORIZED",
    });
    return;
  }

  const token = h.slice(7).trim();
  if (!token) {
    res.status(401).json({
      error: "Unauthorized: Empty token",
      code: "ERR_UNAUTHORIZED",
    });
    return;
  }

  try {
    const principal = defaultSessionManager.validateToken(token, INTERNAL_API_KEY, AGENT_API_KEY);
    req.principal = principal;
    next();
  } catch (err) {
    if (err instanceof SessionError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
      });
      return;
    }
    res.status(401).json({
      error: "Unauthorized: Invalid or expired credentials",
      code: "ERR_INVALID_TOKEN",
    });
  }
}

/**
 * Restricts an endpoint strictly to owner identity (SEC-05 / INV-SEPARATION / ID-03).
 * Prevents agents from accessing raw env, secrets, or docker administration.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal || !isOwner(req.principal)) {
    res.status(403).json({
      error: "Forbidden: Agent session is prohibited from accessing administrative routes",
      code: "ERR_FORBIDDEN_AGENT",
    });
    return;
  }
  next();
}
