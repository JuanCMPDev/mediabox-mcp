import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { npmScriptsIn, validateImplementedGateScripts } from "./implemented-gates.mjs";

const repoRoot = new URL("../../", import.meta.url);
const baseline = {
  matrix: JSON.parse(fs.readFileSync(new URL("docs/blueprints/LOCAL-AGENT-ACCEPTANCE.json", repoRoot), "utf8")),
  packageJson: JSON.parse(fs.readFileSync(new URL("package.json", repoRoot), "utf8")),
  workflow: fs.readFileSync(new URL(".github/workflows/ci.yml", repoRoot), "utf8"),
};

test("G00 accepts current implemented gates without requiring future G10+ scripts", () => {
  const candidate = structuredClone(baseline);
  for (const gate of ["G10", "G11", "G12"]) {
    candidate.matrix.gates[gate].requiredCheck = `npm run future:${gate}`;
  }
  assert.deepEqual(validateImplementedGateScripts(candidate), []);
});

test("G00 rejects removal of every npm script required by G00..G09", () => {
  for (let i = 0; i <= 9; i++) {
    const gateId = `G${String(i).padStart(2, "0")}`;
    for (const script of npmScriptsIn(baseline.matrix.gates[gateId].requiredCheck)) {
      const candidate = structuredClone(baseline);
      delete candidate.packageJson.scripts[script];
      assert.ok(validateImplementedGateScripts(candidate).some((error) => error.includes(`${gateId}:`) && error.includes(script)), `${gateId}: ${script}`);
    }
  }
});

test("G00 rejects an empty implemented script", () => {
  const candidate = structuredClone(baseline);
  candidate.packageJson.scripts["smoke:desktop"] = " ";
  assert.ok(validateImplementedGateScripts(candidate).some((error) => error.includes("missing or empty: smoke:desktop")));
});

test("G00 rejects a desktop smoke present only as a commented workflow command", () => {
  const candidate = structuredClone(baseline);
  candidate.workflow = candidate.workflow.replace("run: npm run smoke:desktop", "# run: npm run smoke:desktop");
  assert.ok(validateImplementedGateScripts(candidate).includes("G08: workflow job does not run smoke:desktop"));
});

test("G00 rejects silently ignored runtime smoke failures", () => {
  const candidate = structuredClone(baseline);
  candidate.workflow = candidate.workflow.replace("run: npm run smoke:desktop", "continue-on-error: true\n        run: npm run smoke:desktop");
  assert.ok(validateImplementedGateScripts(candidate).includes("G08: smoke failures must not be ignored with continue-on-error"));
});

test("G00 rejects a local egress test present only as a commented workflow command", () => {
  const candidate = structuredClone(baseline);
  candidate.workflow = candidate.workflow.replace("run: npm run test:local-egress", "# run: npm run test:local-egress");
  assert.ok(validateImplementedGateScripts(candidate).includes("G09: workflow job does not run test:local-egress"));
});

test("G00 rejects silently ignored local egress failures", () => {
  const candidate = structuredClone(baseline);
  candidate.workflow = candidate.workflow.replace("run: npm run test:local-egress", "continue-on-error: true\n        run: npm run test:local-egress");
  assert.ok(validateImplementedGateScripts(candidate).includes("G09: egress test failures must not be ignored with continue-on-error"));
});

