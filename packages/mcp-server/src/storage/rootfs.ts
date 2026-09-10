import { stat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { PlannedTargetFileIdentity } from "@mediabox/contracts";

export class RootFs {
  private roots: Map<string, string> = new Map();

  registerRoot(rootId: string, absolutePath: string): void {
    this.roots.set(rootId, path.resolve(absolutePath));
  }

  getRootPath(rootId: string): string {
    const rootPath = this.roots.get(rootId);
    if (!rootPath) {
      throw new Error(`Root not registered: ${rootId}`);
    }
    return rootPath;
  }

  async resolveWithinRoot(rootId: string, relativePath: string): Promise<string> {
    const rootDir = this.getRootPath(rootId);
    
    // Normalize and prevent path traversal upwards
    const safeRelative = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const absolutePath = path.resolve(rootDir, safeRelative);
    
    if (!absolutePath.startsWith(rootDir)) {
      throw new Error(`Path escapes root: ${relativePath}`);
    }

    await this.ensureNotSymlinkOrEscape(absolutePath, rootDir);

    return absolutePath;
  }

  async ensureNotSymlinkOrEscape(absolutePath: string, rootDir: string): Promise<void> {
    try {
      const resolvedPath = await realpath(absolutePath);
      if (!resolvedPath.startsWith(rootDir)) {
        throw new Error(`Path escapes root via symlink: ${absolutePath}`);
      }
    } catch (err: any) {
      // If the file/folder doesn't exist yet, we check its parent
      if (err.code === "ENOENT") {
        const parent = path.dirname(absolutePath);
        if (parent !== absolutePath && parent.length >= rootDir.length) {
          await this.ensureNotSymlinkOrEscape(parent, rootDir);
        }
      } else {
        throw err;
      }
    }
  }

  async getFileIdentity(absolutePath: string): Promise<PlannedTargetFileIdentity> {
    const s = await stat(absolutePath);
    return {
      sizeBytes: s.size,
      mtimeMs: s.mtimeMs,
      inode: s.ino,
    };
  }

  async computeSha256(absolutePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = createReadStream(absolutePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  async verifyIdentity(absolutePath: string, expected: PlannedTargetFileIdentity): Promise<boolean> {
    try {
      const current = await this.getFileIdentity(absolutePath);
      if (expected.sizeBytes !== undefined && current.sizeBytes !== expected.sizeBytes) return false;
      if (expected.inode !== undefined && current.inode !== expected.inode) return false;
      // We might tolerate small mtime drift or require exact match. For now exact match or within 1000ms
      if (expected.mtimeMs !== undefined && Math.abs(current.mtimeMs! - expected.mtimeMs!) > 1000) return false;
      
      if (expected.sha256) {
        const currentHash = await this.computeSha256(absolutePath);
        if (currentHash !== expected.sha256) return false;
      }
      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }
}

export const defaultRootFs = new RootFs();
