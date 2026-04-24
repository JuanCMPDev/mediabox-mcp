import { describe, it, expect } from "vitest";
import { generateQbittorrentConfig, qbitPasswordHash } from "./qbittorrent.js";

describe("qbitPasswordHash", () => {
  it("emits the @ByteArray(salt:hash) format", () => {
    const h = qbitPasswordHash("s3cret!!");
    expect(h).toMatch(/^@ByteArray\([^:]+:[^)]+\)$/);
  });

  it("produces different hashes for the same password (random salt)", () => {
    expect(qbitPasswordHash("x")).not.toBe(qbitPasswordHash("x"));
  });
});

describe("generateQbittorrentConfig", () => {
  it("embeds the hash quoted under Password_PBKDF2", () => {
    const conf = generateQbittorrentConfig("s3cret!!");
    expect(conf).toContain(`WebUI\\Password_PBKDF2="@ByteArray(`);
    expect(conf).toContain("WebUI\\Username=admin");
    expect(conf).toContain("WebUI\\Port=8085");
    expect(conf).toContain("Downloads\\SavePath=/downloads");
  });
});
