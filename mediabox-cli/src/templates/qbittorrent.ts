import { qbitPasswordHash } from "../utils/crypto.js";

/**
 * Generate a qBittorrent.conf file with pre-configured password hash.
 * This avoids the fragile temporary password extraction from container logs.
 */
export function generateQbitConfig(password: string): string {
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
