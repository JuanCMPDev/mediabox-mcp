import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveDeployPath } from "./docker-cli.js";

describe("resolveDeployPath", () => {
  it("anchors relative paths inside the stack workdir", () => {
    expect(resolveDeployPath("/srv/mediabox", "config/jellyfin")).toBe(
      path.join("/srv/mediabox", "config/jellyfin"),
    );
  });

  it("preserves absolute POSIX paths", () => {
    expect(resolveDeployPath("/srv/mediabox", "/mnt/media/movies")).toBe(
      "/mnt/media/movies",
    );
  });

  it("preserves platform-absolute paths", () => {
    const absolute = path.resolve("media", "movies");
    expect(resolveDeployPath("/srv/mediabox", absolute)).toBe(absolute);
  });
});
