import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// A published default would let anyone forge references. Without an explicit
// secret, references are only valid for the lifetime of this process.
const REFERENCE_SECRET = process.env.REFERENCE_SECRET || randomBytes(32).toString("hex");
export const DEFAULT_REFERENCE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class ReferenceValidationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "ERR_INVALID_REFERENCE"
      | "ERR_EXPIRED_REFERENCE"
      | "ERR_REFERENCE_MISMATCH"
      | "ERR_REFERENCE_WRONG_TYPE" = "ERR_INVALID_REFERENCE"
  ) {
    super(message);
    this.name = "ReferenceValidationError";
  }
}

export interface ReferencePayload {
  type: "media" | "release";
  installationId: string;
  ownerId: string;
  conversationId: string;
  id: string; // canonical media ID or release GUID
  title?: string;
  mediaId?: string; // parent media id for releases
  serviceEntityIds?: Record<string, unknown>;
  snapshotId?: string;
  expiresAt: number;
}

// In-memory store for short reference tokens (mref_<12 hex>, rref_<12 hex>)
const SHORT_REF_STORE = new Map<string, ReferencePayload>();

function cleanupShortRefs(): void {
  const now = Date.now();
  for (const [key, payload] of SHORT_REF_STORE.entries()) {
    if (now > payload.expiresAt) {
      SHORT_REF_STORE.delete(key);
    }
  }
}

function signPayload(serialized: string): string {
  return createHmac("sha256", REFERENCE_SECRET).update(serialized).digest("hex");
}

function encodeReference(payload: ReferencePayload): string {
  if (SHORT_REF_STORE.size > 2000) {
    cleanupShortRefs();
  }
  const prefix = payload.type === "media" ? "mref" : "rref";
  const shortId = randomBytes(6).toString("hex");
  const token = `${prefix}_${shortId}`;
  SHORT_REF_STORE.set(token, payload);
  return token;
}

/** Legacy helper to encode full signed payload (for testing backward compatibility). */
export function encodeLegacySignedReference(payload: ReferencePayload): string {
  const jsonStr = JSON.stringify(payload);
  const sig = signPayload(jsonStr);
  const base = Buffer.from(jsonStr, "utf8").toString("base64url");
  const prefix = payload.type === "media" ? "mref" : "rref";
  return `${prefix}_${base}.${sig}`;
}

export function verifyReference(
  refString: string,
  expectedType: "media" | "release",
  context: { installationId: string; ownerId: string }
): ReferencePayload {
  if (!refString || typeof refString !== "string") {
    throw new ReferenceValidationError("Missing or invalid reference", "ERR_INVALID_REFERENCE");
  }

  const expectedPrefix = expectedType === "media" ? "mref_" : "rref_";
  if (!refString.startsWith(expectedPrefix)) {
    throw new ReferenceValidationError(
      `Reference type mismatch: expected ${expectedType} reference`,
      "ERR_REFERENCE_WRONG_TYPE"
    );
  }

  // 1. Check if token is short reference format: mref_<12hex> or rref_<12hex>
  const shortMatch = /^[mr]ref_[0-9a-f]{12}$/.test(refString);
  if (shortMatch) {
    const payload = SHORT_REF_STORE.get(refString);
    if (!payload) {
      throw new ReferenceValidationError("Reference has expired", "ERR_EXPIRED_REFERENCE");
    }

    if (payload.type !== expectedType) {
      throw new ReferenceValidationError(
        `Reference payload type mismatch: expected ${expectedType}, found ${payload.type}`,
        "ERR_REFERENCE_WRONG_TYPE"
      );
    }

    if (Date.now() > payload.expiresAt) {
      SHORT_REF_STORE.delete(refString);
      throw new ReferenceValidationError("Reference has expired", "ERR_EXPIRED_REFERENCE");
    }

    if (payload.installationId !== context.installationId) {
      throw new ReferenceValidationError(
        `Reference installation mismatch: expected ${context.installationId}`,
        "ERR_REFERENCE_MISMATCH"
      );
    }

    if (payload.ownerId !== context.ownerId) {
      throw new ReferenceValidationError(
        `Reference owner mismatch: expected ${context.ownerId}`,
        "ERR_REFERENCE_MISMATCH"
      );
    }

    return payload;
  }

  // 2. Legacy fallback: signed base64url payload with HMAC
  const stripped = refString.slice(expectedPrefix.length);
  const parts = stripped.split(".");
  if (parts.length !== 2) {
    throw new ReferenceValidationError("Malformed reference token", "ERR_INVALID_REFERENCE");
  }

  const [encodedPayload, receivedSig] = parts;
  let jsonStr: string;
  try {
    jsonStr = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    throw new ReferenceValidationError("Corrupted reference payload", "ERR_INVALID_REFERENCE");
  }

  const expectedSig = signPayload(jsonStr);
  const receivedBuf = Buffer.from(receivedSig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");

  if (receivedBuf.length !== expectedBuf.length || !timingSafeEqual(receivedBuf, expectedBuf)) {
    throw new ReferenceValidationError("Tampered or invalid reference signature", "ERR_INVALID_REFERENCE");
  }

  let payload: ReferencePayload;
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    throw new ReferenceValidationError("Unparseable reference payload", "ERR_INVALID_REFERENCE");
  }

  if (payload.type !== expectedType) {
    throw new ReferenceValidationError(
      `Reference payload type mismatch: expected ${expectedType}, found ${payload.type}`,
      "ERR_REFERENCE_WRONG_TYPE"
    );
  }

  if (Date.now() > payload.expiresAt) {
    throw new ReferenceValidationError("Reference has expired", "ERR_EXPIRED_REFERENCE");
  }

  if (payload.installationId !== context.installationId) {
    throw new ReferenceValidationError(
      `Reference installation mismatch: expected ${context.installationId}`,
      "ERR_REFERENCE_MISMATCH"
    );
  }

  if (payload.ownerId !== context.ownerId) {
    throw new ReferenceValidationError(
      `Reference owner mismatch: expected ${context.ownerId}`,
      "ERR_REFERENCE_MISMATCH"
    );
  }

  return payload;
}

export function createMediaRef(
  media: {
    id: string;
    title?: string;
    providerIds?: Record<string, unknown>;
    snapshotId?: string;
  },
  context: {
    installationId: string;
    ownerId: string;
    conversationId: string;
    ttlMs?: number;
  }
): string {
  const expiresAt = Date.now() + (context.ttlMs ?? DEFAULT_REFERENCE_TTL_MS);
  const payload: ReferencePayload = {
    type: "media",
    installationId: context.installationId,
    ownerId: context.ownerId,
    conversationId: context.conversationId,
    id: media.id,
    title: media.title,
    serviceEntityIds: media.providerIds,
    snapshotId: media.snapshotId,
    expiresAt,
  };
  return encodeReference(payload);
}

export function verifyMediaRef(
  mediaRef: string,
  context: { installationId: string; ownerId: string }
): ReferencePayload {
  return verifyReference(mediaRef, "media", context);
}

export function createReleaseRef(
  release: {
    guid: string;
    title: string;
    indexerId?: number;
    mediaId: string;
    serviceEntityIds?: Record<string, unknown>;
    snapshotId?: string;
  },
  context: {
    installationId: string;
    ownerId: string;
    conversationId: string;
    ttlMs?: number;
  }
): string {
  const expiresAt = Date.now() + (context.ttlMs ?? DEFAULT_REFERENCE_TTL_MS);
  const payload: ReferencePayload = {
    type: "release",
    installationId: context.installationId,
    ownerId: context.ownerId,
    conversationId: context.conversationId,
    id: release.guid,
    title: release.title,
    mediaId: release.mediaId,
    serviceEntityIds: {
      ...release.serviceEntityIds,
      indexerId: release.indexerId,
    },
    snapshotId: release.snapshotId,
    expiresAt,
  };
  return encodeReference(payload);
}

export function verifyReleaseRef(
  releaseRef: string,
  context: { installationId: string; ownerId: string }
): ReferencePayload {
  return verifyReference(releaseRef, "release", context);
}
