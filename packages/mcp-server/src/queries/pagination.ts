import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { EnvelopePage } from "@mediabox/contracts";

// A published default would let anyone forge cursors. Without an explicit
// secret, cursors are only valid for the lifetime of this process.
const CURSOR_SECRET = process.env.CURSOR_SECRET || randomBytes(32).toString("hex");
export const DEFAULT_CURSOR_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class CursorValidationError extends Error {
  constructor(
    message: string,
    public readonly code: "ERR_INVALID_CURSOR" | "ERR_EXPIRED_CURSOR" | "ERR_CURSOR_MISMATCH" = "ERR_INVALID_CURSOR"
  ) {
    super(message);
    this.name = "CursorValidationError";
  }
}

export interface CursorPayload {
  offset: number;
  pageSize: number;
  principalId: string;
  installationId: string;
  snapshotId: string;
  filterHash?: string;
  expiresAt: number;
}

function signPayload(serialized: string): string {
  return createHmac("sha256", CURSOR_SECRET).update(serialized).digest("hex");
}

export function createOpaqueCursor(params: {
  offset: number;
  pageSize: number;
  principalId: string;
  installationId: string;
  snapshotId: string;
  filterHash?: string;
  ttlMs?: number;
}): string {
  const expiresAt = Date.now() + (params.ttlMs ?? DEFAULT_CURSOR_TTL_MS);
  const payload: CursorPayload = {
    offset: params.offset,
    pageSize: params.pageSize,
    principalId: params.principalId,
    installationId: params.installationId,
    snapshotId: params.snapshotId,
    filterHash: params.filterHash,
    expiresAt,
  };

  const jsonStr = JSON.stringify(payload);
  const signature = signPayload(jsonStr);
  const combined = `${Buffer.from(jsonStr, "utf8").toString("base64url")}.${signature}`;
  return combined;
}

export function verifyOpaqueCursor(
  cursor: string,
  expected: {
    principalId: string;
    installationId: string;
    snapshotId?: string;
    filterHash?: string;
  }
): CursorPayload {
  if (!cursor || typeof cursor !== "string") {
    throw new CursorValidationError("Missing or invalid cursor format", "ERR_INVALID_CURSOR");
  }

  const parts = cursor.split(".");
  if (parts.length !== 2) {
    throw new CursorValidationError("Malformed cursor format", "ERR_INVALID_CURSOR");
  }

  const [encodedPayload, receivedSig] = parts;
  let jsonStr: string;
  try {
    jsonStr = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    throw new CursorValidationError("Corrupted cursor payload", "ERR_INVALID_CURSOR");
  }

  const expectedSig = signPayload(jsonStr);
  const receivedSigBuf = Buffer.from(receivedSig, "hex");
  const expectedSigBuf = Buffer.from(expectedSig, "hex");

  if (receivedSigBuf.length !== expectedSigBuf.length || !timingSafeEqual(receivedSigBuf, expectedSigBuf)) {
    throw new CursorValidationError("Tampered or invalid cursor signature", "ERR_INVALID_CURSOR");
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    throw new CursorValidationError("Unparseable cursor payload", "ERR_INVALID_CURSOR");
  }

  if (Date.now() > payload.expiresAt) {
    throw new CursorValidationError("Cursor has expired", "ERR_EXPIRED_CURSOR");
  }

  if (payload.installationId !== expected.installationId) {
    throw new CursorValidationError(
      `Cursor installation mismatch: expected ${expected.installationId}, got ${payload.installationId}`,
      "ERR_CURSOR_MISMATCH"
    );
  }

  if (payload.principalId !== expected.principalId) {
    throw new CursorValidationError(
      `Cursor principal mismatch: expected ${expected.principalId}, got ${payload.principalId}`,
      "ERR_CURSOR_MISMATCH"
    );
  }

  if (expected.snapshotId && payload.snapshotId !== expected.snapshotId) {
    throw new CursorValidationError(
      `Cursor snapshot changed: expected ${expected.snapshotId}, got ${payload.snapshotId}`,
      "ERR_CURSOR_MISMATCH"
    );
  }

  if (expected.filterHash && payload.filterHash && payload.filterHash !== expected.filterHash) {
    throw new CursorValidationError("Cursor filter parameter mismatch", "ERR_CURSOR_MISMATCH");
  }

  return payload;
}

export function paginateSlice<T>(
  items: T[],
  cursorString: string | undefined,
  pageSize: number = 20,
  context: { principalId: string; installationId: string; snapshotId: string; filterHash?: string },
  totalKnown: number | null = items.length
): { data: T[]; page: EnvelopePage } {
  let offset = 0;

  if (cursorString) {
    const verified = verifyOpaqueCursor(cursorString, context);
    offset = verified.offset;
  }

  const pageItems = items.slice(offset, offset + pageSize);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < items.length;

  let nextCursor: string | undefined;
  if (hasMore) {
    nextCursor = createOpaqueCursor({
      offset: nextOffset,
      pageSize,
      principalId: context.principalId,
      installationId: context.installationId,
      snapshotId: context.snapshotId,
      filterHash: context.filterHash,
    });
  }

  const pageInfo: EnvelopePage = {
    cursor: nextCursor,
    hasMore,
    totalItems: totalKnown,
    pageSize,
    pageIndex: Math.floor(offset / pageSize),
  };

  return {
    data: pageItems,
    page: pageInfo,
  };
}
