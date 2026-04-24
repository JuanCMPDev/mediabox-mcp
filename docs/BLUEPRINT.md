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

*   **PR 1.1: Extract Orchestrator to `@mediabox/core`**
    *   **Scope:** Move the Docker Compose generation (`generator.ts`), configuration logic (`configurator.ts`), and Jellyfin API setup (`services/jellyfin.ts`) into a new package (`packages/core`).
    *   **Requirements:** The core must export a clean asynchronous API (e.g., `async function deployStack(config: Config): Promise<Result>`). It must not depend on `chalk`, `ora`, or `@inquirer`.
*   **PR 1.2: Refactor `mediabox-cli` to consume `@mediabox/core`**
    *   **Scope:** Update the existing CLI wizard to import and call the new `@mediabox/core` API.
    *   **Requirements:** The CLI must function exactly as before, acting merely as a terminal frontend for the Core.

### Phase 2: Web Dashboard Foundation (The UI)
*Objective: Build the visual layer that will eventually live inside the desktop app.*

*   **PR 2.1: Initialize `@mediabox/ui` and Dashboard Layout**
    *   **Scope:** Scaffold a React application (prefer Vanilla CSS for lightweight performance). Create the main layout: Sidebar (Status, Library, Settings) and Main Content Area.
    *   **Requirements:** Must be completely decoupled from the backend initially (use mock data for disk space, active sessions, and queues).
*   **PR 2.2: Connect UI to MCP Server (`server_status` & `get_library_state`)**
    *   **Scope:** Implement API calls from the UI to the local `mcp-server` (or the underlying services) to replace mock data with real-time server telemetry.
    *   **Requirements:** Display unified download progress (qBit + PyLoad) and real disk usage.
*   **PR 2.3: Native MCP Chat Interface**
    *   **Scope:** Build a chat component in the UI that communicates with the LLM and the local MCP server, mirroring the Telegram experience but natively in the browser.

### Phase 3: The Tauri Desktop App (The Shell)
*Objective: Wrap the UI and Core into a distributable desktop application.*

*   **PR 3.1: Initialize Tauri Project (`@mediabox/desktop`)**
    *   **Scope:** Setup the Tauri skeleton using `@mediabox/ui` as the frontend.
    *   **Requirements:** Ensure cross-platform build targets (Windows, macOS, Linux) are configured.
*   **PR 3.2: Visual Setup Wizard (Desktop Installer)**
    *   **Scope:** Create a "First Launch" screen in the React UI that collects user preferences (paths, passwords) and uses Tauri commands to invoke `@mediabox/core` (via Rust bindings or a Node sidecar) to deploy the Docker stack locally.
    *   **Requirements:** Provide visual progress bars (replacing CLI spinners) during Docker pulling and Jellyfin configuration.

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

## 4. Immediate Next Steps for Engineering
1. Review and approve this blueprint.
2. Begin execution on **Phase 1 (PR 1.1)** to ensure the architecture cleanly supports both the legacy CLI and the upcoming Desktop App.