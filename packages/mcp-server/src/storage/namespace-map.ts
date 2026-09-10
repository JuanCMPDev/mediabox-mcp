import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";
import { defaultRootFs } from "./rootfs.js";

// Register default roots
defaultRootFs.registerRoot("media", MEDIA_PATH);
defaultRootFs.registerRoot("downloads", DOWNLOADS_PATH);

export interface NamespaceMapping {
  rootId: string;
  relativePath: string;
}

export function mapNamespace(logicalPath: string): NamespaceMapping {
  // e.g. "tv/Show" -> { rootId: "media", relativePath: "tv/Show" }
  // e.g. "downloads/Movie" -> { rootId: "downloads", relativePath: "Movie" }
  
  if (logicalPath.startsWith("downloads/") || logicalPath === "downloads") {
    return {
      rootId: "downloads",
      relativePath: logicalPath.startsWith("downloads/") ? logicalPath.slice(10) : "",
    };
  }

  // Everything else defaults to media root
  return {
    rootId: "media",
    relativePath: logicalPath,
  };
}

export async function resolveNamespacePath(logicalPath: string): Promise<string> {
  const { rootId, relativePath } = mapNamespace(logicalPath);
  return defaultRootFs.resolveWithinRoot(rootId, relativePath);
}
