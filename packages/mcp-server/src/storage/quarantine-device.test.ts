/* ─── Quarantine on the file's own filesystem (P10 / NET-02 finding) ─────────
 * The generated Docker deployment mounts /data/movies, /data/tv … separately
 * under MEDIA_PATH=/data. A trash at /data/.mediabox-trash would sit on the
 * container layer and every library quarantine would fail as cross-device.
 * The trash is chosen per filesystem instead, and every lookup finds it.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRootFs } from "./rootfs.js";
import {
  quarantineBaseFor, locateQuarantineEntry, listQuarantine, quarantineFile, restoreQuarantined, isInternalPath,
  QUARANTINE_DIR_NAME,
} from "./quarantine.js";

describe("quarantineBaseFor", () => {
  const root = path.resolve("/data");
  const devices: Record<string, number> = {
    [root]: 10,
    [path.join(root, "movies")]: 20,
    [path.join(root, "movies", "Film (2019)")]: 20,
    [path.join(root, "tv")]: 30,
    [path.join(root, "tv", "Show")]: 30,
    [path.join(root, "tv", "Show", "Season 01")]: 30,
  };
  const statDev = async (p: string) => devices[path.resolve(p)];

  it("uses the root when the file lives on the root's filesystem", async () => {
    expect(await quarantineBaseFor(root, "loose.mkv", 10, statDev)).toBe("");
  });

  it("uses the top directory of the bind mount that holds the file", async () => {
    expect(await quarantineBaseFor(root, "movies/Film (2019)/Film.mkv", 20, statDev)).toBe("movies");
    expect(await quarantineBaseFor(root, "tv/Show/Season 01/E01.mkv", 30, statDev)).toBe("tv");
  });
});

describe("nested trash is found, listed, restored and internal", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mbx-quarantine-dev-"));
    defaultRootFs.resetForTesting();
    defaultRootFs.registerRoot("media", root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("handles an entry that lives under a mount's own trash", async () => {
    const rel = "movies/Film (2019)/Película ñ.mkv";
    const nested = path.join(root, "movies", QUARANTINE_DIR_NAME, "plan_1", ...rel.split("/"));
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "bytes");
    fs.writeFileSync(`${nested}.manifest.json`, JSON.stringify({
      schemaVersion: 1, rootId: "media", originalRelativePath: rel, planId: "plan_1",
      quarantinedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), sizeBytes: 5, nlink: 1,
      reclaimableOnPurgeBytes: 5, identity: {},
    }));

    expect(await locateQuarantineEntry("media", `plan_1/${rel}`)).toBe(`movies/${QUARANTINE_DIR_NAME}/plan_1/${rel}`);
    const listed = await listQuarantine("media");
    expect(listed.map((e) => e.entryPath)).toEqual([`plan_1/${rel}`]);
    expect(isInternalPath(`movies/${QUARANTINE_DIR_NAME}/plan_1/${rel}`)).toBe(true);

    await restoreQuarantined("media", `plan_1/${rel}`);
    expect(fs.readFileSync(path.join(root, ...rel.split("/")), "utf8")).toBe("bytes");
    expect(await locateQuarantineEntry("media", `plan_1/${rel}`)).toBeNull();
  });

  it("on a single filesystem keeps the root trash, as before", async () => {
    const rel = "tv/Show/E01.mkv";
    fs.mkdirSync(path.join(root, "tv", "Show"), { recursive: true });
    fs.writeFileSync(path.join(root, ...rel.split("/")), "episode");
    const res = await quarantineFile("media", rel, { planId: "plan_2" });
    expect(res.entryRelativePath).toBe(`${QUARANTINE_DIR_NAME}/plan_2/${rel}`);
    expect(await locateQuarantineEntry("media", res.entryPath)).toBe(res.entryRelativePath);
  });
});
