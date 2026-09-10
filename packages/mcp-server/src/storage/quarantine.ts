import fs from "node:fs/promises";
import * as path from "node:path";
import { defaultRootFs } from "./rootfs.js";

const QUARANTINE_DIR_NAME = ".mediabox-trash";

export interface QuarantineManifest {
  originalPath: string;
  quarantinedAt: string;
  expiresAt: string;
  sizeBytes: number;
}

export async function quarantineFile(rootId: string, relativePath: string): Promise<QuarantineManifest> {
  const rootDir = defaultRootFs.getRootPath(rootId);
  const absoluteOriginal = await defaultRootFs.resolveWithinRoot(rootId, relativePath);
  
  const quarantineBase = path.join(rootDir, QUARANTINE_DIR_NAME);
  await fs.mkdir(quarantineBase, { recursive: true });

  const stat = await fs.stat(absoluteOriginal);
  const sizeBytes = stat.size;

  const timestamp = Date.now();
  const safeName = `${timestamp}-${path.basename(relativePath)}`;
  const absoluteQuarantine = path.join(quarantineBase, safeName);

  // Move the file into quarantine
  await fs.rename(absoluteOriginal, absoluteQuarantine);

  const manifest: QuarantineManifest = {
    originalPath: relativePath,
    quarantinedAt: new Date(timestamp).toISOString(),
    expiresAt: new Date(timestamp + 7 * 24 * 60 * 60 * 1000).toISOString(),
    sizeBytes,
  };

  const manifestPath = `${absoluteQuarantine}.manifest.json`;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return manifest;
}

export async function quarantineDirectoryIfEmpty(rootId: string, relativePath: string): Promise<boolean> {
  const absoluteOriginal = await defaultRootFs.resolveWithinRoot(rootId, relativePath);
  try {
    const files = await fs.readdir(absoluteOriginal);
    if (files.length === 0) {
      const quarantineBase = path.join(defaultRootFs.getRootPath(rootId), QUARANTINE_DIR_NAME);
      await fs.mkdir(quarantineBase, { recursive: true });
      const timestamp = Date.now();
      const safeName = `dir-${timestamp}-${path.basename(relativePath)}`;
      const absoluteQuarantine = path.join(quarantineBase, safeName);
      
      await fs.rename(absoluteOriginal, absoluteQuarantine);
      return true;
    }
    return false;
  } catch (err: any) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}
