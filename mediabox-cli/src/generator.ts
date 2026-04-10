import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WizardAnswers } from "./types.js";
import { generateEnv } from "./templates/env.js";
import { generateDockerCompose } from "./templates/docker-compose.js";
import { generateQbitConfig } from "./templates/qbittorrent.js";
import * as log from "./utils/logger.js";

/**
 * Phase 2: Generate all files and directories based on wizard answers.
 */
export async function generateFiles(answers: WizardAnswers, outputDir: string): Promise<void> {
  log.header("Phase 2 — Generating configuration files");

  // Create directory structure
  const dirs = [
    "config/jellyfin",
    "config/qbittorrent/qBittorrent",
    "config/sonarr",
    "config/radarr",
    "config/prowlarr",
    "config/pyload",
    "downloads",
    answers.mediaMovies,
    answers.mediaTv,
    answers.mediaAnime,
    answers.mediaMusic,
  ];

  if (answers.enableBazarr) {
    dirs.push("config/bazarr");
  }

  for (const dir of dirs) {
    const fullPath = path.resolve(outputDir, dir);
    await mkdir(fullPath, { recursive: true });
  }
  log.success(`Created ${dirs.length} directories`);

  // Generate .env
  const envContent = generateEnv(answers);
  await writeFile(path.join(outputDir, ".env"), envContent, "utf-8");
  log.success("Generated .env");

  // Generate docker-compose.yml
  const composeContent = generateDockerCompose(answers);
  await writeFile(path.join(outputDir, "docker-compose.yml"), composeContent, "utf-8");
  log.success("Generated docker-compose.yml");

  // Pre-configure qBittorrent password
  const qbitConf = generateQbitConfig(answers.qbitPassword);
  const qbitConfPath = path.join(outputDir, "config", "qbittorrent", "qBittorrent", "qBittorrent.conf");
  await writeFile(qbitConfPath, qbitConf, "utf-8");
  log.success("Pre-configured qBittorrent password (PBKDF2 hash)");
}
