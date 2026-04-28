<p align="center">
  <a href="../README.md"><img src="https://img.shields.io/badge/← Back-readme-grey?style=flat-square" alt="Back"></a>
  &nbsp;
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-red?style=flat-square" alt="Español"></a>
</p>

# Mediabox MCP — English

Self-hosted media server with AI-powered management via [MCP](https://modelcontextprotocol.io/), a native Desktop App, and a Telegram bot.

## What is this?

Mediabox MCP is a Docker-based media server stack that wraps [Jellyfin](https://jellyfin.org/), Sonarr, Radarr, Prowlarr, qBittorrent, PyLoad, and FlareSolverr behind a single MCP server. Any AI assistant — Claude, GPT, Gemini, our Desktop App, or a Telegram bot — can manage the whole library through natural language.

Instead of clicking through five web UIs, you say *"download the latest season of My Show"* and the system handles searching, downloading, organizing, and refreshing the library.

The repo ships three surfaces over the same Docker stack:

- **Desktop App** (Tauri 2) — local-first install with a built-in setup wizard, dashboard, AI chat, log viewer, *arr key rotation, backup/restore, and one-click Docker image updates.
- **CLI wizard** (`npx create-mediabox`) — same orchestration engine as the Desktop wizard, exposed as a one-shot interactive prompt for headless servers.
- **MCP server** — OAuth-protected `Streamable HTTP` endpoint at `/mcp`. Connect it to any MCP client (Claude Desktop, ChatGPT, custom agents) or run the optional Telegram bot.

## Prerequisites

- **All deployments:** Docker, Docker Compose, Node.js >= 22
- **Desktop App build (only if building locally):** Rust toolchain (for Tauri 2) and [Bun](https://bun.sh/) (for the `bun build --compile` sidecar)
- **VPS:** A domain name pointing at the host (for HTTPS / OAuth)
- A machine with at least 4 GB RAM

## Installation

### Option A: Desktop App (recommended for local/laptop)

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
npm install
npm run dev:desktop          # dev mode
# or
npm run build:desktop        # production bundle (.msi / .dmg / .AppImage)
```

On first launch the app walks you through a 9-step wizard:

1. **Language** — English or Spanish (changeable later from Settings)
2. **Pre-flight** — verifies that Docker is installed and running
3. **Deployment** — Local / VPS / Tunnel + image tag and stack working directory
4. **System** — timezone, PUID/PGID
5. **Media paths** — movies, TV, anime, music (with a filesystem probe that warns about system drives, exFAT, OneDrive paths, and other footguns)
6. **Services** — Jellyfin admin, qBittorrent password, PyLoad credentials, optional Bazarr
7. **AI assistant** — pick OpenRouter, Google AI (Gemini), or skip
8. **Telegram bot** — optional, mirrors the AI chat to your phone
9. **Review** — last chance before the deploy stream takes over

The deploy phase shows live progress for every step (`docker compose up`, Jellyfin wizard, *arr API-key extraction, library creation, etc.). After it finishes, a final post-deploy step opens Prowlarr so you can add at least one indexer.

### Option B: Automated CLI setup

```bash
npx create-mediabox
```

The interactive CLI:
1. Asks for your deployment mode (**Local**, **VPS**, or **Tunnel**), preferences, credentials, timezone, and optional integrations
2. Generates all config files and starts Docker containers
3. Auto-configures every service connection (API keys, download clients, libraries, etc.)

**VPS mode:** Includes a [Caddy](https://caddyserver.com/) reverse proxy with automatic HTTPS via Let's Encrypt. All ports are bound to `127.0.0.1` and each service gets its own subdomain (e.g. `jellyfin.yourdomain.com`, `sonarr.yourdomain.com`).

**Tunnel mode:** For home users behind NAT/CGNAT or without a public IP. Adds a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) container that creates an outbound connection to Cloudflare's network — no ports need to be opened on your router. Requires a free Cloudflare account and a domain. You configure the public hostnames in the [Zero Trust dashboard](https://one.dash.cloudflare.com/).

CLI flags:
- `--local-build` — build the MCP server and Telegram bot from source instead of pulling pre-built images
- `--generate-only` — write `.env`, `docker-compose.yml` and `Caddyfile` without starting Docker (useful for inspection)

After setup, the only manual step is adding your torrent indexers in Prowlarr (`http://localhost:9696`).

### Option C: Manual setup

<details>
<summary>Click to expand manual installation steps</summary>

#### 1. Clone and configure

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
cp .env.example .env
```

#### 2. Start the stack

```bash
docker compose up -d
```

#### 3. Set up Jellyfin

1. Open `http://your-server:8096`
2. Complete the setup wizard — create your admin user
3. Add media libraries pointing to `/data/movies`, `/data/tv`, `/data/anime`
4. Go to **Dashboard > API Keys > +** and create a new API key
5. Copy the key into your `.env` as `JELLYFIN_API_KEY`

#### 4. Set up qBittorrent

1. Open `http://your-server:8085`
2. Default login: `admin` / check logs for initial password:
   ```bash
   docker logs qbittorrent 2>&1 | grep "temporary password"
   ```
3. Change the password in **Settings > Web UI**
4. Copy your new password into `.env` as `QBIT_PASSWORD`

#### 5. Set up Prowlarr

1. Open `http://your-server:9696`
2. Add your torrent indexers in **Settings > Indexers**
3. Add Sonarr/Radarr in **Settings > Apps** (use their API keys from the next steps)
4. Add FlareSolverr proxy: **Settings > Indexer Proxies > +**
   - Host: `http://flaresolverr:8191`

#### 6. Set up Sonarr

1. Open `http://your-server:8989`
2. Copy API key from **Settings > General** into `.env` as `SONARR_API_KEY`
3. Add root folders: `/tv` and `/anime`
4. Add qBittorrent as download client (host: `qbittorrent`, port: `8085`)

#### 7. Set up Radarr

1. Open `http://your-server:7878`
2. Copy API key from **Settings > General** into `.env` as `RADARR_API_KEY`
3. Add root folder: `/movies`
4. Add qBittorrent as download client

#### 8. Configure the MCP Server

Fill in your `.env` and restart:

```bash
docker compose up -d
```

#### 9. Connect an AI client

**Claude Desktop / claude.ai:**

```json
{
  "mcpServers": {
    "mediabox": {
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

**Telegram Bot (optional):**

Add to `.env`:
```env
TELEGRAM_BOT_TOKEN=<from BotFather>
LLM_PROVIDER=openrouter
LLM_MODEL=openai/gpt-4o
OPENROUTER_API_KEY=<from OpenRouter>
ALLOWED_TELEGRAM_USERS=<your Telegram user ID>
```

**In-app chat (Desktop App):**

Set `LLM_PROVIDER` and the matching API key in `.env`. The chat panel becomes available in the Desktop App as soon as a provider is configured. Both `openrouter` and `google` (Gemini) are supported, and the same key can also drive the Telegram bot.

</details>

## Desktop App features

Once the wizard finishes, the Desktop App exposes four main views:

- **Dashboard** — live widgets for now-playing sessions, server health (CPU/RAM/disk/uptime), download queue (qBittorrent + PyLoad merged), and library counts.
- **Library** — quick links into each media folder; opens directly in the OS file manager.
- **Chat** — in-app AI assistant with markdown rendering, tool-call chips you can expand to see arguments and results, and `Choice cards` for disambiguation (e.g. "did you mean *Night of the Living Dead* (1968) or (1990)?"). Conversation history persists across restarts.
- **Settings** — edit anything the wizard set, without re-deploying:
  - **Stack overview** — workdir, deployment mode, image tag, base domain, app version
  - **AI assistant** — switch provider, rotate keys, change model
  - **Telegram bot** — enable/disable, rotate token, allowed user IDs
  - **Service passwords** — qBittorrent (rotates the password live), PyLoad, Jellyfin admin (uses the Jellyfin API directly)
  - **\*arr API keys** — one-click "Rotate" for Sonarr / Radarr / Prowlarr (the container restarts briefly while the new key is wired through)
  - **Live services** — open any web UI, tail container logs in a slide-out drawer
  - **System / Media paths** — change timezone, PUID/PGID, or media folders (containers that bake env-vars at create time are auto-recreated, others just restart)
  - **Updates** — `docker compose pull` with progress streamed to the UI; pin or upgrade image tag
  - **Preferences** — language (English/Spanish), dashboard refresh interval, scheduled Jellyfin library refresh
  - **Stack lifecycle** — start / stop / restart all containers
  - **Advanced** — full `.env` editor (allowlisted keys), reset wizard state, export / import a `.zip` backup of the entire config

## How the pieces fit together

```
mediabox-mcp/
├── docker-compose.yml          # Full service stack
├── .env.example                # Environment variable template
└── packages/
    ├── chat-core/              # @mediabox/chat-core — LLM + MCP tool-calling engine
    │                             OpenRouter & Google AI (Gemini) providers
    │                             Virtual tool router, prompt builder, history store
    ├── contracts/              # @mediabox/contracts — type-only package shared
    │                             between mcp-server and ui (DeployConfig, ChatEvent, …)
    ├── core/                   # @mediabox/core — headless orchestration engine
    │                             Generators (compose, env, Caddyfile, qBittorrent)
    │                             Service clients (Jellyfin, *arr, qBit, Prowlarr)
    │                             Deployer interface + DockerCliDeployer
    ├── desktop/                # @mediabox/desktop — Tauri 2 desktop shell
    │                             Bundles @mediabox/ui as the SPA
    │                             Spawns mcp-server as a `bun --compile` sidecar
    │                             Tauri commands: probe_workdir, pick_directory,
    │                             export_config, import_config, restart_sidecar, …
    ├── mcp-server/             # mediabox-mcp — Express + MCP server
    │                             /mcp                — Streamable HTTP MCP transport (OAuth2)
    │                             /api/dashboard/*    — health, sessions, downloads, library
    │                             /api/chat/*         — NDJSON chat stream (LLM + tool calls)
    │                             /api/setup/*        — wizard deploy stream, env editor,
    │                                                    log streaming, image updates, *arr
    │                                                    key rotation, stack lifecycle
    ├── mcp-telegram-client/    # Optional Telegram bot (uses @mediabox/chat-core)
    ├── mediabox-cli/           # create-mediabox — `npx create-mediabox` wizard
    │                             Same orchestration engine as the Desktop wizard
    └── ui/                     # @mediabox/ui — React + Vite + TanStack Query + i18next
                                  Loaded by the Desktop App and the dev browser build
```

The `@mediabox/core` package is the single source of truth for the deploy pipeline — both the CLI and the Desktop wizard call into it, and the same `DeployEvent` stream feeds the CLI's `ora` spinners and the Desktop's progress UI.

## Common scripts

From the repo root:

```bash
npm run dev:desktop      # Build sidecar + run Tauri dev (UI hot reload)
npm run dev              # Run mcp-server + ui in dev (no Tauri)
npm run dev:mcp          # Just the MCP server (REST + /mcp)
npm run dev:ui           # Just the React UI (talks to dev:mcp)

npm run build            # Build every workspace
npm run build:desktop    # Compile sidecar → build UI → tauri build
npm run sidecar:build    # Just (re)compile the sidecar binary

npm test                 # Run unit tests across all workspaces (vitest)
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.
