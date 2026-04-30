import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveSafePath, assertSafeSegment, PathSandboxError, type SandboxRoots } from "./sandbox.js";

// Use path.resolve so the tests work both on POSIX (/data) and Windows (C:\data).
const ROOTS: SandboxRoots = {
  media: path.resolve("/data"),
  downloads: path.resolve("/downloads"),
};

const MEDIA = path.resolve("/data");
const DOWN = path.resolve("/downloads");

describe("resolveSafePath", () => {
  describe("relative inputs default to media root", () => {
    it("resolves a simple subpath", () => {
      const { full, root } = resolveSafePath("anime/Show", ROOTS);
      expect(full).toBe(path.join(MEDIA, "anime", "Show"));
      expect(root).toBe("media");
    });

    it("resolves a single-segment subpath", () => {
      expect(resolveSafePath("movies", ROOTS).full).toBe(path.join(MEDIA, "movies"));
    });

    it("handles spaces and unicode in names", () => {
      const { full } = resolveSafePath("anime/Café — Édition (2024)", ROOTS);
      expect(full).toBe(path.join(MEDIA, "anime", "Café — Édition (2024)"));
    });
  });

  describe("downloads/ prefix routes to downloads root", () => {
    it("strips the prefix", () => {
      expect(resolveSafePath("downloads/foo", ROOTS)).toEqual({
        full: path.join(DOWN, "foo"),
        root: "downloads",
      });
    });

    it("accepts the bare 'downloads' string", () => {
      expect(resolveSafePath("downloads", ROOTS)).toEqual({
        full: DOWN,
        root: "downloads",
      });
    });

    it("rejects traversal even via downloads/", () => {
      expect(() => resolveSafePath("downloads/../media/foo", ROOTS)).toThrow(PathSandboxError);
    });
  });

  describe("absolute paths under a known root", () => {
    it("accepts absolute media paths", () => {
      const input = path.join(MEDIA, "anime", "Show");
      expect(resolveSafePath(input, ROOTS)).toEqual({ full: input, root: "media" });
    });

    it("accepts absolute downloads paths", () => {
      const input = path.join(DOWN, "foo");
      expect(resolveSafePath(input, ROOTS)).toEqual({ full: input, root: "downloads" });
    });

    it("accepts the media root itself", () => {
      expect(resolveSafePath(MEDIA, ROOTS)).toEqual({ full: MEDIA, root: "media" });
    });
  });

  describe("traversal attempts", () => {
    it("rejects ../etc/passwd", () => {
      expect(() => resolveSafePath("../etc/passwd", ROOTS)).toThrow(PathSandboxError);
    });

    it("rejects nested traversal anime/../../etc/passwd", () => {
      expect(() => resolveSafePath("anime/../../etc/passwd", ROOTS)).toThrow(PathSandboxError);
    });

    it("rejects absolute path outside both roots", () => {
      expect(() => resolveSafePath(path.resolve("/etc/passwd"), ROOTS)).toThrow(PathSandboxError);
    });

    it("rejects absolute path that looks rooted but escapes via ..", () => {
      const input = path.join(MEDIA, "..", "etc", "passwd");
      expect(() => resolveSafePath(input, ROOTS)).toThrow(PathSandboxError);
    });

    it("rejects sibling root access (path equal to a sibling of media)", () => {
      const input = path.resolve(path.dirname(MEDIA), "evil");
      expect(() => resolveSafePath(input, ROOTS)).toThrow(PathSandboxError);
    });
  });

  describe("malformed input", () => {
    it("rejects empty string", () => {
      expect(() => resolveSafePath("", ROOTS)).toThrow(PathSandboxError);
    });

    it("rejects non-string", () => {
      // @ts-expect-error testing runtime coercion
      expect(() => resolveSafePath(undefined, ROOTS)).toThrow(PathSandboxError);
      // @ts-expect-error testing runtime coercion
      expect(() => resolveSafePath(123, ROOTS)).toThrow(PathSandboxError);
    });

    it("rejects NUL byte injection", () => {
      expect(() => resolveSafePath("anime\0/etc/passwd", ROOTS)).toThrow(PathSandboxError);
    });
  });

  describe("when MEDIA and DOWNLOADS share a parent", () => {
    const NESTED: SandboxRoots = {
      media: path.resolve("/srv/media"),
      downloads: path.resolve("/srv/downloads"),
    };
    it("downloads prefix still routes to downloads", () => {
      expect(resolveSafePath("downloads/x", NESTED).root).toBe("downloads");
    });
    it("media-rooted absolute does not leak into downloads", () => {
      const input = path.join(NESTED.media, "anime");
      expect(resolveSafePath(input, NESTED).root).toBe("media");
    });
  });
});

describe("assertSafeSegment", () => {
  it.each(["foo", "Pet Sematary (1989)", "Café"])("accepts %s", (s) => {
    expect(assertSafeSegment(s)).toBe(s);
  });

  it.each(["../foo", "foo/bar", "foo\\bar", "..", ".", "", "foo\0bar", "foo\nbar"])(
    "rejects %s",
    (s) => {
      expect(() => assertSafeSegment(s)).toThrow(/Unsafe path segment/);
    },
  );

  it("rejects non-string", () => {
    // @ts-expect-error
    expect(() => assertSafeSegment(undefined)).toThrow();
    // @ts-expect-error
    expect(() => assertSafeSegment(null)).toThrow();
  });
});
