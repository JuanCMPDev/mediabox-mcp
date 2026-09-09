import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TestInstallation, EffectLedger } from "./test-installation.js";

describe("TestInstallation & EffectLedger (HAR-01, HAR-02, HAR-03)", () => {
  let installation: TestInstallation | null = null;

  afterEach(async () => {
    if (installation) {
      try {
        await installation.teardown();
      } catch {
        // teardown might fail deliberately in tests testing invalid markers
      }
      installation = null;
    }
  });

  it("HAR-01: all writes and deletes stay strictly within temporary root", async () => {
    installation = await TestInstallation.create({ prefix: "mediabox-har01-" });
    expect(path.isAbsolute(installation.rootDir)).toBe(true);

    // Verify root is inside os.tmpdir()
    const rel = path.relative(os.tmpdir(), installation.rootDir);
    expect(rel.startsWith("..")).toBe(false);

    // Write file
    const filePath = await installation.writeFile("sub/media.txt", "content");
    expect(await fs.readFile(filePath, "utf8")).toBe("content");

    // Resolve path outside root should throw and record violation
    expect(() => installation!.resolvePath("../escaped.txt")).toThrow(/escaped/i);
    expect(installation.ledger.hasViolations()).toBe(true);

    // Delete file
    await installation.deleteFile("sub/media.txt");
    await expect(fs.stat(filePath)).rejects.toThrow();

    // Check ledger recorded events
    const effects = installation.ledger.getEffects();
    expect(effects.some((e) => e.type === "write" && e.target === filePath)).toBe(true);
    expect(effects.some((e) => e.type === "delete" && e.target === filePath)).toBe(true);
  });

  it("HAR-02: invalid marker or missing marker blocks teardown and protects real directories", async () => {
    installation = await TestInstallation.create({ prefix: "mediabox-har02-" });

    // Corrupt marker secret
    await fs.writeFile(installation.markerPath, "tampered-secret", "utf8");

    await expect(installation.teardown()).rejects.toThrow(/Teardown aborted: marker secret mismatch/);

    // Ensure directory was NOT deleted
    const stat = await fs.stat(installation.rootDir);
    expect(stat.isDirectory()).toBe(true);

    // Restore correct marker so afterEach can clean it up
    await fs.writeFile(installation.markerPath, installation.markerSecret, "utf8");
    await installation.teardown();
    installation = null;
  });

  it("HAR-02: missing marker file completely blocks teardown", async () => {
    installation = await TestInstallation.create({ prefix: "mediabox-har02b-" });

    // Remove marker file
    await fs.rm(installation.markerPath, { force: true });

    await expect(installation.teardown()).rejects.toThrow(/Teardown aborted: marker file missing/);

    // Ensure directory was NOT deleted
    const stat = await fs.stat(installation.rootDir);
    expect(stat.isDirectory()).toBe(true);

    // Manually cleanup
    await fs.rm(installation.rootDir, { recursive: true, force: true });
    installation = null;
  });

  it("HAR-03: ledger detects unexpected mutation outside root and assertClean throws", () => {
    const tmpDir = path.resolve(os.tmpdir(), "allowed-root");
    const ledger = new EffectLedger([tmpDir]);

    // Legitimate write inside allowed root
    ledger.recordWrite(path.join(tmpDir, "file.txt"));
    expect(ledger.hasViolations()).toBe(false);
    expect(() => ledger.assertClean()).not.toThrow();

    // Dangerous write outside allowed root (e.g. system directory or personal media library)
    const dangerousPath = path.resolve(os.tmpdir(), "../other-folder/data.mp4");
    ledger.recordWrite(dangerousPath);

    expect(ledger.hasViolations()).toBe(true);
    expect(ledger.getViolations()[0]).toMatch(/targeted path outside allowed root/);
    expect(() => ledger.assertClean()).toThrow(/Ledger detected unexpected effects/);
  });

  it("InjectedClock provides deterministic time and advancement", async () => {
    installation = await TestInstallation.create({ initialTime: 1700000000000 });
    expect(installation.clock.now()).toBe(1700000000000);

    installation.clock.advance(5000);
    expect(installation.clock.now()).toBe(1700000005000);
    expect(installation.clock.date().getTime()).toBe(1700000005000);
  });

  it("FakeServicesRegistry tracks calls into EffectLedger", async () => {
    installation = await TestInstallation.create();
    installation.fakeServices.registerService("sonarr", {
      "GET /api/v3/series": [{ id: 1, title: "Mock Series" }],
    });

    const res = await installation.fakeServices.call("sonarr", "/api/v3/series", "GET");
    expect(res).toEqual([{ id: 1, title: "Mock Series" }]);

    const effects = installation.ledger.getEffects();
    expect(effects.some((e) => e.type === "api_call" && e.target === "sonarr:GET /api/v3/series")).toBe(true);
  });
});
