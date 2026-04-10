import { randomBytes, pbkdf2Sync } from "node:crypto";

/** Generate a random hex string of the given byte length */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Generate a qBittorrent-compatible PBKDF2 password hash.
 * qBit uses PBKDF2-HMAC-SHA512 with 100,000 iterations and a 64-byte key.
 * The stored format is: @ByteArray(<salt_hex>:<hash_hex>)
 */
export function qbitPasswordHash(password: string): string {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(password, salt, 100_000, 64, "sha512");
  return `@ByteArray(${salt.toString("base64")}:${key.toString("base64")})`;
}
