import { URL } from "node:url";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";

export class UrlPolicyError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`URL rejected: ${reason} — ${url}`);
    this.name = "UrlPolicyError";
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// IPv4 private / loopback / link-local / RFC1918 / CGNAT (RFC6598) ranges.
const PRIVATE_V4_PATTERNS: RegExp[] = [
  /^0\./,                                     // RFC1122 "this network"
  /^10\./,                                    // RFC1918
  /^127\./,                                   // loopback
  /^169\.254\./,                              // link-local (incl. cloud metadata 169.254.169.254)
  /^172\.(1[6-9]|2\d|3[01])\./,               // RFC1918 172.16/12
  /^192\.168\./,                              // RFC1918
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC6598 CGNAT 100.64/10
];

function isPrivateV4(ip: string): boolean {
  return PRIVATE_V4_PATTERNS.some((re) => re.test(ip));
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;            // unspecified, loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
  if (lower.startsWith("fe80")) return true;                     // link-local
  if (lower.startsWith("::ffff:")) {                             // IPv4-mapped
    const v4 = lower.slice(7);
    return isIP(v4) === 4 ? isPrivateV4(v4) : true;
  }
  return false;
}

const LOCAL_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];
function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  return LOCAL_HOSTNAME_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * Synchronous URL policy check: validates scheme and blocks IP-literal hosts
 * pointing at private/loopback/link-local addresses, plus obvious local
 * hostnames. Does NOT resolve DNS — the caller can opt into resolveAndCheck()
 * when it controls the fetch (e.g. `download_add` → PyLoad). yt-dlp / aria2c
 * follow redirects we can't observe, so DNS-time checks would race anyway.
 */
export function validateUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new UrlPolicyError(String(raw), "empty or non-string URL");
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlPolicyError(raw, "malformed URL");
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    throw new UrlPolicyError(raw, `scheme ${u.protocol} not allowed`);
  }

  // u.hostname keeps brackets around IPv6 literals (per WHATWG URL); strip
  // them so node:net's isIP() recognises the address.
  const rawHost = u.hostname;
  if (!rawHost) throw new UrlPolicyError(raw, "missing hostname");
  const host =
    rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  const ipKind = isIP(host);
  if (ipKind === 4 && isPrivateV4(host)) {
    throw new UrlPolicyError(raw, `private IPv4 ${host}`);
  }
  if (ipKind === 6 && isPrivateV6(host)) {
    throw new UrlPolicyError(raw, `private IPv6 ${host}`);
  }
  if (ipKind === 0 && isLocalHostname(host)) {
    throw new UrlPolicyError(raw, `local hostname ${host}`);
  }

  return u;
}

/**
 * Resolves the URL's hostname and rejects if any resolved address is private.
 * Use only when this server initiates the fetch (e.g. submitting URLs to
 * PyLoad). Skipped for yt-dlp/aria2c flows where redirects bypass our check.
 */
export async function resolveAndCheck(u: URL): Promise<void> {
  if (isIP(u.hostname)) return; // already validated by validateUrl
  let records: LookupAddress[];
  try {
    records = await lookup(u.hostname, { all: true });
  } catch (err) {
    throw new UrlPolicyError(u.href, `DNS resolution failed: ${(err as Error).message}`);
  }
  for (const r of records) {
    if (r.family === 4 && isPrivateV4(r.address)) {
      throw new UrlPolicyError(u.href, `${r.address} resolves to private IPv4`);
    }
    if (r.family === 6 && isPrivateV6(r.address)) {
      throw new UrlPolicyError(u.href, `${r.address} resolves to private IPv6`);
    }
  }
}
