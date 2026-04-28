<p align="center">
  <a href="../README.md"><img src="https://img.shields.io/badge/← Back-readme-grey?style=flat-square" alt="Back"></a>
  &nbsp;
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-red?style=flat-square" alt="Español"></a>
</p>

# Mediabox MCP — English

Self-hosted media server with AI-powered management via [MCP](https://modelcontextprotocol.io/) and a dedicated Desktop app.

## What is this?

Mediabox MCP is a Docker-based media server stack that combines [Jellyfin](https://jellyfin.org/) with an MCP (Model Context Protocol) server and a native Desktop interface. This lets any AI assistant — Claude, GPT, Gemini, our Desktop App, or a Telegram bot — manage your entire media library through natural language.

Instead of clicking through multiple web UIs, you just say *"download the latest season of My Show"* and the system handles everything: searching, downloading, organizing files, and refreshing your library.

## Prerequisites

- Docker & Docker Compose
- Node.js >= 20
- A VPS or local machine with at least 4GB RAM
- A domain name (optional, for HTTPS and MCP OAuth)

## Installation

### Option A: Automated setup (recommended)

```bash
npx create-mediabox
```

The interactive CLI will:
1. Ask for your deployment mode (**Local**, **VPS**, or **Tunnel**), preferences, credentials, timezone, and optional integrations
2. Generate all config files and start Docker containers
3. Auto-configure every service connection (API keys, download clients, libraries, etc.)

**VPS mode:** Includes a [Caddy](https://caddyserver.com/) reverse proxy with automatic HTTPS via Let's Encrypt. All ports are bound to `127.0.0.1` and each service gets its own subdomain (e.g. `jellyfin.yourdomain.com`, `sonarr.yourdomain.com`).

**Tunnel mode:** For home users behind NAT/CGNAT or without a public IP. Adds a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) container that creates an outbound connection to Cloudflare's network — no ports need to be opened on your router. Requires a free Cloudflare account and a domain. You configure the public hostnames in the [Zero Trust dashboard](https://one.dash.cloudflare.com/).

Use `--local-build` to build the MCP server and Telegram bot from source instead of pulling pre-built images.

Use `--generate-only` to generate files without starting Docker (useful for inspection).

After setup, the only manual step is adding your torrent indexers in Prowlarr (`http://localhost:9696`).

### Option B: Manual setup

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

</details>

## Project Structure

Mediabox MCP is structured as a monorepo containing several packages:

```
mediabox-mcp/
├── docker-compose.yml          # Full service stack
├── .env.example                # Environment variable template
├── packages/
│   ├── chat-core/              # Shared LLM + MCP tool-calling engine
│   ├── contracts/              # Shared API contract types across packages
│   ├── core/                   # Headless orchestration engine & API clients
│   ├── desktop/                # Tauri desktop shell bundling UI & MCP sidecar
│   ├── mcp-server/             # MCP & REST server (TypeScript + Express)
│   ├── mcp-telegram-client/    # Optional Telegram bot integration
│   ├── mediabox-cli/           # CLI setup wizard (npx create-mediabox)
│   └── ui/                     # React UI for the Desktop App
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.
