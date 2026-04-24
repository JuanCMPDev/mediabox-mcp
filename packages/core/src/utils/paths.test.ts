import { describe, it, expect } from "vitest";
import { toPosix, ensureRelative } from "./paths.js";

describe("toPosix", () => {
  it("converts Windows backslashes to forward slashes", () => {
    expect(toPosix("foo\\bar\\baz")).toBe("foo/bar/baz");
  });

  it("leaves POSIX paths untouched", () => {
    expect(toPosix("foo/bar")).toBe("foo/bar");
  });
});

describe("ensureRelative", () => {
  it("prepends ./ to bare relative paths", () => {
    expect(ensureRelative("media/movies")).toBe("./media/movies");
  });

  it("preserves ./ prefix", () => {
    expect(ensureRelative("./media/movies")).toBe("./media/movies");
  });

  it("preserves ../ prefix", () => {
    expect(ensureRelative("../media/movies")).toBe("../media/movies");
  });

  it("leaves absolute POSIX paths alone", () => {
    expect(ensureRelative("/mnt/media")).toBe("/mnt/media");
  });

  it("normalizes backslashes", () => {
    expect(ensureRelative("media\\movies")).toBe("./media/movies");
  });
});
