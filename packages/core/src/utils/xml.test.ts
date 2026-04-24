import { describe, it, expect } from "vitest";
import { parseApiKey, tryParseApiKey } from "./xml.js";

describe("parseApiKey", () => {
  it("extracts ApiKey from valid Sonarr/Radarr XML", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Config>
  <BindAddress>*</BindAddress>
  <Port>8989</Port>
  <ApiKey>abc123def456</ApiKey>
</Config>`;
    expect(parseApiKey(xml)).toBe("abc123def456");
  });

  it("throws when ApiKey is missing", () => {
    const xml = `<Config><Port>8989</Port></Config>`;
    expect(() => parseApiKey(xml)).toThrow("No ApiKey found");
  });

  it("throws on malformed XML", () => {
    expect(() => parseApiKey("<not xml")).toThrow();
  });

  it("throws when ApiKey is empty", () => {
    const xml = `<Config><ApiKey></ApiKey></Config>`;
    expect(() => parseApiKey(xml)).toThrow();
  });
});

describe("tryParseApiKey", () => {
  it("returns null when ApiKey is missing", () => {
    expect(tryParseApiKey("<Config/>")).toBeNull();
  });

  it("returns the key on success", () => {
    expect(tryParseApiKey(`<Config><ApiKey>xyz</ApiKey></Config>`)).toBe("xyz");
  });
});
