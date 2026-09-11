import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

test('Model profile conforms to frozen specification and has no empty required fields', () => {
  const profilePath = path.join(repoRoot, 'ci/model-profiles/qwen2.5-7b-ollama-rx7800xt.json');
  assert.ok(fs.existsSync(profilePath), 'Profile file must exist');

  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.profileId, 'qwen2.5-7b-ollama-rx7800xt');
  assert.ok(typeof profile.cpu === 'string' && profile.cpu.length > 0);

  // RAM
  assert.ok(profile.ram.physicalBytes > 0);
  assert.ok(profile.ram.usableBytes > 0);
  assert.ok(profile.ram.reservedSystemBytes > 0);
  assert.ok(profile.ram.reservedInferenceBytes > 0);
  assert.ok(profile.ram.usableBytes <= profile.ram.physicalBytes);

  // OS
  assert.ok(profile.os.name && profile.os.build && profile.os.platform && profile.os.arch);

  // GPU
  assert.ok(profile.gpu.name && profile.gpu.driver && profile.gpu.backend);
  assert.ok(profile.gpu.vramBytes > 0);

  // Runtime
  assert.equal(profile.runtime.name, 'ollama');
  assert.ok(profile.runtime.version);
  assert.ok(profile.runtime.binaryOrDigest.startsWith('sha256:'));
  assert.ok(profile.runtime.model);

  // Model & Artifacts
  assert.equal(profile.model.name, 'qwen2.5:7b-instruct');
  assert.ok(profile.model.totalParameters <= 9000000000, 'Model must be <= 9B parameters (§4.1)');
  assert.equal(profile.model.quantization, 'Q4_K_M');
  assert.equal(profile.model.parser, 'qwen-hermes');
  assert.ok(/^[a-f0-9]{64}$/.test(profile.model.hashes.weightsSha256));
  assert.ok(/^[a-f0-9]{64}$/.test(profile.model.hashes.tokenizerSha256));
  assert.ok(/^[a-f0-9]{64}$/.test(profile.model.hashes.templateSha256));

  // Sampling & Limits
  assert.equal(profile.sampling.temperature, 0);
  assert.equal(profile.sampling.seed, 42);
  assert.equal(profile.context, 8192);
  assert.equal(profile.maxConcurrency, 1);

  // Memory policy
  assert.equal(profile.memoryPolicy.maxMemoryFractionOfReservedBudget, 0.7);
  assert.ok(profile.memoryPolicy.maxMemorySampleIntervalMs <= 250);

  // Device sharing
  assert.equal(profile.deviceSharing.sharesGpuWithTranscode, true);
});
