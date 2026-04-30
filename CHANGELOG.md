# Changelog

All notable changes to Mediabox MCP are documented here. Versions follow
semver — major bumps signal breaking config or API surface changes.

## 2.2.0 — Security hardening

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
