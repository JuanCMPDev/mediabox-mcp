import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser();

/**
 * Parse an XML string and return the ApiKey field from <Config><ApiKey>...
 * Throws if the XML is malformed or no ApiKey is present.
 */
export function parseApiKey(xml: string): string {
  const parsed = parser.parse(xml);
  const key = parsed?.Config?.ApiKey;
  if (!key || typeof key !== "string") {
    throw new Error("No ApiKey found in XML");
  }
  return key;
}

/**
 * Non-throwing variant — returns the key or null on any failure.
 */
export function tryParseApiKey(xml: string): string | null {
  try {
    return parseApiKey(xml);
  } catch {
    return null;
  }
}
