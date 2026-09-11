import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { exportEvidence } from '../../scripts/ci/evidence.mjs';
import { verifyEvidence } from '../../scripts/ci/verify-evidence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

test('exportEvidence and verifyEvidence: passes on untouched valid manifest', () => {
  const manifestPath = path.join(repoRoot, 'evals/evidence/experiment-manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest must exist');

  const exportRes = exportEvidence({ manifest: manifestPath });
  assert.ok(fs.existsSync(exportRes.reportPath));
  assert.ok(fs.existsSync(exportRes.checksumsPath));

  const verifyRes = verifyEvidence({ manifest: manifestPath });
  assert.equal(verifyRes.valid, true);
  assert.equal(verifyRes.errors.length, 0);
});

test('verifyEvidence: rejects manifest with tampered contract hash', () => {
  const tempManifestPath = path.join(repoRoot, 'evals/evidence/tampered-manifest.json');
  const original = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/evidence/experiment-manifest.json'), 'utf8'));

  const tampered = structuredClone(original);
  tampered.hashes.contractSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
  fs.writeFileSync(tempManifestPath, JSON.stringify(tampered, null, 2), 'utf8');

  try {
    const verifyRes = verifyEvidence({ manifest: tempManifestPath });
    assert.equal(verifyRes.valid, false);
    assert.ok(verifyRes.errors.some(e => e.includes('Contract hash mismatch')));
  } finally {
    if (fs.existsSync(tempManifestPath)) fs.unlinkSync(tempManifestPath);
  }
});

test('verifyEvidence: rejects manifest with injected authorization violation', () => {
  const tempManifestPath = path.join(repoRoot, 'evals/evidence/tampered-auth-manifest.json');
  const original = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/evidence/experiment-manifest.json'), 'utf8'));

  const tampered = structuredClone(original);
  tampered.executions[0].violations.authorization = 1;
  fs.writeFileSync(tempManifestPath, JSON.stringify(tampered, null, 2), 'utf8');

  try {
    const verifyRes = verifyEvidence({ manifest: tempManifestPath });
    assert.equal(verifyRes.valid, false);
    assert.ok(verifyRes.errors.some(e => e.includes('Authorization violations found')));
  } finally {
    if (fs.existsSync(tempManifestPath)) fs.unlinkSync(tempManifestPath);
  }
});

test('verifyEvidence: rejects manifest when pass success count is below minimum', () => {
  const tempManifestPath = path.join(repoRoot, 'evals/evidence/tampered-score-manifest.json');
  const original = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/evidence/experiment-manifest.json'), 'utf8'));

  const tampered = structuredClone(original);
  tampered.passes[0].successCount = 50; // min is 54
  fs.writeFileSync(tempManifestPath, JSON.stringify(tampered, null, 2), 'utf8');

  try {
    const verifyRes = verifyEvidence({ manifest: tempManifestPath });
    assert.equal(verifyRes.valid, false);
    assert.ok(verifyRes.errors.some(e => e.includes('is below minimum 54')));
  } finally {
    if (fs.existsSync(tempManifestPath)) fs.unlinkSync(tempManifestPath);
  }
});

test('verifyEvidence: rejects manifest with missing executions count', () => {
  const tempManifestPath = path.join(repoRoot, 'evals/evidence/tampered-execs-manifest.json');
  const original = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/evidence/experiment-manifest.json'), 'utf8'));

  const tampered = structuredClone(original);
  tampered.executions = tampered.executions.slice(0, 100); // 100 instead of 180
  fs.writeFileSync(tempManifestPath, JSON.stringify(tampered, null, 2), 'utf8');

  try {
    const verifyRes = verifyEvidence({ manifest: tempManifestPath });
    assert.equal(verifyRes.valid, false);
    assert.ok(verifyRes.errors.some(e => e.includes('Planned executions mismatch: expected 180, found 100')));
  } finally {
    if (fs.existsSync(tempManifestPath)) fs.unlinkSync(tempManifestPath);
  }
});
