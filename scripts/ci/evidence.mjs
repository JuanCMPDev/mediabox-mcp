#!/usr/bin/env node
/**
 * ci:evidence — exports a G10 evidence package (PR05 §5).
 *
 * Reads the experiment manifest written by the controller, writes a sanitized
 * report (no conversation text, prompts, keys or host paths) and SHA256SUMS
 * covering every published file, and points evals/evidence/current.json at it.
 *
 *   node scripts/ci/evidence.mjs --evidence <dir>
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function buildReport(m) {
  return {
    schemaVersion: 2,
    evidenceType: 'G10-model-quality-report',
    experimentId: m.experimentId,
    evidenceClass: m.evidenceClass,
    acceptedForG10: m.evidenceClass === 'trusted-controller' && m.compatibility === 'compatible',
    compatibility: m.compatibility,
    candidate: m.candidate,
    profile: { profileId: m.profile.profileId, sha256: m.profile.sha256, sealedAt: m.profile.sealedAt },
    runtime: m.runtime,
    toolchain: m.toolchain,
    controller: {
      id: m.controller.id,
      kind: m.controller.kind,
      cleanCheckout: m.controller.cleanCheckout,
      startedAt: m.controller.startedAt,
      finishedAt: m.controller.finishedAt,
      // The Actions run that produced trusted-controller evidence (PR05 §5).
      ...(m.controller.runId ? {
        repository: m.controller.repository,
        runId: m.controller.runId,
        runAttempt: m.controller.runAttempt,
        workflowRef: m.controller.workflowRef,
        workflowSha: m.controller.workflowSha,
        event: m.controller.event,
        ref: m.controller.ref,
        runnerName: m.controller.runnerName,
        runnerEnvironment: m.controller.runnerEnvironment,
      } : {}),
      ...(m.controller.isolation ? {
        isolation: {
          ok: m.controller.isolation.ok,
          provisioningSha256: m.controller.isolation.provisioningSha256,
          checks: (m.controller.isolation.checks ?? []).map((c) => ({ id: c.id, ok: c.ok })),
        },
      } : {}),
    },
    passes: m.passes.map((p) => ({
      passNumber: p.passNumber,
      passRunId: p.passRunId,
      status: p.status,
      invalidationReason: p.invalidationReason,
      summary: p.summary,
      failedScenarios: (p.records ?? []).filter((r) => !r.success).map((r) => ({ id: r.scenarioId, failures: r.failures, evidenceGaps: r.evidenceGaps, violations: r.violationDetails })),
    })),
    performance: m.performance,
    thresholdEvaluation: m.thresholdEvaluation,
    limitations: m.limitations,
  };
}

export function exportEvidence(dir) {
  const manifestPath = path.join(dir, 'experiment-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const report = buildReport(manifest);
  const reportPath = path.join(dir, 'evaluation-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  const files = ['experiment-manifest.json', 'evaluation-report.json'];
  const sums = files.map((f) => `${sha256(fs.readFileSync(path.join(dir, f)))}  ${f}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);

  const rel = path.relative(path.join(repoRoot, 'evals/evidence'), dir).replace(/\\/g, '/');
  if (!rel.startsWith('..')) {
    fs.writeFileSync(path.join(repoRoot, 'evals/evidence/current.json'), JSON.stringify({ experimentId: rel }, null, 2) + '\n');
  }
  return { reportPath, sums };
}

if (process.argv[1] === __filename) {
  const i = process.argv.indexOf('--evidence');
  if (i < 0) {
    console.error('usage: evidence.mjs --evidence <dir>');
    process.exit(2);
  }
  const { reportPath } = exportEvidence(path.resolve(process.argv[i + 1]));
  console.log(`Report and SHA256SUMS written next to ${reportPath}`);
}
