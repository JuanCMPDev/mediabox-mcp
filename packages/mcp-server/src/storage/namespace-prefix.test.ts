/* ─── Root-prefixed paths (P11 finding) ───────────────────────────────────────
 * inspect_format and plan summaries report paths as "<root>:<relative>"; an
 * agent handing one back must reach the same file, and containment must still
 * hold for it.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from "vitest";
import { mapNamespace, PathMappingUnknownError } from "./namespace-map.js";

describe("mapNamespace accepts the tools' own <root>:<path> notation", () => {
  it("maps media: and downloads: prefixes to their roots", () => {
    expect(mapNamespace("media:tv/Serie Ñandú (2024)/Season 01/E01.mkv")).toEqual({
      rootId: "media",
      relativePath: "tv/Serie Ñandú (2024)/Season 01/E01.mkv",
    });
    expect(mapNamespace("downloads:Paquete Sin Ordenar/léeme.txt")).toEqual({
      rootId: "downloads",
      relativePath: "Paquete Sin Ordenar/léeme.txt",
    });
  });

  it("keeps plain relative paths and rejects an empty prefixed path", () => {
    expect(mapNamespace("tv/Show/E01.mkv")).toEqual({ rootId: "media", relativePath: "tv/Show/E01.mkv" });
    expect(() => mapNamespace("media:")).toThrow(PathMappingUnknownError);
  });

  it("does not treat an unknown prefix as a root", () => {
    expect(mapNamespace("secrets:etc/passwd")).toEqual({ rootId: "media", relativePath: "secrets:etc/passwd" });
  });
});
