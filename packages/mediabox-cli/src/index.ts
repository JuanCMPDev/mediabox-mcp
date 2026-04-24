#!/usr/bin/env node

import chalk from "chalk";
import { runWizard } from "./wizard.js";
import { generateFiles } from "./generator.js";
import { orchestrate } from "./orchestrator.js";
import { autoConfigureServices } from "./configurator.js";
import { VERSION } from "./utils/version.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const localBuild = args.includes("--local-build");
  const generateOnly = args.includes("--generate-only");
  const outputDir = process.cwd();

  console.log();
  console.log(chalk.bold.cyan("╔══════════════════════════════════════════════════╗"));
  console.log(chalk.bold.cyan("║          🎬  create-mediabox  v" + VERSION + "           ║"));
  console.log(chalk.bold.cyan("║    Self-hosted media server in one command       ║"));
  console.log(chalk.bold.cyan("╚══════════════════════════════════════════════════╝"));

  try {
    // Phase 1: Interactive wizard
    const answers = await runWizard(localBuild);

    // Phase 2: Generate files
    await generateFiles(answers, outputDir);

    if (generateOnly) {
      console.log();
      console.log(chalk.green.bold("Files generated successfully!"));
      console.log(chalk.dim("Inspect .env, docker-compose.yml, and config/ in the current directory."));
      console.log(chalk.dim("Run without --generate-only to start Docker and auto-configure services."));
      process.exit(0);
    }

    // Phase 3: Start Docker and wait for services
    const serviceStatus = await orchestrate(outputDir);

    // Phase 4: Auto-configure everything
    await autoConfigureServices(answers, serviceStatus, outputDir);
  } catch (err) {
    console.log();
    console.log(chalk.red.bold("Setup failed:"), (err as Error).message);
    console.log(chalk.dim("Check docker compose logs for details"));
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
${chalk.bold("create-mediabox")} — Set up a self-hosted media server stack

${chalk.bold("Usage:")}
  npx create-mediabox [options]

${chalk.bold("Options:")}
  --generate-only  Only run the wizard and generate files (no Docker)
                   Useful for inspecting .env and docker-compose.yml
  --local-build    Build mcp-server and telegram-bot from local source
                   instead of pulling pre-built images from GHCR
  --help, -h       Show this help message
  --version, -v    Show version number

${chalk.bold("What it does:")}
  1. Asks you configuration questions (paths, passwords, API keys)
  2. Generates .env and docker-compose.yml in the current directory
  3. Starts all Docker containers (Jellyfin, Sonarr, Radarr, etc.)
  4. Auto-configures service connections (API keys, download clients, sync)

${chalk.bold("Requirements:")}
  - Docker and Docker Compose installed and running
  - Node.js >= 20
`);
}

main();
