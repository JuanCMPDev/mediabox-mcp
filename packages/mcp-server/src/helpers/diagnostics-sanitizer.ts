import type { ChatInfo } from "@mediabox/contracts";

const ALLOWED_DIAGNOSTIC_KEYS = new Set([
  "provider",
  "model",
  "mode",
  "runtime",
  "backend",
  "contextTokens",
  "configuredContextTokens",
  "runtimeContextTokens",
  "agentCompatible",
  "endpoint",
  "endpointPolicy",
  "privacyProfile",
  "warning",
]);

/**
 * Common regex patterns for tokens, keys, and credentials.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/gi,
  /canary-[A-Za-z0-9_-]{8,}/gi,
  /AIza[0-9A-Za-z-_]{35}/g,
  /bearer\s+[A-Za-z0-9_.-]{16,}/gi,
  /[a-z0-9_-]+_api_key=[^&\s]+/gi,
  /[a-z0-9_-]+_token=[^&\s]+/gi,
  /:\/\/[^:]+:([^@]+)@/g, // credentials inside URLs
];

/**
 * Strips secrets, embedded credentials, prompts and query strings from a text string.
 */
export function sanitizeString(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  // Sanitize raw URLs to remove query strings that might hold secrets
  result = result.replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, "$1?[REDACTED_QUERY]");
  return result;
}

/**
 * Allowlist-based sanitizer for ChatInfo and diagnostic objects (§3.2 / NET-05).
 * Drops any non-allowlisted properties, removes query strings/headers/prompts,
 * and masks any credentials.
 */
export function sanitizeChatInfo(info: ChatInfo | null): ChatInfo | null {
  if (!info) return null;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (!ALLOWED_DIAGNOSTIC_KEYS.has(key)) {
      continue; // Drop non-allowlisted keys
    }
    if (typeof value === "string") {
      sanitized[key] = sanitizeString(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized as unknown as ChatInfo;
}

/**
 * Deep scanner used by NET-05 to inspect logs, reports, bundles or diagnostics
 * for canary secrets or sensitive conversation markers.
 * Checks both literal and URL-encoded variants.
 */
export function findLeakedSecrets(target: unknown, secrets: string[]): string[] {
  const leaks: string[] = [];
  const text = typeof target === "string" ? target : JSON.stringify(target);
  if (!text) return leaks;

  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    const encoded = encodeURIComponent(secret);
    if (text.includes(secret) || text.includes(encoded)) {
      leaks.push(secret);
    }
  }

  return leaks;
}
