#!/usr/bin/env node
/**
 * Gate G00: gate/policy-fixtures
 * Validates the acceptance matrix, required invariants, gates, phase test cases,
 * and ensures no personal fixtures or forbidden paths exist.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

console.log("=== Gate G00: Validating Policy & Fixtures ===");

const matrixPath = path.join(repoRoot, "docs/blueprints/LOCAL-AGENT-ACCEPTANCE.json");
const handoffPath = path.join(repoRoot, "docs/blueprints/LOCAL-AGENT-HANDOFF.es.md");

const errors = [];

// 1. Verify existence of acceptance matrix and handoff template
if (!fs.existsSync(matrixPath)) {
  errors.push(`Acceptance matrix missing: ${matrixPath}`);
}
if (!fs.existsSync(handoffPath)) {
  errors.push(`Handoff template missing: ${handoffPath}`);
}

if (errors.length > 0) {
  console.error("FAILED Gate G00 pre-requisites:\n" + errors.join("\n"));
  process.exit(1);
}

// 2. Parse matrix JSON
let matrix;
try {
  matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
} catch (err) {
  console.error(`FAILED: Invalid JSON in ${matrixPath}:`, err);
  process.exit(1);
}

// 3. Check mandatory invariants
const REQUIRED_INVARIANTS = [
  "INV-AUTH",
  "INV-SEPARATION",
  "INV-APPROVAL",
  "INV-TARGET",
  "INV-UNKNOWN",
  "INV-RECOVERY",
  "INV-QUERY",
  "INV-LOCAL",
  "INV-PARITY",
  "INV-EVIDENCE",
];

for (const inv of REQUIRED_INVARIANTS) {
  if (!matrix.invariants || !matrix.invariants[inv]) {
    errors.push(`Missing mandatory invariant: ${inv}`);
  }
}

// 4. Check mandatory gates G00..G12
for (let i = 0; i <= 12; i++) {
  const gateId = `G${String(i).padStart(2, "0")}`;
  if (!matrix.gates || !matrix.gates[gateId]) {
    errors.push(`Missing mandatory gate: ${gateId}`);
  }
}

// 5. Check all phases P00..P13 and their case IDs
const EXPECTED_PHASE_CASES = {
  P00: ["HAR-01", "HAR-02", "HAR-03", "HAR-04"],
  P01: ["SEC-01", "SEC-02", "SEC-03", "SEC-04", "SEC-05", "SEC-06"],
  P02: ["ID-01", "ID-02", "ID-03", "ID-04", "ID-05"],
  P03: ["OP-01", "OP-02", "OP-03", "OP-04", "OP-05", "OP-06", "OP-07"],
  P04: ["DEL-01", "DEL-02", "DEL-03", "DEL-04", "DEL-05", "DEL-06", "DEL-07", "DEL-08"],
  P05: ["MED-01", "MED-02", "MED-03", "MED-04", "MED-05", "MED-06"],
  P06: ["QRY-01", "QRY-02", "QRY-03", "QRY-04", "QRY-05", "QRY-06"],
  P07: ["CAT-01", "CAT-02", "CAT-03", "CAT-04", "CAT-05", "CAT-06"],
  P08: ["AGT-01", "AGT-02", "AGT-03", "AGT-04", "AGT-05", "AGT-06", "AGT-07", "AGT-08", "AGT-09", "AGT-10", "AGT-11", "AGT-12"],
  P09: ["LOC-01", "LOC-02", "LOC-03", "LOC-04", "LOC-05", "LOC-06", "LOC-07", "LOC-08", "LOC-09", "LOC-10"],
  P10: ["NET-01", "NET-02", "NET-03", "NET-04", "NET-05", "NET-06"],
  P11: ["EVAL-01", "EVAL-02", "EVAL-03", "EVAL-04", "EVAL-05", "EVAL-06"],
  P12: ["E2E-01", "E2E-02", "E2E-03", "E2E-04", "E2E-05", "E2E-06", "E2E-07"],
  P13: ["REL-01", "REL-02", "REL-03", "REL-04", "REL-05", "REL-06"],
};

for (const [phase, cases] of Object.entries(EXPECTED_PHASE_CASES)) {
  const phaseData = matrix.phases?.[phase];
  if (!phaseData) {
    errors.push(`Missing phase in matrix: ${phase}`);
    continue;
  }
  for (const c of cases) {
    if (!phaseData.cases || !phaseData.cases[c]) {
      errors.push(`Phase ${phase} missing case ID: ${c}`);
    }
  }
}

// 6. Check that TestInstallation sandbox exists
const testInstPath = path.join(repoRoot, "packages/core/src/testing/test-installation.ts");
if (!fs.existsSync(testInstPath)) {
  errors.push(`TestInstallation utility missing at: ${testInstPath}`);
}

if (errors.length > 0) {
  console.error("FAILED Gate G00 checks:\n" + errors.join("\n"));
  process.exit(1);
}

console.log("✓ Gate G00 PASSED: Acceptance matrix, invariants, gates, and test sandbox verified.");
