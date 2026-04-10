import { XMLParser } from "fast-xml-parser";
import { readFile } from "node:fs/promises";

const parser = new XMLParser();

/**
 * Read an API key from a Sonarr/Radarr/Prowlarr config.xml file.
 * The XML structure is: <Config><ApiKey>...</ApiKey></Config>
 */
export async function readApiKeyFromConfig(filePath: string): Promise<string> {
  const xml = await readFile(filePath, "utf-8");
  const parsed = parser.parse(xml);
  const key = parsed?.Config?.ApiKey;
  if (!key || typeof key !== "string") {
    throw new Error(`No ApiKey found in ${filePath}`);
  }
  return key;
}

/**
 * Check if a config.xml file exists and contains an ApiKey.
 * Non-throwing — returns the key or null.
 */
export async function tryReadApiKey(filePath: string): Promise<string | null> {
  try {
    return await readApiKeyFromConfig(filePath);
  } catch {
    return null;
  }
}
