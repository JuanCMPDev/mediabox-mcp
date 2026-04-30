import type { Request, Response, NextFunction } from "express";

/**
 * Origin allowlist policy. Used by both the CORS middleware (which prevents
 * cross-origin reads) and the explicit requireSafeOrigin middleware (which
 * blocks the request server-side — load-bearing against DNS rebinding for
 * non-preflighted POSTs and for non-browser callers that fake Origin).
 */
export interface OriginPolicy {
  /** Exact-match origins, e.g. from the ALLOWED_ORIGINS env var. */
  allowed: string[];
  /** Allow http(s)://localhost[:port] and 127.0.0.1[:port]. Default true. */
  allowLocalhost?: boolean;
  /** Allow Tauri webview origins (tauri://localhost, http(s)://tauri.localhost). Default true. */
  allowTauri?: boolean;
}

const TAURI_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

// Browsers always send Origin reflecting the URL the user typed — never the
// rebound IP — so allowing localhost here does NOT open DNS rebinding.
const LOCALHOST_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isAllowedOrigin(origin: string, policy: OriginPolicy): boolean {
  if (typeof origin !== "string" || origin.length === 0) return false;
  if (policy.allowed.includes(origin)) return true;
  if (policy.allowTauri !== false && TAURI_ORIGINS.has(origin)) return true;
  if (policy.allowLocalhost !== false && LOCALHOST_REGEX.test(origin)) return true;
  return false;
}

/**
 * Express middleware that hard-rejects (403) any request whose Origin header
 * is not in the policy. Requests without Origin (Telegram bot, curl, external
 * MCP clients) are passed through — auth then takes over.
 */
export function buildOriginMiddleware(policy: OriginPolicy) {
  return function requireSafeOrigin(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    if (!origin) return next();
    if (isAllowedOrigin(origin, policy)) return next();
    res.status(403).json({ error: "Origin not allowed", origin });
  };
}

/**
 * Returns a callback compatible with the cors() middleware's `origin` option.
 * Browsers without CORS approval can't read the response, but our explicit
 * requireSafeOrigin still hard-rejects the request server-side.
 */
export function buildCorsOriginCallback(policy: OriginPolicy) {
  return function corsOrigin(
    origin: string | undefined,
    cb: (err: Error | null, allow?: boolean) => void,
  ): void {
    if (!origin) return cb(null, true);
    cb(null, isAllowedOrigin(origin, policy));
  };
}
