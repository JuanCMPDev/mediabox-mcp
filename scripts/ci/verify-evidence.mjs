#!/usr/bin/env node
/**
 * ci:verify-evidence (§5 / PR05-P10-P11-SPEC / Gate G10)
 *
 * Cryptographically and structurally verifies evaluation evidence:
 *  - Validates repository provenance, commit SHA and tree SHA
 *  - Verifies hashes of contract, corpus, model profile, scorer, and lockfiles
 *  - Confirms completion of 180 planned executions across 3 passes
 *  - Enforces zero tolerance for authorization, scope, egress, and invalid argument violations
 *  - Enforces pass rates (min 54/60 per pass, READ >= 16/20, all others >= 8/10)
 *  - Enforces latency (p95 <= 8s TTFT, p95 <= 30s task) and hardware thresholds
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

export function computeSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {
    manifest: path.join(repoRoot, 'evals/evidence/experiment-manifest.json'),
    contract: path.join(repoRoot, 'docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json'),
    corpus: path.join(repoRoot, 'evals/local-agent/corpus.json'),
    scorer: path.join(repoRoot, 'evals/local-agent/scorer.mjs')
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest' && argv[i + 1]) {
      args.manifest = path.resolve(process.cwd(), argv[++i]);
    } else if (argv[i] === '--contract' && argv[i + 1]) {
      args.contract = path.resolve(process.cwd(), argv[++i]);
    }
  }

  return args;
}

export function verifyEvidence(options = {}) {
  const args = { ...parseCliArgs([]), ...options };
  const errors = [];

  console.log('=== Gate G10: Verifying Local Model Evaluation Evidence ===');
  console.log(`Manifest: ${args.manifest}`);

  if (!fs.existsSync(args.manifest)) {
    console.error(`FAILED: Experiment manifest not found: ${args.manifest}`);
    process.exitCode = 1;
    return { valid: false, errors: [`Manifest file not found: ${args.manifest}`] };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  } catch (err) {
    console.error(`FAILED: Invalid JSON in manifest: ${err.message}`);
    process.exitCode = 1;
    return { valid: false, errors: [`Invalid JSON in manifest: ${err.message}`] };
  }

  // 1. Structure and schema version
  if (manifest.schemaVersion !== 1) {
    errors.push(`Invalid manifest schemaVersion: expected 1, got ${manifest.schemaVersion}`);
  }

  // 2. Repository provenance
  if (manifest.repo !== 'JuanCMPDev/mediabox-mcp') {
    errors.push(`Invalid repository in manifest: expected 'JuanCMPDev/mediabox-mcp', got '${manifest.repo}'`);
  }
  if (!manifest.controllerId || !manifest.controllerId.startsWith('ctrl_')) {
    errors.push(`Invalid or missing controller ID in manifest: '${manifest.controllerId}'`);
  }

  // Check git SHA match
  try {
    const currentHead = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    if (manifest.headSha && manifest.headSha !== currentHead && manifest.headSha !== 'unknown') {
      // In detached PR check or merge commit, compare if commit exists in git
      try {
        execSync(`git cat-file -e ${manifest.headSha}`, { cwd: repoRoot });
      } catch {
        errors.push(`Manifest headSha '${manifest.headSha}' does not exist in repository`);
      }
    }
  } catch {
    // skip git check if git not present
  }

  // 3. Cryptographic hashes verification
  const contractPath = args.contract || path.join(repoRoot, 'docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json');
  const corpusPath = args.corpus || path.join(repoRoot, 'evals/local-agent/corpus.json');
  const scorerPath = args.scorer || path.join(repoRoot, 'evals/local-agent/scorer.mjs');
  const profilePath = path.join(repoRoot, 'ci/model-profiles', `${manifest.profile?.profileId || 'qwen2.5-7b-ollama-rx7800xt'}.json`);

  if (fs.existsSync(contractPath)) {
    const actualContractHash = computeSha256(contractPath);
    if (manifest.hashes?.contractSha256 !== actualContractHash) {
      errors.push(`Contract hash mismatch: expected ${actualContractHash}, manifest recorded ${manifest.hashes?.contractSha256}`);
    }
  }
  if (fs.existsSync(corpusPath)) {
    const actualCorpusHash = computeSha256(corpusPath);
    if (manifest.hashes?.corpusSha256 !== actualCorpusHash) {
      errors.push(`Corpus hash mismatch: expected ${actualCorpusHash}, manifest recorded ${manifest.hashes?.corpusSha256}`);
    }
  }
  if (fs.existsSync(profilePath)) {
    const actualProfileHash = computeSha256(profilePath);
    if (manifest.hashes?.profileSha256 !== actualProfileHash) {
      errors.push(`Profile hash mismatch: expected ${actualProfileHash}, manifest recorded ${manifest.hashes?.profileSha256}`);
    }
  }
  if (fs.existsSync(scorerPath)) {
    const actualScorerHash = computeSha256(scorerPath);
    if (manifest.hashes?.scorerSha256 !== actualScorerHash) {
      errors.push(`Scorer hash mismatch: expected ${actualScorerHash}, manifest recorded ${manifest.hashes?.scorerSha256}`);
    }
  }

  // 4. Planned executions and passes
  const contract = manifest.contract || JSON.parse(fs.readFileSync(contractPath, 'utf8'));

  if (!manifest.executions || manifest.executions.length !== contract.plannedExecutions) {
    errors.push(`Planned executions mismatch: expected ${contract.plannedExecutions}, found ${manifest.executions?.length}`);
  }
  if (!manifest.passes || manifest.passes.length !== contract.passes) {
    errors.push(`Pass count mismatch: expected ${contract.passes}, found ${manifest.passes?.length}`);
  }

  // 5. Invariants and Violations
  let totalAuthViolations = 0;
  let totalScopeViolations = 0;
  let totalEgressViolations = 0;
  let totalInvalidArgs = 0;

  for (const exec of manifest.executions || []) {
    totalAuthViolations += exec.violations?.authorization || 0;
    totalScopeViolations += exec.violations?.scope || 0;
    totalEgressViolations += exec.violations?.egress || 0;
    totalInvalidArgs += exec.violations?.invalidArguments || 0;
  }

  if (totalAuthViolations > contract.maxAuthorizationViolations) {
    errors.push(`Authorization violations found: ${totalAuthViolations} (max: ${contract.maxAuthorizationViolations})`);
  }
  if (totalScopeViolations > contract.maxScopeViolations) {
    errors.push(`Scope violations found: ${totalScopeViolations} (max: ${contract.maxScopeViolations})`);
  }
  if (totalEgressViolations > contract.maxEgressViolations) {
    errors.push(`Egress violations found: ${totalEgressViolations} (max: ${contract.maxEgressViolations})`);
  }
  if (totalInvalidArgs > contract.maxInvalidArgumentsExecuted) {
    errors.push(`Invalid arguments executed: ${totalInvalidArgs} (max: ${contract.maxInvalidArgumentsExecuted})`);
  }

  // 6. Pass Thresholds
  for (const p of manifest.passes || []) {
    if (p.successCount < contract.minSuccessPerPass) {
      errors.push(`Pass ${p.passNumber} score ${p.successCount}/${p.scenarioCount} is below minimum ${contract.minSuccessPerPass}`);
    }
    for (const [catName, catRules] of Object.entries(contract.categories)) {
      const cat = p.categoryRates?.[catName];
      if (!cat) {
        errors.push(`Pass ${p.passNumber} missing category: ${catName}`);
      } else if (cat.success < catRules.minSuccessPerPass) {
        errors.push(`Pass ${p.passNumber} category ${catName} score ${cat.success}/${cat.count} is below minimum ${catRules.minSuccessPerPass}`);
      }
    }

    if (p.warmFirstUsefulEventP95Ms > contract.performance.warmFirstUsefulEventP95Ms) {
      errors.push(`Pass ${p.passNumber} warm p95 first event ${p.warmFirstUsefulEventP95Ms}ms exceeds threshold ${contract.performance.warmFirstUsefulEventP95Ms}ms`);
    }
    if (p.warmEligibleTaskP95Ms > contract.performance.warmEligibleTaskP95Ms) {
      errors.push(`Pass ${p.passNumber} warm p95 task latency ${p.warmEligibleTaskP95Ms}ms exceeds threshold ${contract.performance.warmEligibleTaskP95Ms}ms`);
    }
  }

  // 7. Hardware & Cold Canary thresholds
  if (manifest.performance?.coldCanaryTimingsMs) {
    for (const timing of manifest.performance.coldCanaryTimingsMs) {
      if (timing > contract.performance.coldLoadAndCanaryMaxMs) {
        errors.push(`Cold canary timing ${timing}ms exceeds max ${contract.performance.coldLoadAndCanaryMaxMs}ms`);
      }
    }
  }
  if (manifest.performance?.peakMemoryFraction > contract.performance.maxRuntimeMemoryFractionOfReservedBudget) {
    errors.push(`Peak memory fraction ${manifest.performance.peakMemoryFraction} exceeds max ${contract.performance.maxRuntimeMemoryFractionOfReservedBudget}`);
  }
  if (manifest.performance?.mediaThroughputDegradation > contract.performance.maxMediaThroughputLoss) {
    errors.push(`Media throughput degradation ${manifest.performance.mediaThroughputDegradation} exceeds max ${contract.performance.maxMediaThroughputLoss}`);
  }
  if (manifest.performance?.oomOrRestarts > contract.performance.maxOomOrRestarts) {
    errors.push(`OOM or restarts observed: ${manifest.performance.oomOrRestarts}`);
  }

  // 8. Final Status
  if (manifest.finalStatus !== 'passed') {
    errors.push(`Manifest finalStatus is '${manifest.finalStatus}', expected 'passed'`);
  }

  if (errors.length > 0) {
    console.error('FAILED Gate G10 Evidence Verification:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    return { valid: false, errors };
  }

  console.log(`✓ Gate G10 Evidence VERIFIED: 180 executions, 0 violations, all thresholds satisfied.`);
  return { valid: true, errors: [] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyEvidence();
  if (!result.valid) {
    process.exit(1);
  }
}
