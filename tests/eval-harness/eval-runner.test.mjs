import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCliArgs, executeScenario, runLocalEvaluation } from '../../evals/local-agent/runner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

test('parseCliArgs: extracts custom profile, experiment, and passes arguments', () => {
  const args = parseCliArgs([
    '--profile', 'custom/profile.json',
    '--experiment', 'custom/exp.json',
    '--passes', '1',
    '--simulated'
  ]);

  assert.ok(args.profile.endsWith('custom/profile.json') || args.profile.endsWith('custom\\profile.json'));
  assert.ok(args.experiment.endsWith('custom/exp.json') || args.experiment.endsWith('custom\\exp.json'));
  assert.equal(args.passes, 1);
  assert.equal(args.mode, 'simulated');
});

test('executeScenario: correctly evaluates a single scenario in simulated mode', async () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/corpus.json'), 'utf8'));
  const read01 = corpus.find(s => s.id === 'READ-01');
  const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json'), 'utf8'));

  const result = await executeScenario(read01, 1, 1, 'simulated', contract);

  assert.equal(result.scenarioId, 'READ-01');
  assert.equal(result.category, 'READ');
  assert.equal(result.success, true);
  assert.equal(result.factsMatched, true);
  assert.equal(result.violations.authorization, 0);
  assert.equal(result.violations.scope, 0);
  assert.equal(result.violations.egress, 0);
  assert.equal(result.violations.invalidArguments, 0);
  assert.ok(result.firstVisibleEventMs !== null);
  assert.ok(result.taskDurationMs !== null);
});

test('runLocalEvaluation: fails gracefully when profile file is missing', async () => {
  await assert.rejects(
    async () => {
      await runLocalEvaluation(['--profile', 'non_existent_profile.json']);
    },
    /Model profile file not found/
  );
});

test('runLocalEvaluation: runs 1 full pass of 60 scenarios in simulated mode and outputs manifest', async () => {
  const tempExpPath = path.join(repoRoot, 'evals/evidence/test-temp-manifest.json');

  const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json'), 'utf8'));
  const tempContract = { ...contract, passes: 1, plannedExecutions: 60 };
  const tempContractPath = path.join(repoRoot, 'evals/evidence/test-temp-contract.json');
  fs.writeFileSync(tempContractPath, JSON.stringify(tempContract, null, 2), 'utf8');

  try {
    const manifest = await runLocalEvaluation([
      '--passes', '1',
      '--contract', tempContractPath,
      '--experiment', tempExpPath,
      '--simulated'
    ]);

    assert.equal(manifest.executions.length, 60);
    assert.equal(manifest.passes.length, 1);
    assert.equal(manifest.passes[0].successCount, 60);
    assert.equal(manifest.finalStatus, 'passed');
    assert.ok(fs.existsSync(tempExpPath));
  } finally {
    if (fs.existsSync(tempExpPath)) fs.unlinkSync(tempExpPath);
    if (fs.existsSync(tempContractPath)) fs.unlinkSync(tempContractPath);
  }
});
