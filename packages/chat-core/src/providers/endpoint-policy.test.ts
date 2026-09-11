import { describe, it, expect } from 'vitest';
import {
  validateInferenceEndpoint,
  isLoopbackAddress,
  isCloudMetadataAddress,
  isPrivateLanAddress,
} from './endpoint-policy.js';

describe('InferenceEndpointPolicy (§3.5 / LOC-08)', () => {
  it('correctly identifies address types', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('localhost')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);

    expect(isCloudMetadataAddress('169.254.169.254')).toBe(true);
    expect(isCloudMetadataAddress('169.254.1.1')).toBe(true);
    expect(isCloudMetadataAddress('127.0.0.1')).toBe(false);

    expect(isPrivateLanAddress('192.168.1.100')).toBe(true);
    expect(isPrivateLanAddress('10.0.0.5')).toBe(true);
    expect(isPrivateLanAddress('172.20.0.1')).toBe(true);
    expect(isPrivateLanAddress('8.8.8.8')).toBe(false);
  });

  it('permits loopback endpoints by default', async () => {
    const res = await validateInferenceEndpoint('http://127.0.0.1:11434/v1');
    expect(res.resolvedIp).toBe('127.0.0.1');

    const resLocalhost = await validateInferenceEndpoint('http://localhost:8080/v1');
    expect(resLocalhost.resolvedIp).toBe('127.0.0.1');
  });

  it('strictly rejects cloud metadata endpoints', async () => {
    await expect(
      validateInferenceEndpoint('http://169.254.169.254/latest/meta-data'),
    ).rejects.toThrow(/prohibited cloud metadata IP/);
  });

  it('rejects public internet endpoints', async () => {
    await expect(
      validateInferenceEndpoint('http://8.8.8.8:11434'),
    ).rejects.toThrow(/not permitted under policy/);
  });

  it('rejects LAN endpoints when allowLan is false', async () => {
    await expect(
      validateInferenceEndpoint('http://192.168.1.50:11434', { allowLan: false }),
    ).rejects.toThrow(/not permitted under policy/);
  });

  it('permits LAN endpoints when allowLan is true', async () => {
    const res = await validateInferenceEndpoint('http://192.168.1.50:11434', { allowLan: true });
    expect(res.resolvedIp).toBe('192.168.1.50');
  });
});
