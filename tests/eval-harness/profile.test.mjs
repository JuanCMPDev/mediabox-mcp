/**
 * Model profile validation (PR05 §4.1). The contract sets <=9B total parameters
 * as the initial target: a larger model is refused unless its profile carries
 * a written deviation, declared before measuring.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateModelProfile } from '../../evals/local-agent/profile.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lab2 = JSON.parse(fs.readFileSync(path.join(repoRoot, 'ci/model-profiles/qwen2.5-7b-q4km-ollama0.34-win11-rx7800xt-lab2.json'), 'utf8'));

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
