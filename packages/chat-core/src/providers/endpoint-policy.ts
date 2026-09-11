/* ─── Inference Endpoint Policy & SSRF Prevention ─────────────────────────
 * Enforces loopback and LAN isolation for local inference backends (§3.5 / LOC-08).
 * ──────────────────────────────────────────────────────────────────────── */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { AgentError } from '../agent/errors.js';

export interface EndpointPolicyOptions {
  allowLan?: boolean;
  dnsTimeoutMs?: number;
}

export function isLoopbackAddress(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('127.')) return true;
  if (ip === '0.0.0.0' || ip === '::') return false; // Not a client connect target
  return false;
}

export function isCloudMetadataAddress(ip: string): boolean {
  // AWS/GCP/Azure/DigitalOcean metadata IP: 169.254.169.254 or link-local 169.254.x.x
  if (ip.startsWith('169.254.')) return true;
  if (ip.toLowerCase().startsWith('fe80:')) return true;
  return false;
}

export function isPrivateLanAddress(ip: string): boolean {
  if (isCloudMetadataAddress(ip)) return false;

  // IPv4 RFC 1918
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;

  const match172 = ip.match(/^172\.(\d+)\./);
  if (match172) {
    const octet = parseInt(match172[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }

  // IPv6 ULA (fc00::/7)
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

  return false;
}

export async function validateInferenceEndpoint(
  urlStr: string,
  options: EndpointPolicyOptions = {},
): Promise<{ resolvedIp: string; url: URL }> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new AgentError('ERR_ENDPOINT_POLICY', `Malformed inference endpoint URL: '${urlStr}'`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentError('ERR_ENDPOINT_POLICY', `Unsupported protocol '${url.protocol}'. Only http/https permitted.`);
  }

  const hostname = url.hostname;
  const allowLan = options.allowLan ?? process.env.LOCAL_ALLOW_LAN === '1';
  const dnsTimeoutMs = options.dnsTimeoutMs ?? 2000;

  let ip: string;
  if (isIP(hostname)) {
    ip = hostname;
  } else if (hostname === 'localhost') {
    ip = '127.0.0.1';
  } else {
    // Resolve DNS with timeout
    try {
      const lookupPromise = lookup(hostname);
      const res = await Promise.race([
        lookupPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new AgentError('ERR_ENDPOINT_POLICY', `DNS lookup timed out for ${hostname}`)), dnsTimeoutMs),
        ),
      ]);
      ip = res.address;
    } catch (err: any) {
      if (err instanceof AgentError) throw err;
      throw new AgentError('ERR_ENDPOINT_POLICY', `Failed to resolve hostname '${hostname}': ${err.message}`);
    }
  }

  // Strict check on Cloud Metadata
  if (isCloudMetadataAddress(ip)) {
    throw new AgentError('ERR_ENDPOINT_POLICY', `Endpoint '${urlStr}' resolves to prohibited cloud metadata IP '${ip}'`);
  }

  // Loopback check
  if (isLoopbackAddress(ip)) {
    return { resolvedIp: ip, url };
  }

  // LAN check
  if (allowLan && isPrivateLanAddress(ip)) {
    return { resolvedIp: ip, url };
  }

  throw new AgentError(
    'ERR_ENDPOINT_POLICY',
    `Endpoint '${urlStr}' resolves to IP '${ip}', which is not permitted under policy (allowLan=${allowLan}).`,
  );
}

/**
 * Safe fetch wrapper enforcing redirect: 'error' and endpoint validation.
 */
export async function safeInferenceFetch(
  urlStr: string,
  init: RequestInit = {},
  options: EndpointPolicyOptions = {},
): Promise<Response> {
  const { url } = await validateInferenceEndpoint(urlStr, options);

  const fetchInit: RequestInit = {
    ...init,
    redirect: 'error', // Never follow redirects (§3.5)
  };

  try {
    return await fetch(url.toString(), fetchInit);
  } catch (err: any) {
    if (err.name === 'TypeError' && err.message?.includes('redirect')) {
      throw new AgentError('ERR_ENDPOINT_POLICY', 'Inference endpoint attempted an HTTP redirect, which is forbidden.');
    }
    throw err;
  }
}
