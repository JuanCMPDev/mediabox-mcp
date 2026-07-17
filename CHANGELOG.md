# Changelog

All notable changes to Mediabox MCP are documented here. Versions follow
semver — major bumps signal breaking config or API surface changes.

## 2.2.0-beta.3 — Docker image build hotfix (2026-07-17)

Same-content follow-up to beta.2: the multi-arch image publish failed
because the ffmpeg static build was fetched from `johnvansickle.com`, which
began returning HTTP 415 to CI/datacenter clients. The beta.2 Desktop app
released fine; only the GHCR images were affected.

### Changed

- `packages/mcp-server/Dockerfile` now installs `ffmpeg` (and `ffprobe`)
  from Debian via `apt` instead of downloading a static tarball. This
  removes the fragile external dependency entirely — the download that
  broke the publish no longer exists. The runtime image is somewhat larger
  and ships Debian's ffmpeg 5.1, which covers the tool's needs
  (`optimize_media`, `fix_subtitles`, `ffprobe`).

No application code changed from beta.2; if you already run the beta.2
Desktop app, no action is needed.

## 2.2.0-beta.2 — Audit blockers + dependency remediation (2026-07-16)

Closes the four blocking findings from the follow-up audit and clears the
accumulated npm audit advisories. Most deployments need no change; see
[MIGRATION.md](MIGRATION.md) if you run a hand-rolled Docker compose.

### Breaking changes

- **`BIND_HOST` now defaults to `127.0.0.1`** (was `0.0.0.0`), so a bare
  host run (`node`/`tsx`/dev, the compiled Tauri sidecar) is not exposed to
  the LAN. Container runs are unaffected: the mcp-server Dockerfile sets
  `ENV BIND_HOST=0.0.0.0` and both the generated and root
  `docker-compose.yml` emit it. Only a custom compose or bare `docker run`
  that does not set `BIND_HOST` is affected — it now binds loopback-only and
  is unreachable via port mapping. Fix: add `BIND_HOST=0.0.0.0` to that
  container's environment.

### Fixed

- **Chat no longer breaks with `LLM_PROVIDER=google`.** The generators write
  `google` (matching the config), but the runtime only recognized `gemini`,
  so Gemini deployments crash-looped the Telegram bot and disabled the
  in-app chat. `google` is now accepted as an alias for `gemini`.
- **`manage_library(action:"create")` is sandboxed.** The library folder was
  passed to `fs.mkdir` and Jellyfin with no traversal check — the only file
  tool that skipped it. Out-of-root paths now throw `PathSandboxError`.
- **`INTERNAL_API_KEY` is compared in constant time**
  (`crypto.timingSafeEqual`), removing a timing side channel on the shared
  secret.

### Changed

- The `create-mediabox` wizard now requires at least one numeric Telegram
  user ID when the bot is enabled (the prompt previously defaulted to
  "empty = all", and the bot can delete media). The server runtime is
  unchanged.
- **Dependencies:** `npm audit fix` cleared all production advisories, and
  `@mediabox/ui` moved to Vite 8 / `@vitejs/plugin-react` 6 to clear the
  dev-server esbuild findings. `npm audit --omit=dev --audit-level=high` now
  reports 0 vulnerabilities.
- CI: the Security Audit job is scoped to production dependencies
  (`--omit=dev`) and blocks on production high/critical advisories.

## 2.2.0-beta.1 — Server-status hotfix (2026-04-30)

Same-day hotfix for the chat tool surface and dashboard widgets when the
mcp-server runs as the Tauri sidecar on a non-Linux host.

- Cross-platform CPU and disk metrics (`fs.statfs` + `os.cpus()` tick
  deltas) so the server-status widget shows real values on Windows hosts
  instead of always reporting 0% (`os.loadavg` returns `[0,0,0]` and `df`
  is missing on Windows).
- Per-library Jellyfin counts via `/Items?…&EnableTotalRecordCount` per
  type — the previous `/Items/Counts?ParentId=…` call was returning global
  totals on Jellyfin 10.11.8, so every library showed identical numbers.
- Gemini provider deduplicates repeated `functionCall` parts by
  `(name, args)` so a single logical action stops rendering N tool chips
  when the model re-emits or hallucinates parallel calls.
- Intent-aware chat tool selection (with bare-confirmation history
  handling) trims the per-turn tool surface, replacing the previous
  always-all-tools approach. Covered by new tests in `tool-selector.test.ts`.

## 2.2.0-beta.0 — Security hardening (2026-04-30)

Closes the audit's P0 and P1 findings: path traversal, DNS-rebinding
exposure, SSRF in download flows, broken Docker distribution, and the
prompt-only confirmation of destructive tools. See [MIGRATION.md](MIGRATION.md)
for remediation steps; most deployments do not need any change.

### Breaking changes

- **Path inputs containing `..` now throw `PathSandboxError`** in
  `manage_files`, `rename_episodes`, `fix_subtitles`, `optimize_media`,
  `series_import`, `movie_import`, `download_status(action:"organize")` and
  `download_direct`. Legitimate paths under `MEDIA_PATH` or `DOWNLOADS_PATH`
  are unaffected. (P0.1)
- **Browser requests whose `Origin` is not in the allowlist now get 403** on
  `/mcp`, `/api/dashboard`, `/api/chat` and `/api/setup`. The default
  allowlist is the localhost regex + the three Tauri webview origins; the
  generated Docker compose seeds `ALLOWED_ORIGINS` from `MCP_PUBLIC_URL`.
  Non-browser callers (Telegram bot, Claude Desktop, custom MCP clients,
  `curl`) do not send `Origin` and remain unaffected. (P0.2)
- **Destructive tools require a server-issued confirm token.** First call
  to `manage_files(action:"delete")`, `cleanup_server(dryRun:false)` and
  `optimize_media(action:"optimize")` returns
  `{ requiresConfirmation: true, confirmToken, preview, message }`; pass
  the token back with identical args to execute. Tokens are single-use,
  payload-bound, and expire in 5 minutes. (P1.2)

### Added

- `BIND_HOST` env var (default `0.0.0.0`). The Tauri sidecar overrides
  this to `127.0.0.1` automatically. (P0.2)
- `ALLOWED_ORIGINS` env var (comma-separated, additive to localhost +
  Tauri defaults). (P0.2)
- URL allowlist on `download_add` and `download_direct`: rejects
  `file://` / `ftp://` / `data:` / `javascript:` schemes and IP literals
  in private / loopback / link-local / RFC1918 / CGNAT / IPv6-ULA ranges
  (notably `169.254.169.254`). `download_add` additionally resolves the
  hostname and rejects if any resolved address is private. (P1.1)
- `.github/workflows/docker-publish.yml` — multi-arch (amd64 + arm64)
  GHCR publish on every `v*` tag. Image tags emitted: `:latest`,
  `:<semver>`, `:<major.minor>`, `:sha-<commit>`. (P0.3)
- `.github/workflows/ci.yml#docker-build` — PR-time smoke test that
  builds both Dockerfiles and verifies `mcp-server` responds on
  `/health`. (P0.3)
- Vitest harness in `@mediabox/mcp-server` and `@mediabox/chat-core`.
  `npm test` from the repo root now runs all four packages. Test count
  rose from 61 to 207.
- Security helpers under `packages/mcp-server/src/helpers/`: `sandbox.ts`,
  `url-allowlist.ts`, `origin.ts`, `confirm-tokens.ts`.

### Changed

- `packages/mcp-server/Dockerfile` rebuilt as a multi-stage monorepo build
  (Node 22, builder compiles the four required workspaces in dependency
  order, runtime keeps the monorepo layout under `/repo` so workspace
  symlinks in `node_modules/@mediabox/*` resolve correctly). Pre-2.2
  silently failed against the workspace deps. (P0.3)
- `packages/mcp-telegram-client/Dockerfile` — same monorepo treatment.
  (P0.3)
- `packages/core/src/generators/docker-compose.ts` emits
  `ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-${MCP_PUBLIC_URL}}` in the
  `mcp-server` env list, and switches `localBuild` to
  `{ context: ".", dockerfile: "packages/mcp-server/Dockerfile" }` to
  match the new Dockerfile. (P0.2 + P0.3)
- Root `docker-compose.yml` uses the same monorepo build context.
- Tauri sidecar spawn (`packages/desktop/src-tauri/src/sidecar.rs`)
  injects `BIND_HOST=127.0.0.1` and an `ALLOWED_ORIGINS` value scoped to
  the three Tauri webview origins.
- System prompt core principle #2 rewritten to teach the LLM the
  two-step destructive flow (preview → user confirmation → apply with
  token). The prompt is documentation now; the server enforces.

### Release coordination

The manual `npm publish create-mediabox` step must run **after**
`docker-publish.yml` completes for the same tag — the generated compose
pins `IMAGE_TAG` to the GHCR tag this workflow pushes. Sequence at
release time:

1. Push tag `v2.2.0`
2. Wait for both `release.yml` (Tauri) and `docker-publish.yml` (GHCR)
   to go green
3. Confirm published packages are public via GitHub Settings → Packages
   (one-time; subsequent pushes inherit visibility)
4. `npm publish` `create-mediabox` from `packages/mediabox-cli/`
