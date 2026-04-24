// VERSION is injected at bundle time by tsup via `define`. For source-mode
// execution (e.g. Vitest), we fall back to reading the package.json.
declare const __MEDIABOX_CLI_VERSION__: string;

export const VERSION: string =
  typeof __MEDIABOX_CLI_VERSION__ !== "undefined"
    ? __MEDIABOX_CLI_VERSION__
    : readPackageVersion();

function readPackageVersion(): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  const { dirname, join } = require("node:path") as typeof import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "..", "package.json");
  return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;
}
