import { randomBytes, pbkdf2Sync } from "node:crypto";

/**
 * Generate a qBittorrent-compatible PBKDF2 password hash.
 * qBit uses PBKDF2-HMAC-SHA512 with 100,000 iterations and a 64-byte key.
 * The stored format is: @ByteArray(<salt_base64>:<hash_base64>)
 */
export function qbitPasswordHash(password: string): string {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(password, salt, 100_000, 64, "sha512");
  return `@ByteArray(${salt.toString("base64")}:${key.toString("base64")})`;
}

/**
 * Generate a qBittorrent.conf file with pre-configured password hash.
 * This avoids the fragile temporary password extraction from container logs.
 */
export function generateQbittorrentConfig(password: string): string {
  const hash = qbitPasswordHash(password);

  return `[BitTorrent]
Session\\DefaultSavePath=/downloads
Session\\Port=6881

[Preferences]
WebUI\\Port=8085
WebUI\\Username=admin
WebUI\\Password_PBKDF2="${hash}"
Downloads\\SavePath=/downloads
`;
}
