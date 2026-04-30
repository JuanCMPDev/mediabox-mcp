import crypto from "node:crypto";

interface PendingConfirm {
  op: string;
  payloadHash: string;
  expiresAt: number;
}

const pending = new Map<string, PendingConfirm>();
const TTL_MS = 5 * 60_000;
const SWEEP_MS = 60_000;

// Periodic sweep to drop expired entries even if no one consumes them.
// .unref() so this timer never holds the process open in tests / shutdown.
setInterval(() => {
  const now = Date.now();
  pending.forEach((v, k) => {
    if (v.expiresAt <= now) pending.delete(k);
  });
}, SWEEP_MS).unref();

/**
 * Stable, args-bound hash of an arbitrary payload. Two payloads with the same
 * shape and values produce the same hash; reordering object keys does NOT
 * change the result (we sort keys before serialising).
 */
export function hashPayload(p: unknown): string {
  const canonical = JSON.stringify(p, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (v as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return v;
  });
  return crypto.createHash("sha256").update(canonical ?? "null").digest("hex").slice(0, 16);
}

/**
 * Issue a single-use confirm token for a destructive op + payload.
 * The payload is hashed and bound to the token; consuming with mismatched
 * payload (e.g. attacker swaps the target after preview) is rejected.
 */
export function issueConfirmToken(op: string, payload: unknown): string {
  const token = crypto.randomBytes(12).toString("hex");
  pending.set(token, {
    op,
    payloadHash: hashPayload(payload),
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

/**
 * Returns true iff `token` was issued for `op` with this exact `payload` and
 * has not expired or been consumed already. Always single-use — even a
 * mismatched check burns the token, to prevent guessing attacks.
 */
export function consumeConfirmToken(op: string, token: string, payload: unknown): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const entry = pending.get(token);
  if (!entry) return false;
  pending.delete(token);
  if (entry.expiresAt <= Date.now()) return false;
  if (entry.op !== op) return false;
  if (entry.payloadHash !== hashPayload(payload)) return false;
  return true;
}

/** Test-only — clears all pending tokens. Not exported from index.ts. */
export function _resetConfirmTokensForTest(): void {
  pending.clear();
}
