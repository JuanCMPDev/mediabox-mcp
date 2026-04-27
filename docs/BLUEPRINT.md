# Mediabox OS: Architecture & Technical Blueprint

## 1. Vision Statement
Evolve **Mediabox** from a sysadmin-focused CLI tool into **Mediabox OS**, the definitive "Home Media Operating System." 
The goal is to provide a zero-friction desktop application (built on Tauri) that visually orchestrates the entire self-hosted stack (Jellyfin, Sonarr, Radarr, qBittorrent, PyLoad) while deeply integrating a private AI assistant (MCP) accessible both via the desktop dashboard and a mobile Telegram bot.

Key value propositions:
1. **Zero-Friction Setup:** A beautiful visual installer replacing CLI prompts.
2. **Unified Dashboard:** One interface to monitor storage, combined download queues, and the media library.
3. **Omnichannel AI:** Manage the server via natural language natively in the UI or remotely via Telegram.
4. **Privacy-First:** Native support for local LLMs (Ollama) to ensure media habits remain entirely offline.

---

## 2. Target Architecture (Monorepo)

To achieve this without duplicating logic, we will restructure the monorepo into modular, headless packages:

*   **`@mediabox/core` (New):** The headless orchestration engine. Extracts the Docker generation and Jellyfin configuration logic out of `mediabox-cli`. It handles the raw API calls without assuming a terminal environment.
*   **`@mediabox/mcp` (Existing `mcp-server`):** The AI brain. Exposes tools to interact with the media stack.
*   **`@mediabox/telegram` (Existing `mcp-telegram-client`):** The remote control.
*   **`@mediabox/ui` (New):** A Single Page Application (React/Next.js + Vanilla CSS) serving as the visual dashboard and chat interface.
*   **`@mediabox/desktop` (New):** The Tauri wrapper (Rust/Webview). It bundles `@mediabox/core` and `@mediabox/ui` into native `.exe`/`.dmg`/`.AppImage` binaries.

---

## 3. Phased PR Execution Plan

This roadmap breaks down the vision into manageable, strictly scoped Pull Requests (PRs).

### Phase 1: Core Decoupling (The Engine)
*Objective: Separate presentation (inquirer prompts) from business logic to allow a web/desktop UI to trigger the setup process.*

*   **PR 1.1: Extract Orchestrator to `@mediabox/core`** ✅ **COMPLETED** (2026-04-23, `2.1.0-beta.0`)
    *   **Scope:** Move the Docker Compose generation (`generator.ts`), configuration logic (`configurator.ts`), and Jellyfin API setup (`services/jellyfin.ts`) into a new package (`packages/core`).
    *   **Requirements:** The core must export a clean asynchronous API (e.g., `async function deployStack(config: Config): Promise<Result>`). It must not depend on `chalk`, `ora`, or `@inquirer`.
    *   **Outcome:** Monorepo restructured under `packages/*` with npm workspaces. `@mediabox/core` exposes `deployStack()` + pure generators + event-stream `DeployEvent` model + `Deployer` interface. Introduced normalized `DeployConfig` domain type (replaces UI-shaped `WizardAnswers` at the core boundary). 58 Vitest tests across generators, utilities, validator, and translator. Zero dependencies on `chalk`/`ora`/`@inquirer` in core.
*   **PR 1.2: Refactor `mediabox-cli` to consume `@mediabox/core`** ✅ **COMPLETED** (folded into PR 1.1)
    *   **Scope:** Update the existing CLI wizard to import and call the new `@mediabox/core` API.
    *   **Requirements:** The CLI must function exactly as before, acting merely as a terminal frontend for the Core.
    *   **Outcome:** `create-mediabox` is now a thin frontend: `wizard → translate → validate → deployStack`. `DockerCliDeployer` implements the `Deployer` interface via `execa` + `node:fs`. `createCliEventSink()` maps `DeployEvent` → `ora` spinners / `chalk` lines with phase-header detection. tsup bundles `@mediabox/core` into a single 442 KB ESM file — tarball ships clean at 98 kB with no workspace references.

### Phase 2: Web Dashboard Foundation (The UI) ✅ **COMPLETED** (2026-04-24)
*Objective: Build the visual layer that will eventually live inside the desktop app.*

*   **PR 2.1: Initialize `@mediabox/ui` and Dashboard Layout** ✅ **COMPLETED**
    *   **Scope:** Scaffold a React application (prefer Vanilla CSS for lightweight performance). Create the main layout: Sidebar (Status, Library, Settings) and Main Content Area.
    *   **Requirements:** Must be completely decoupled from the backend initially (use mock data for disk space, active sessions, and queues).
    *   **Outcome:** `@mediabox/ui` scaffolded with Vite 5 + React 18 + Vanilla CSS Modules. Glassmorphism design system fully implemented from `docs/design.md` (all tokens as CSS vars, 3-level elevation, atmospheric background with animated orbs). Atomic components (GlassCard, GlassButton, GlassInput, SegmentedControl, IconButton). AppShell with TopBar + Sidebar + ServiceDock. 4 dashboard widgets (NowPlaying, ServerHealth, DownloadQueue, LibrarySummary). Chat panel with mock typewriter simulation. Tauri-ready (drag regions, hidden scrollbars, no text selection).
*   **PR 2.2: Connect UI to MCP Server** ✅ **COMPLETED**
    *   **Scope:** Implement API calls from the UI to the local `mcp-server` (or the underlying services) to replace mock data with real-time server telemetry.
    *   **Requirements:** Display unified download progress (qBit + PyLoad) and real disk usage.
    *   **Outcome:** New `@mediabox/contracts` package for wire-format types. `mcp-server` exposes `/api/dashboard/*` REST endpoints (health, sessions, downloads, library, services) sharing logic with MCP tools via `fetchers/`. Auth via `INTERNAL_API_KEY` bearer. UI consumes with React Query (polling: 2s downloads, 3s sessions, 5s health, 15s services, 60s library). All widgets handle loading/error states with glass skeleton shimmer. `ServiceDock` status pings 7 services (Jellyfin/Sonarr/Radarr/Prowlarr/qBit/PyLoad/FlareSolverr + optional Bazarr).
*   **PR 2.2.5: Admin Actions** ✅ **COMPLETED**
    *   **Scope:** Write endpoints for session/download administration from the dashboard.
    *   **Outcome:** `POST /sessions/:id/stop`, `POST /sessions/:id/message`, `POST /downloads/qbit/:hash/{pause,resume}`, `DELETE /downloads/qbit/:hash`. Glass toast system (success/error/info, auto-dismiss 3.5s). NowPlayingWidget with inline admin panel (Info / Kill Stream confirmation / Send Message form). DownloadQueue items with pause/resume/delete actions and inline delete confirmation (with/without files).
*   **PR 2.3: Native MCP Chat Interface** ✅ **COMPLETED**
    *   **Scope:** Build a chat component in the UI that communicates with the LLM and the local MCP server, mirroring the Telegram experience but natively in the browser.
    *   **Outcome:** New `@mediabox/chat-core` package extracts LLM + MCP tool-calling engine (system prompt, 8 virtual tools, keyword-based tool selection, provider abstraction for OpenRouter + Gemini, streaming tool-call loop, unified ChatMessage history). `mcp-server` adds `POST /api/chat/stream` (NDJSON over fetch), `GET /api/chat/info`, `GET /api/chat/:id/history`, `DELETE /api/chat/:id`. Loopback MCP client connects to its own `/mcp` endpoint. UI has `useChat` hook with streaming state + localStorage conversation rehidration, `ActiveToolChip` (animated pill while tool runs), typewriter cursor on streaming bubbles, inline Clear confirmation. As part of 2.3e, the Telegram bot was refactored to consume `@mediabox/chat-core` (1406 → 227 lines, -83.9%) — zero duplication with the browser chat.

### Phase 3: The Tauri Desktop App (The Shell)
*Objective: Wrap the UI and Core into a distributable desktop application.*

*   **PR 3.1: Initialize Tauri Project (`@mediabox/desktop`)** ✅ **COMPLETED** (2026-04-26)
    *   **Scope:** Setup the Tauri skeleton using `@mediabox/ui` as the frontend.
    *   **Requirements:** Ensure cross-platform build targets (Windows, macOS, Linux) are configured.
    *   **Outcome:** New `@mediabox/desktop` package wrapping the UI as a Tauri 2.10 app. The bundled `mcp-server` ships as a sidecar binary compiled via `bun build --compile` (114 MB self-contained, no Node runtime dependency on host). Rust `setup()` picks a random free TCP port + 48-char alphanumeric token, spawns the sidecar with `PORT`/`INTERNAL_API_KEY`/`PUBLIC_URL` env, watches stdout, and flips `RuntimeConfig.ready = true` once Express logs "running on port". A single `get_runtime_config` Tauri command exposes `{ apiUrl, internalApiKey, ready }` to the webview. New `BootGate` component withholds the React tree until the runtime config resolves (Tauri command poll under shell, env-var fallback in browser dev). `@mediabox/ui`'s `lib/api.ts` and `lib/chat-stream.ts` were refactored from build-time `import.meta.env.VITE_*` capture to lazy `getRuntimeConfig()` reads, so the same SPA bundle runs identically in both Tauri and browser dev. `version.ts` migrated from `readFileSync(package.json)` to `import pkg from "../package.json" with { type: "json" }` so `bun --compile` can inline it; bumped engines `>=22` and mcp-server's `tsconfig#module` to `NodeNext`. Bundle targets configured for Windows (msi, nsis), macOS (dmg), Linux (appimage, deb). Root scripts: `npm run dev:desktop` (sidecar build → vite dev → tauri dev) and `npm run build:desktop` (ui:build → sidecar:build → bundle:desktop). Smoke tests passed: cargo check, sidecar boot + auth bearer 401/200 round-trip, full monorepo build (49+9 vitest specs), and the workspace `build` sweep correctly skips desktop (since its top-level script is `bundle`, not `build`) so existing CI doesn't regress.
*   **PR 3.2: Visual Setup Wizard + Settings Admin (Desktop)** ✅ **COMPLETED** (2026-04-26)
    *   **Scope:** First-launch wizard that collects user preferences and deploys the stack via the bundled sidecar; live Settings panel that allows editing AI/Telegram/passwords without re-running the wizard.
    *   **Requirements:** Visual progress bars during Docker pulling and Jellyfin configuration, plus runtime-editable config so users don't have to hand-edit `.env`.
    *   **Outcome:**
        *   **De-risk first:** moved `DockerCliDeployer` from `mediabox-cli` to `@mediabox/core` so both the CLI and the desktop sidecar consume the same implementation. Smoke-tested execa under `bun --compile` (Windows + Bun 1.3.12, runtime-bundled binary spawns child processes, captures stdout, propagates exit codes) — confirmed feasible before touching UI.
        *   **Wizard backend:** Rust commands `check_docker`, `get_app_state` / `set_app_state` / `reset_app_state`, `default_stack_dir`, `pick_directory` (dialog plugin). New `/api/setup/start` endpoint streams `DeployEvent`s as NDJSON via a queue+`setImmediate` pump (also patched `/api/chat/stream` which had the same `req.on('close')` bug — express.json() consumes the body before the first event leaves the handler, killing the stream silently).
        *   **`DeployConfig` / `DeployEvent` / `SetupInfo` / `EnvUpdate*` / `RestartServices*` types** all live in `@mediabox/contracts` as the single source of truth — `@mediabox/core` re-exports for backward compat with CLI consumers.
        *   **Wizard UI:** 8-step flow (Pre-flight → Despliegue → Sistema → Rutas → Servicios → AI → Telegram → Review+Deploy) using existing Glass primitives (`GlassCard`/`GlassInput`/`SegmentedControl`). Drafts persist to `localStorage:mediabox:wizard-draft-v1` so reloads don't lose progress. `<DeployProgress>` modal renders the live NDJSON stream with phase-keyed labels in Spanish. On finish: `setAppState` → `restart_sidecar` → `reloadRuntimeConfig` → `clear()` → switch to dashboard, all in a single click.
        *   **Sidecar env-forwarding:** the sidecar runs on the host (not inside Docker), so the default `http://jellyfin:8096`-style URLs from `mcp-server/src/config.ts` are unresolvable. Rust `sidecar.rs` now reads `<stackDir>/.env` and forwards `JELLYFIN_API_KEY`/`SONARR_API_KEY`/`RADARR_API_KEY`/`PROWLARR_API_KEY`/`QBIT_*`/`PYLOAD_*`/`OPENROUTER_*`/`GOOGLE_AI_*` etc. as env vars to the spawned binary, plus overrides every `*_URL` to `http://localhost:<host-port>`. Also passes `STACK_DIR` so admin endpoints can edit the right `.env`.
        *   **Window controls:** `closeWindow`/`minimizeWindow`/`toggleMaximize` wired to macOS-style traffic lights via `@tauri-apps/api/window`. Capabilities `core:window:allow-{close,minimize,toggle-maximize,start-dragging}` + `data-tauri-drag-region` on TopBar so the user can drag from the title.
        *   **External links:** `ServiceDock` and Settings open service URLs via `@tauri-apps/plugin-shell.open()` (with browser fallback `window.open()` for vite dev).
        *   **Settings panel — Tier A admin:** new sidecar endpoints `GET /api/setup/info` (sanitised view, `hasX:bool` flags, never ships secrets), `GET /api/setup/env-raw` (raw `.env` for masked display), `PATCH /api/setup/env` (atomic write with `updateEnvKeys`, allowlist-gated, returns containers needing restart), `POST /api/setup/restart-services` (per-svc `docker compose restart`), `POST /api/setup/stack/{restart,stop,start}`. Editable sections: AI provider + key + model · Telegram token + allowed users · qBit/PyLoad passwords (re-generates `qBittorrent.conf` PBKDF2 hash via `@mediabox/core`'s `generateQbittorrentConfig` automatically). Read-only sections: Stack overview, Services live status (with badges for `API key`/`password` configured), System info. Actions: Stop/Start/Restart all containers (with native Tauri `dialog.ask` confirmation), Open stack folder, Re-run wizard. Native toast feedback via existing `useToast`. Save flow chains `setupPatchEnv` → `setupRestartServices` (for docker svcs) + `restartSidecar` + `reloadRuntimeConfig` (when `sidecar` is in restart list, e.g. AI key changes).
        *   **Build pipeline:** `bun build --compile` produces a 114 MB self-contained sidecar binary; `npm run build:desktop` chains `build:ui → sidecar:build → bundle:desktop`, outputs MSI (48 MB) + NSIS (33 MB) for Windows. Tier B/C admin features (below) are explicitly out of scope and tracked as follow-up PRs.
        *   **Hot-fixes from end-to-end testing:**
            *   **Env-forwarding name mismatch:** `sidecar.rs` was forwarding `OPENROUTER_MODEL` / `GOOGLE_AI_MODEL` (don't exist in the generated `.env`); `chat-core/providers/select.ts` reads `LLM_PROVIDER` + `LLM_MODEL`. Fix: forward the actual names. Without this the desktop chat fell back to `openai/gpt-4o-mini` and returned 400 from OpenRouter, while Telegram (which reads `.env` directly via docker-compose) worked fine.
            *   **Conversation persistence race in `useChat`:** the hook used `setState(s => { cid = s.conversationId; return s; })` to read state synchronously — works in React 17, breaks in React 18 because updater functions are queued and run during the next render. Result: every turn arrived at the sidecar with `conversationId: undefined`, server minted a new conversation, all prior context lost (visible at turn 4–5 with referential answers like "Si"). Fix: `conversationIdRef = useRef(...)` updated alongside state in 4 places (initial hydrate, `'conversation'` event, expired-history reset, `clear()`).
            *   **SQLite-on-non-system-drives constraint discovered:** when the user picks a workdir on a drive other than `C:\` under Docker Desktop + WSL2, Sonarr/Radarr/Prowlarr fail to start with `SQLITE_CANTOPEN` because WSL2's 9P bind-mount has imperfect POSIX file locking. Linuxserver.io documents the same for SMB/NFS. Documented as known issue and tracked for hardening in PR 3.3 (workdir pre-flight FS probe + drive-letter warning).
*   **PR 3.3: Settings Admin — Tier B (deeper service integration + wizard hardening)**
    *   **Scope:** Admin operations that require per-service API knowledge, plus polish for the deploy flow that surfaced during PR 3.2 end-to-end testing.
    *   **Requirements:**
        *   **Service admin:** Change Jellyfin admin password via Jellyfin's `/Users/Password` API · regenerate Sonarr/Radarr/Prowlarr API keys (call each service's settings API, propagate to `.env`, restart dependents) · live container logs (`docker compose logs -f <svc>` streamed as NDJSON to a `<LogDrawer>` per service) · "Buscar updates" → `docker compose pull` with progress drawer + 1-click apply.
        *   **Wizard pre-flight hardening:** add a Tauri command `probe_workdir(path)` that opens a SQLite db with WAL mode (matching how *arr services use it) and returns `{ sqliteCompatible, fsType }`. Wizard step 2 calls it on workdir selection; if the probe fails, block "Continuar" with a red banner explaining the constraint and recommending `C:\` for the stack while keeping media libraries on the user's preferred drive. Add a yellow soft-warning when the picked path is on a non-system drive on Windows (heuristic: drive letter ≠ `C:`).
*   **PR 3.4: Settings Admin — Tier C (lifecycle + UX polish)**
    *   **Scope:** Anything that needs to recreate containers (not just restart) or that's pure app-side polish.
    *   **Requirements:** Edit paths / timezone / UID-GID with `docker compose down + up -d` flow (preserves volumes) · App preferences (theme, language, polling intervals) · Backup/restore of `state.json` + `.env` · Multi-stack support (switch between several deployed installations).

### Phase 4: Privacy First (Local AI via Ollama)
*Objective: Eliminate the hard requirement for paid API keys (OpenAI/Google) to achieve true self-hosting.*

*   **PR 4.1: Ollama Support in MCP Clients**
    *   **Scope:** Add Ollama as an LLM provider option in both the Telegram bot and the new Desktop Chat UI.
    *   **Requirements:** The system must connect to `http://localhost:11434`. Handle graceful fallbacks if the local model is too slow or lacks tool-calling capabilities (recommend specific models like `llama3.1` or `qwen2.5` that support tool calling well).

### Phase 5: Proactive Maintenance (The Autonomous Agent)
*Objective: Shift the AI from purely reactive to proactively helpful.*

*   **PR 5.1: Background Agent Loop (`@mediabox/mcp`)**
    *   **Scope:** Introduce a cron-like scheduler inside the MCP server.
    *   **Requirements:** The agent wakes up periodically (e.g., weekly), runs `get_library_state` and disk checks, and sends a Telegram notification if action is needed (e.g., "Disk is 90% full. Should I delete old watched episodes?").

---