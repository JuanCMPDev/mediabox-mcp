#!/usr/bin/env node
/**
 * ci:evidence (§5 / PR05-P10-P11-SPEC)
 *
 * Exports sealed experiment manifest, sanitized evaluation report,
 * and cryptographic SHA-256 checksums of all evaluation artifacts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

export function computeSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function exportEvidence(options = {}) {
  const manifestPath = options.manifest || path.join(repoRoot, 'evals/evidence/experiment-manifest.json');
  const reportPath = options.report || path.join(repoRoot, 'evals/evidence/evaluation-report.json');
  const checksumsPath = options.checksums || path.join(repoRoot, 'evals/evidence/SHA256SUMS');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}. Run npm run eval:local first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Create sanitized report (redacted of environment-specific absolute paths or private credentials)
  const sanitizedReport = {
    schemaVersion: 1,
    evidenceType: 'G10-model-quality-report',
    profileId: manifest.profile.profileId,
    model: manifest.profile.model.name,
    quantization: manifest.profile.model.quantization,
    runtime: manifest.profile.runtime.name,
    hardware: {
      cpu: manifest.profile.cpu,
      gpu: manifest.profile.gpu.name,
      ramPhysicalGb: Math.round(manifest.profile.ram.physicalBytes / 1073741824),
      vramGb: Math.round(manifest.profile.gpu.vramBytes / 1073741824)
    },
    provenance: {
      repo: manifest.repo,
      baseRef: manifest.baseRef,
      headSha: manifest.headSha,
      treeSha: manifest.treeSha,
      controllerId: manifest.controllerId,
      timestamp: manifest.timestamp
    },
    summary: {
      plannedExecutions: manifest.contract.plannedExecutions,
      completedExecutions: manifest.executions.length,
      passes: manifest.passes.map(p => ({
        passNumber: p.passNumber,
        score: `${p.successCount}/${p.scenarioCount}`,
        rate: `${(p.passRate * 100).toFixed(1)}%`,
        categories: p.categoryRates,
        warmP95FirstEventMs: p.warmFirstUsefulEventP95Ms,
        warmP95TaskMs: p.warmEligibleTaskP95Ms,
        violations: p.violations
      })),
      performance: manifest.performance,
      finalStatus: manifest.finalStatus,
      certified: manifest.certified
    }
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(sanitizedReport, null, 2), 'utf8');

  // Compute checksums for all sealed files
  const filesToCheck = [
    manifestPath,
    reportPath,
    path.join(repoRoot, 'evals/local-agent/corpus.json'),
    path.join(repoRoot, 'ci/model-profiles/qwen2.5-7b-ollama-rx7800xt.json'),
    path.join(repoRoot, 'evals/local-agent/scorer.mjs'),
    path.join(repoRoot, 'docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json')
  ];

  const checksumLines = filesToCheck.map(filePath => {
    const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    const hash = computeSha256(filePath);
    return `${hash}  ${relPath}`;
  });

  fs.writeFileSync(checksumsPath, checksumLines.join('\n') + '\n', 'utf8');

  console.log('=== Exported Gate G10 Evidence Package ===');
  console.log(`Manifest:  ${manifestPath}`);
  console.log(`Report:    ${reportPath}`);
  console.log(`Checksums: ${checksumsPath}`);
  console.log(`\nChecksums:\n${checksumLines.join('\n')}`);

  return { manifestPath, reportPath, checksumsPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  exportEvidence();
}
