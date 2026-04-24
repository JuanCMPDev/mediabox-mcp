import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "package.json"), "utf-8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  bundle: true,
  clean: true,
  target: "node20",
  platform: "node",
  sourcemap: false,
  splitting: false,
  shims: true,
  // Inject createRequire so bundled CJS deps (yaml, fast-xml-parser)
  // can resolve Node built-ins (e.g. require("process")) in ESM output.
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`,
  },
  // Replace __MEDIABOX_CLI_VERSION__ with the CLI's package.json version
  // at build time. Source version.ts checks `typeof` so Vitest/source runs
  // fall back to reading package.json at runtime.
  define: {
    __MEDIABOX_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  // Bundle @mediabox/core (and everything else except Node built-ins) into
  // a single dist/index.js so `npm publish create-mediabox` produces a
  // self-contained tarball with no workspace-internal references.
  noExternal: [/@mediabox\/.+/],
});
