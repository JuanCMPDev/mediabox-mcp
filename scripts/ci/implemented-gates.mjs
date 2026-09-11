/** Validate the commands for gates already implemented before PR05. */
export function npmScriptsIn(command) {
  return [...command.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)].map((match) => match[1]);
}

export function validateImplementedGateScripts({ matrix, packageJson, workflow }) {
  const errors = [];
  for (let i = 0; i <= 9; i++) {
    const gateId = `G${String(i).padStart(2, "0")}`;
    const command = matrix.gates?.[gateId]?.requiredCheck;
    if (typeof command !== "string" || npmScriptsIn(command).length === 0) {
      errors.push(`${gateId}: requiredCheck must identify an implemented npm script`);
      continue;
    }
    for (const script of npmScriptsIn(command)) {
      if (typeof packageJson.scripts?.[script] !== "string" || !packageJson.scripts[script].trim()) {
        errors.push(`${gateId}: required npm script is missing or empty: ${script}`);
      }
    }
  }

  // G10+ commands remain declared future work. G08 must actually run both
  // existing smokes in its job, rather than just naming them in the matrix.
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => /^  gate-runtime-packaging:\s*$/.test(line));
  if (start === -1) {
    errors.push("G08: workflow job gate-runtime-packaging is missing");
  } else {
    const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:\s*$/.test(line));
    const job = lines.slice(start + 1, end === -1 ? lines.length : end);
    const runCommands = job.flatMap((line) => {
      const match = line.match(/^\s+run:\s+(.+)$/);
      return match ? npmScriptsIn(match[1]) : [];
    });
    for (const script of ["smoke:node-bun", "smoke:desktop"]) {
      if (!runCommands.includes(script)) errors.push(`G08: workflow job does not run ${script}`);
    }
    if (job.some((line) => /^\s+continue-on-error:\s+true\s*$/.test(line))) {
      errors.push("G08: smoke failures must not be ignored with continue-on-error");
    }
  }

  // G09 must actually run test:local-egress in its workflow job
  const g09Start = lines.findIndex((line) => /^  gate-local-egress:\s*$/.test(line));
  if (g09Start === -1) {
    errors.push("G09: workflow job gate-local-egress is missing");
  } else {
    const end = lines.findIndex((line, index) => index > g09Start && /^  [\w-]+:\s*$/.test(line));
    const job = lines.slice(g09Start + 1, end === -1 ? lines.length : end);
    const runCommands = job.flatMap((line) => {
      const match = line.match(/^\s+run:\s+(.+)$/);
      return match ? npmScriptsIn(match[1]) : [];
    });
    if (!runCommands.includes("test:local-egress")) {
      errors.push("G09: workflow job does not run test:local-egress");
    }
    if (job.some((line) => /^\s+continue-on-error:\s+true\s*$/.test(line))) {
      errors.push("G09: egress test failures must not be ignored with continue-on-error");
    }
  }
  return errors;
}
