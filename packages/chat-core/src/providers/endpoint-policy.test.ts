/* ─── Inference endpoint policy (LOC-06) ────────────────────────────────────
 * Covers what the spec requires to be blocked *before* a connection is opened:
 * public hosts, a name that resolves to a public or link-local IP, redirects,
 * environment proxies, and any non-loopback host missing from the allow-list.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  validateInferenceEndpoint,
  safeInferenceFetch,
  isLoopbackAddress,
  isCloudMetadataAddress,
  isPrivateLanAddress,
  isUnspecifiedAddress,
  normalizeAddress,
  parseHostList,
} from './endpoint-policy.js';

const servers: Server[] = [];

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; server: Server }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as any).port, server }));
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  delete process.env.HTTP_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.INFERENCE_ALLOW_LAN;
  delete process.env.INFERENCE_ENDPOINT_HOSTS;
});

describe('Address classification', () => {
  it('classifies loopback, link-local, private and public addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.5.5.5')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    // A name is not an address: it must be resolved before it can be judged.
    expect(isLoopbackAddress('localhost')).toBe(false);

    expect(isUnspecifiedAddress('0.0.0.0')).toBe(true);
    expect(isUnspecifiedAddress('::')).toBe(true);

    expect(isCloudMetadataAddress('169.254.169.254')).toBe(true);
    expect(isCloudMetadataAddress('fe80::1')).toBe(true);
    expect(isCloudMetadataAddress('127.0.0.1')).toBe(false);

    expect(isPrivateLanAddress('192.168.1.100')).toBe(true);
    expect(isPrivateLanAddress('10.0.0.5')).toBe(true);
    expect(isPrivateLanAddress('172.20.0.1')).toBe(true);
    expect(isPrivateLanAddress('172.15.0.1')).toBe(false);
    expect(isPrivateLanAddress('fd00::1')).toBe(true);
    expect(isPrivateLanAddress('8.8.8.8')).toBe(false);
    expect(isPrivateLanAddress('169.254.169.254')).toBe(false);

    expect(normalizeAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(parseHostList(' a , B ,, c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('Loopback is the default, everything else is explicit', () => {
  it('permits loopback literals in both families', async () => {
    const v4 = await validateInferenceEndpoint('http://127.0.0.1:11434/v1');
    expect(v4.resolvedIp).toBe('127.0.0.1');
    expect(v4.pinnedUrl.toString()).toBe('http://127.0.0.1:11434/v1');

    const v6 = await validateInferenceEndpoint('http://[::1]:11434/v1');
    expect(v6.resolvedIp).toBe('::1');
    expect(v6.pinnedUrl.hostname).toBe('[::1]');
  });

  it('resolves localhost instead of assuming it is loopback', async () => {
    const ok = await validateInferenceEndpoint('http://localhost:8080/v1', {
      lookupFn: async () => ({ address: '127.0.0.1' }),
    });
    expect(ok.resolvedIp).toBe('127.0.0.1');

    // A host file or split-horizon DNS that maps localhost elsewhere must not pass (§6.10).
    await expect(
      validateInferenceEndpoint('http://localhost:8080/v1', {
        lookupFn: async () => ({ address: '203.0.113.7' }),
      }),
    ).rejects.toThrow(/not loopback/);
  });

  it('rejects the unspecified address, metadata IPs and public IPs', async () => {
    await expect(validateInferenceEndpoint('http://0.0.0.0:11434')).rejects.toThrow(/unspecified address/);
    await expect(validateInferenceEndpoint('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/link-local/);
    await expect(validateInferenceEndpoint('http://8.8.8.8:11434')).rejects.toThrow(/not loopback/);
  });

  it('rejects a name that resolves to a public IP even with LAN enabled', async () => {
    await expect(
      validateInferenceEndpoint('http://rebind.example:11434', {
        allowLan: true,
        allowedHosts: ['rebind.example'],
        lookupFn: async () => ({ address: '203.0.113.10' }),
      }),
    ).rejects.toThrow(/public IP/);
  });

  it('rejects https because fingerprint pinning is not implemented', async () => {
    await expect(validateInferenceEndpoint('https://127.0.0.1:11434')).rejects.toThrow(/HTTPS inference endpoints/);
  });
});

describe('LAN access requires the explicit host allow-list (§3.5)', () => {
  it('refuses a private address when LAN is disabled', async () => {
    await expect(
      validateInferenceEndpoint('http://192.168.1.50:11434', { allowLan: false }),
    ).rejects.toThrow(/INFERENCE_ALLOW_LAN/);
  });

  it('refuses a private address when the allow-list is empty', async () => {
    await expect(
      validateInferenceEndpoint('http://192.168.1.50:11434', { allowLan: true, allowedHosts: [] }),
    ).rejects.toThrow(/INFERENCE_ENDPOINT_HOSTS/);
  });

  it('refuses a private host that is not listed', async () => {
    await expect(
      validateInferenceEndpoint('http://inference.lan:11434', {
        allowLan: true,
        allowedHosts: ['other.lan'],
        lookupFn: async () => ({ address: '10.0.0.9' }),
      }),
    ).rejects.toThrow(/not in INFERENCE_ENDPOINT_HOSTS/);
  });

  it('permits a listed private host and pins the validated IP', async () => {
    const res = await validateInferenceEndpoint('http://inference.lan:11434/v1', {
      allowLan: true,
      allowedHosts: ['inference.lan'],
      lookupFn: async () => ({ address: '10.0.0.9' }),
    });
    expect(res.resolvedIp).toBe('10.0.0.9');
    expect(res.pinnedUrl.toString()).toBe('http://10.0.0.9:11434/v1');
    expect(res.hostHeader).toBe('inference.lan:11434');
  });

  it('reads the policy from the environment when no options are given', async () => {
    process.env.INFERENCE_ALLOW_LAN = 'true';
    process.env.INFERENCE_ENDPOINT_HOSTS = 'inference.lan';
    const res = await validateInferenceEndpoint('http://inference.lan:11434', {
      lookupFn: async () => ({ address: '10.0.0.9' }),
    });
    expect(res.resolvedIp).toBe('10.0.0.9');
  });
});

describe('Connection behaviour', () => {
  it('connects to the validated IP, not to a name re-resolved at connect time', async () => {
    let hits = 0;
    const { port } = await listen((_req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });

    let lookups = 0;
    const res = await safeInferenceFetch(
      `http://inference.local:${port}/api/version`,
      {},
      {
        allowLan: true,
        allowedHosts: ['inference.local'],
        lookupFn: async () => {
          lookups++;
          return { address: '127.0.0.1' };
        },
      },
    );

    expect(res.status).toBe(200);
    expect(hits).toBe(1);
    expect(lookups).toBe(1); // resolved once, then the IP is used verbatim
  });

  it('never follows a redirect', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(302, { Location: 'http://example.com/evil' });
      res.end();
    });

    await expect(safeInferenceFetch(`http://127.0.0.1:${port}/v1/models`)).rejects.toThrow(/redirect/i);
  });

  it('refuses to send local inference traffic through an environment proxy', async () => {
    process.env.HTTP_PROXY = 'http://proxy.corp:3128';
    await expect(validateInferenceEndpoint('http://127.0.0.1:11434')).rejects.toThrow(/HTTP_PROXY/);

    process.env.NO_PROXY = '127.0.0.1';
    const res = await validateInferenceEndpoint('http://127.0.0.1:11434');
    expect(res.resolvedIp).toBe('127.0.0.1');
  });
});
