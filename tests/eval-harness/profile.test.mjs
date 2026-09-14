/**
 * Model profile validation (PR05 §4.1). The contract sets <=9B total parameters
 * as the initial target: a larger model is refused unless its profile carries
 * a written deviation, declared before measuring. A sealed profile describes
 * one machine: any drift in hardware, driver, OS build or runtime libraries is
 * another profile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateModelProfile, checkProfileDrift } from '../../evals/local-agent/profile.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lab2 = JSON.parse(fs.readFileSync(path.join(repoRoot, 'ci/model-profiles/qwen2.5-7b-q4km-ollama0.34-win11-rx7800xt-lab2.json'), 'utf8'));
const lab3 = JSON.parse(fs.readFileSync(path.join(repoRoot, 'ci/model-profiles/qwen3.5-9b-q4km-ollama0.34-win11-rx7800xt-lab3.json'), 'utf8'));

test('a sealed profile validates', () => {
  assert.deepEqual(validateModelProfile(lab2), []);
});

test('a model above the 9B target needs a written deviation', () => {
  const big = structuredClone(lab2);
  big.model.totalParameters = 9_653_104_368;
  assert.ok(validateModelProfile(big).some((e) => /9B total-parameter target/.test(e)));

  big.model.sizeTargetDeviation = { reason: 'vision' };
  assert.ok(validateModelProfile(big).some((e) => /sizeTargetDeviation/.test(e)), 'a one-word reason is not a justification');

  big.model.sizeTargetDeviation = { reason: 'the GGUF includes a vision encoder the agent never uses; the language model is 9B-class' };
  assert.deepEqual(validateModelProfile(big), []);
});

test('every committed declaration of a model above the target carries its deviation', () => {
  const declarations = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/profile-declarations.json'), 'utf8'));
  if (!/9b|1[0-9]b/i.test(declarations.model)) return;
  assert.ok(declarations.sizeTargetDeviation?.reason?.length >= 40, `${declarations.model} declares no size-target deviation`);
});

/** What windowsHardware() reads on the machine that collected `p`. */
function machine(p, overrides = {}) {
  return {
    cpu: { Name: `${p.cpu.model} `, NumberOfCores: p.cpu.cores, NumberOfLogicalProcessors: p.cpu.threads },
    physical: p.ram.physicalBytes,
    osInfo: { Caption: `${p.os.name} `, Version: p.os.version, BuildNumber: p.os.build },
    gpus: [
      { Name: 'AMD Radeon(TM) Graphics', DriverVersion: '32.0.21045.5002', PNPDeviceID: 'PCI\\VEN_1002&DEV_164E' },
      { Name: p.gpu.name, DriverVersion: p.gpu.driverVersion, PNPDeviceID: p.gpu.pnpDeviceId },
    ],
    ...overrides,
  };
}
const libraries = (p) => ({ files: p.runtime.libraries.files, sha256: p.runtime.libraries.sha256 });

test('the machine that collected a profile shows no drift', () => {
  const drift = checkProfileDrift(lab3, { hardware: machine(lab3), libraries: libraries(lab3) });
  assert.deepEqual(drift.mismatches, []);
  assert.equal(drift.ok, true);
  for (const field of ['cpu.model', 'ram.physicalBytes', 'os.build', 'gpu.driverVersion', 'runtime.libraries.sha256']) assert.ok(drift.checked.includes(field), field);
});

test('a new driver, OS build, GPU or runtime library set is another profile', () => {
  const gpu = (override) => [{ ...machine(lab3).gpus[1], ...override }];
  const cases = [
    [{ hardware: machine(lab3, { gpus: gpu({ DriverVersion: '32.0.99999.1' }) }) }, 'gpu.driverVersion'],
    [{ hardware: machine(lab3, { osInfo: { Caption: lab3.os.name, Version: '10.0.26300', BuildNumber: '26300' } }) }, 'os.build'],
    [{ hardware: machine(lab3, { gpus: [] }) }, 'gpu.pnpDeviceId'],
    [{ hardware: machine(lab3, { physical: lab3.ram.physicalBytes / 2 }) }, 'ram.physicalBytes'],
    [{ libraries: { ...libraries(lab3), sha256: `sha256:${'0'.repeat(64)}` } }, 'runtime.libraries.sha256'],
  ];
  for (const [injected, field] of cases) {
    const drift = checkProfileDrift(lab3, { hardware: machine(lab3), libraries: libraries(lab3), ...injected });
    assert.equal(drift.ok, false, field);
    assert.ok(drift.mismatches.some((m) => m.startsWith(field)), `${field}: ${drift.mismatches.join(' | ')}`);
  }
});
