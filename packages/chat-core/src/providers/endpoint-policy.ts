/* ─── Inference Endpoint Policy & SSRF Prevention ─────────────────────────
 * Enforces loopback and LAN isolation for local inference backends (§3.5 / LOC-06).
 *
 * The check and the connection must agree, so the request is sent to the IP that
 * was validated (with the original Host header) instead of re-resolving the name
 * at connect time, which is the DNS rebinding hole §6.10 warns about.
 * ──────────────────────────────────────────────────────────────────────── */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { AgentError } from '../agent/errors.js';

export interface EndpointPolicyOptions {
  allowLan?: boolean;
  /** Explicit host allow-list required for any non-loopback endpoint (§3.5). */
  allowedHosts?: string[];
  dnsTimeoutMs?: number;
  /** Resolver override so DNS behaviour can be tested without a network. */
  lookupFn?: (hostname: string) => Promise<{ address: string }>;
}

export function parseHostList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(h => h.length > 0);
}

function envAllowLan(): boolean {
  return process.env.LOCAL_ALLOW_LAN === '1' || process.env.INFERENCE_ALLOW_LAN === 'true';
}

function envAllowedHosts(): string[] {
  return parseHostList(process.env.INFERENCE_ENDPOINT_HOSTS);
}

/** Strips brackets and any IPv4-mapped IPv6 prefix so one comparison covers both families. */
export function normalizeAddress(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  return value;
}

export function isLoopbackAddress(ip: string): boolean {
  const value = normalizeAddress(ip);
  if (value === '::1') return true;
  if (/^127\./.test(value)) return true;
  return false;
}

export function isUnspecifiedAddress(ip: string): boolean {
  const value = normalizeAddress(ip);
  return value === '0.0.0.0' || value === '::';
}

export function isCloudMetadataAddress(ip: string): boolean {
  const value = normalizeAddress(ip);
  // AWS/GCP/Azure/DigitalOcean metadata IP plus the whole IPv4 link-local range
  if (value.startsWith('169.254.')) return true;
  if (value.startsWith('fe80:')) return true;
  return false;
}

export function isPrivateLanAddress(ip: string): boolean {
  const value = normalizeAddress(ip);
  if (isCloudMetadataAddress(value)) return false;

  // IPv4 RFC 1918
  if (value.startsWith('10.')) return true;
  if (value.startsWith('192.168.')) return true;

  const match172 = value.match(/^172\.(\d+)\./);
  if (match172) {
    const octet = parseInt(match172[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }

  // IPv6 unique local addresses (fc00::/7)
  if (/^f[cd]/.test(value)) return true;

  return false;
}

/**
 * Environment proxies must never carry local inference traffic. Neither Node's nor
 * Bun's fetch exposes a portable per-request proxy override, so a configured proxy
 * that would cover the endpoint is refused instead of silently honoured.
 */
function assertNoInterferingProxy(host: string, urlStr: string): void {
  const proxies = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
    .map(name => ({ name, value: (process.env[name] ?? '').trim() }))
    .filter(entry => entry.value.length > 0);
  if (proxies.length === 0) return;

  const noProxy = parseHostList(process.env.NO_PROXY ?? process.env.no_proxy);
  const bypassed =
    noProxy.includes('*') ||
    noProxy.some(entry => host === entry || host.endsWith(`.${entry}`) || entry === 'localhost' && host === 'localhost');
  if (bypassed) return;

  throw new AgentError(
    'ERR_ENDPOINT_POLICY',
    `Endpoint '${urlStr}' would be routed through the ${proxies[0].name} proxy. ` +
      `Unset it for this process or add '${host}' to NO_PROXY: local inference must not leave the machine.`,
  );
}

export interface ValidatedEndpoint {
  /** The address the request must actually connect to. */
  resolvedIp: string;
  /** Original URL as configured. */
  url: URL;
  /** URL rewritten to the validated IP, preserving path and port. */
  pinnedUrl: URL;
  /** Host header to send so virtual hosting and TLS SNI expectations still hold. */
  hostHeader: string;
}

export async function validateInferenceEndpoint(
  urlStr: string,
  options: EndpointPolicyOptions = {},
): Promise<ValidatedEndpoint> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new AgentError('ERR_ENDPOINT_POLICY', `Malformed inference endpoint URL: '${urlStr}'`);
  }

  if (url.protocol === 'https:') {
    // Connecting to a pinned IP and validating a certificate for a hostname are
    // mutually exclusive without fingerprint pinning, which lands with P10.
    throw new AgentError(
      'ERR_ENDPOINT_POLICY',
      'HTTPS inference endpoints are not supported yet: certificate fingerprint pinning (INFERENCE_TLS_FINGERPRINT) is not implemented, so only http to loopback or an allow-listed private host is permitted.',
    );
  }
  if (url.protocol !== 'http:') {
    throw new AgentError('ERR_ENDPOINT_POLICY', `Unsupported protocol '${url.protocol}'. Only http is permitted.`);
  }

  const hostname = normalizeAddress(url.hostname);
  const allowLan = options.allowLan ?? envAllowLan();
  const allowedHosts = (options.allowedHosts ?? envAllowedHosts()).map(h => h.toLowerCase());
  const dnsTimeoutMs = options.dnsTimeoutMs ?? 2000;

  assertNoInterferingProxy(hostname, urlStr);

  let ip: string;
  if (isIP(hostname)) {
    ip = hostname;
  } else {
    // Never assume a name maps to loopback: resolve it and judge the address (§6.10).
    try {
      const resolver = options.lookupFn ?? ((h: string) => lookup(h));
      const res = await Promise.race([
        resolver(hostname),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new AgentError('ERR_ENDPOINT_POLICY', `DNS lookup timed out for ${hostname}`)),
            dnsTimeoutMs,
          ),
        ),
      ]);
      ip = normalizeAddress(res.address);
    } catch (err: any) {
      if (err instanceof AgentError) throw err;
      throw new AgentError('ERR_ENDPOINT_POLICY', `Failed to resolve hostname '${hostname}': ${err.message}`);
    }
  }

  if (isUnspecifiedAddress(ip)) {
    throw new AgentError('ERR_ENDPOINT_POLICY', `Endpoint '${urlStr}' points at the unspecified address '${ip}'`);
  }
  if (isCloudMetadataAddress(ip)) {
    throw new AgentError('ERR_ENDPOINT_POLICY', `Endpoint '${urlStr}' resolves to prohibited link-local IP '${ip}'`);
  }

  const pinned = pinUrl(url, ip);

  if (isLoopbackAddress(ip)) {
    return { resolvedIp: ip, url, pinnedUrl: pinned, hostHeader: url.host };
  }

  if (!allowLan) {
    throw new AgentError(
      'ERR_ENDPOINT_POLICY',
      `Endpoint '${urlStr}' resolves to '${ip}', which is not loopback. Set INFERENCE_ALLOW_LAN=true and list the host in INFERENCE_ENDPOINT_HOSTS to permit it.`,
    );
  }
  if (!isPrivateLanAddress(ip)) {
    throw new AgentError(
      'ERR_ENDPOINT_POLICY',
      `Endpoint '${urlStr}' resolves to public IP '${ip}', which is never permitted for local inference.`,
    );
  }
  if (allowedHosts.length === 0) {
    throw new AgentError(
      'ERR_ENDPOINT_POLICY',
      `Endpoint '${urlStr}' needs an explicit allow-list: set INFERENCE_ENDPOINT_HOSTS to the hosts permitted on the LAN.`,
    );
  }
  if (!allowedHosts.includes(hostname)) {
    throw new AgentError(
      'ERR_ENDPOINT_POLICY',
      `Host '${hostname}' is not in INFERENCE_ENDPOINT_HOSTS (${allowedHosts.join(', ')}).`,
    );
  }

  return { resolvedIp: ip, url, pinnedUrl: pinned, hostHeader: url.host };
}

function pinUrl(url: URL, ip: string): URL {
  const pinned = new URL(url.toString());
  pinned.hostname = ip.includes(':') ? `[${ip}]` : ip;
  return pinned;
}

/**
 * Safe fetch wrapper: validates the endpoint, connects to the validated IP and
 * never follows redirects.
 */
export async function safeInferenceFetch(
  urlStr: string,
  init: RequestInit = {},
  options: EndpointPolicyOptions = {},
): Promise<Response> {
  const validated = await validateInferenceEndpoint(urlStr, options);

  const headers = new Headers(init.headers ?? {});
  if (!headers.has('Host')) headers.set('Host', validated.hostHeader);

  const fetchInit: RequestInit = {
    ...init,
    headers,
    redirect: 'error', // Never follow redirects (§3.5)
  };

  try {
    return await fetch(validated.pinnedUrl.toString(), fetchInit);
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    // undici surfaces the reason on `cause` and keeps the outer message generic.
    const reasons = [err?.message, err?.cause?.message, err?.cause?.code].filter(
      (v): v is string => typeof v === 'string',
    );
    if (reasons.some(r => /redirect/i.test(r))) {
      throw new AgentError(
        'ERR_ENDPOINT_POLICY',
        `Inference endpoint ${validated.url.host} attempted an HTTP redirect, which is forbidden.`,
      );
    }
    throw err;
  }
}
