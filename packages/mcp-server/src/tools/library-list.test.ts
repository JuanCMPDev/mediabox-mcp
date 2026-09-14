/**
 * manage_files list is the "enumerate files" step of the agent's storage flow:
 * resolve the entity, list its files, propose exact paths. It must accept every
 * path form the other file tools accept (Jellyfin reports container paths,
 * inspect_format reports "media:" paths) and report canonical, exact paths.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// config.ts reads the roots at import time, so they are set before any import.
const roots = vi.hoisted(() => {
  const tmp = (process.env.TEMP || process.env.TMPDIR || process.env.TMP || "/tmp").replace(/\\/g, "/");
  const base = `${tmp}/mediabox-list-${process.pid}-${Date.now()}`;
  const previous = { media: process.env.MEDIA_PATH, downloads: process.env.DOWNLOADS_PATH };
  process.env.MEDIA_PATH = `${base}/media`;
  process.env.DOWNLOADS_PATH = `${base}/downloads`;
  return { base, media: `${base}/media`, downloads: `${base}/downloads`, previous };
});

vi.mock("../helpers/api.js", () => ({
  jfApi: vi.fn(), sonarrApi: vi.fn(), radarrApi: vi.fn(),
  textResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
}));
vi.mock("../helpers/pyload.js", () => ({ pyloadApi: vi.fn(), pyloadApiJson: vi.fn() }));

import { registerLibraryTools } from "./library.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function manageFiles(): Handler {
  const tools = new Map<string, Handler>();
  registerLibraryTools({ registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler) } as any);
  return tools.get("manage_files")!;
}

async function list(target?: string): Promise<any> {
  const result = await manageFiles()({ action: "list", ...(target === undefined ? {} : { path: target }) });
  return JSON.parse(result.content[0].text);
}

const SEASON = "tv/Serie Ñandú (2024)/Season 01";

beforeAll(async () => {
  await fs.mkdir(path.join(roots.media, SEASON, "Extras"), { recursive: true });
  await fs.writeFile(path.join(roots.media, SEASON, "Serie Ñandú - S01E02.mkv"), "x");
  await fs.writeFile(path.join(roots.media, SEASON, "Serie Ñandú - S01E01.mkv"), "x");
  await fs.mkdir(path.join(roots.downloads, "Paquete"), { recursive: true });
  await fs.writeFile(path.join(roots.downloads, "Paquete", "léeme.txt"), "x");
});

afterAll(async () => {
  await fs.rm(roots.base, { recursive: true, force: true });
  for (const [key, value] of [["MEDIA_PATH", roots.previous.media], ["DOWNLOADS_PATH", roots.previous.downloads]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("manage_files list", () => {
  it("lists one folder from every path form and reports sorted entries with canonical paths", async () => {
    const expected = {
      path: `media:${SEASON}`,
      items: [
        { name: "Extras", type: "dir", path: `media:${SEASON}/Extras` },
        { name: "Serie Ñandú - S01E01.mkv", type: "file", path: `media:${SEASON}/Serie Ñandú - S01E01.mkv` },
        { name: "Serie Ñandú - S01E02.mkv", type: "file", path: `media:${SEASON}/Serie Ñandú - S01E02.mkv` },
      ],
    };
    for (const form of [
      SEASON,
      `media:${SEASON}`,
      `/data/${SEASON}`,
      "/tv/Serie Ñandú (2024)/Season 01",
      `${roots.media}/${SEASON}`,
      SEASON.replace(/\//g, "\\"),
    ]) {
      expect(await list(form), form).toMatchObject(expected);
    }
  });

  it("lists both roots and the downloads namespace", async () => {
    expect(await list("downloads/")).toMatchObject({ path: "downloads:", items: [{ name: "Paquete", type: "dir", path: "downloads:Paquete" }] });
    expect(await list("downloads:Paquete")).toMatchObject({
      path: "downloads:Paquete",
      items: [{ name: "léeme.txt", type: "file", path: "downloads:Paquete/léeme.txt" }],
    });
    expect(await list()).toMatchObject({ path: "media:", items: [{ name: "tv", type: "dir", path: "media:tv" }] });
  });

  it("rejects traversal and paths outside both roots before listing", async () => {
    for (const bad of ["../etc", "media:../etc", "tv/../../etc", "/etc", "downloads/../../etc"]) {
      await expect(manageFiles()({ action: "list", path: bad }), bad).rejects.toThrow(/escapes/);
    }
  });
});
