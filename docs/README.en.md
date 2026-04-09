<p align="center">
  <a href="../README.md"><img src="https://img.shields.io/badge/← Back-readme-grey?style=flat-square" alt="Back"></a>
  &nbsp;
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-red?style=flat-square" alt="Español"></a>
</p>

# Mediabox MCP — English

Self-hosted media server with AI-powered management via [MCP](https://modelcontextprotocol.io/).

## What is this?

Mediabox MCP is a Docker-based media server stack that combines [Jellyfin](https://jellyfin.org/) with an MCP (Model Context Protocol) server. This lets any AI assistant — Claude, GPT, Gemini, or a Telegram bot — manage your entire media library through natural language.

Instead of clicking through multiple web UIs, you just say *"download the latest season of My Show"* and the system handles everything: searching, downloading, organizing files, and refreshing your library.

## Prerequisites

- Docker & Docker Compose
- A VPS or local machine with at least 4GB RAM
- A domain name (for HTTPS and MCP OAuth)

## Installation

### 1. Clone and configure

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
cp .env.example .env
```

Leave `.env` mostly empty for now — you'll fill in the API keys as you set up each service.

### 2. Start the stack

```bash
docker compose up -d
```

The first run will build the MCP server and Telegram bot images. All services will start, but they won't be connected to each other yet.

### 3. Set up Jellyfin

1. Open `http://your-server:8096`
2. Complete the setup wizard — create your admin user, set language, etc.
3. Add media libraries pointing to `/data/movies`, `/data/tv`, `/data/anime`
4. Go to **Dashboard > API Keys > +** and create a new API key
5. Copy the key into your `.env` as `JELLYFIN_API_KEY`

### 4. Set up qBittorrent

1. Open `http://your-server:8085`
2. Default login: `admin` / check the container logs for the initial password:
   ```bash
   docker logs qbittorrent 2>&1 | grep "temporary password"
   ```
3. Go to **Settings > Web UI** and change the password
4. Go to **Settings > Downloads** and set the default save path to `/downloads`
5. Copy your new password into `.env` as `QBIT_PASSWORD`

### 5. Set up Prowlarr

1. Open `http://your-server:9696`
2. Complete the setup wizard
3. Go to **Settings > Indexers** and add your torrent indexers
4. Go to **Settings > Apps** and add connections for:
   - **Sonarr:** URL `http://sonarr:8989`, API key from Sonarr (next step)
   - **Radarr:** URL `http://radarr:7878`, API key from Radarr (next step)
5. Go to **Settings > Indexer Proxies > +** and add a **FlareSolverr** proxy:
   - Tag: `flaresolverr`
   - Host: `http://flaresolverr:8191`
   - (This is actually [ByParr](https://github.com/ThePhaseless/Byparr) running as a FlareSolverr-compatible drop-in)

### 6. Set up Sonarr (TV/Anime)

1. Open `http://your-server:8989`
2. Go to **Settings > General** — copy the API key into `.env` as `SONARR_API_KEY`
3. Go to **Settings > Media Management > Root Folders** and add:
   - `/tv` for TV shows
   - `/anime` for anime
4. Go to **Settings > Download Clients > +** and add **qBittorrent**:
   - Host: `qbittorrent`, Port: `8085`
   - Username: `admin`, Password: your qBit password

### 7. Set up Radarr (Movies)

1. Open `http://your-server:7878`
2. Go to **Settings > General** — copy the API key into `.env` as `RADARR_API_KEY`
3. Go to **Settings > Media Management > Root Folders** and add `/movies`
4. Go to **Settings > Download Clients > +** and add **qBittorrent**:
   - Host: `qbittorrent`, Port: `8085`
   - Username: `admin`, Password: your qBit password

### 8. Sync Prowlarr with Sonarr/Radarr

Go back to Prowlarr (**Settings > Apps**) and fill in the API keys you just copied from Sonarr and Radarr. Click **Test** on each to confirm the connection.

### 9. Configure the MCP Server

Fill in the remaining `.env` values:

```env
TZ=UTC

JELLYFIN_API_KEY=<from step 3>
SONARR_API_KEY=<from step 6>
RADARR_API_KEY=<from step 7>
QBIT_PASSWORD=<from step 4>

MCP_PUBLIC_URL=https://your-domain.com
MCP_AUTH_SECRET=<any random string>
INTERNAL_API_KEY=<any random string>
```

Then restart to apply:

```bash
docker compose up -d
```

Verify the MCP server is running:

```bash
curl https://your-domain.com/health
# → {"status":"ok","name":"mediabox-mcp","version":"0.4.0-beta"}
```

### 10. Connect an AI client

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

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Get an API key from [OpenRouter](https://openrouter.ai/) or [Google AI Studio](https://aistudio.google.com/)
3. Add to `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=<from BotFather>
   OPENROUTER_API_KEY=<from OpenRouter>
   ALLOWED_TELEGRAM_USERS=<your Telegram user ID>
   ```
4. Restart: `docker compose up -d`

## Project Structure

```
mediabox-mcp/
├── docker-compose.yml          # Full service stack (9 services)
├── .env.example                # Environment variable template
├── mcp-server/                 # MCP server (TypeScript)
│   └── src/
│       ├── index.ts            # Express + Streamable HTTP transport
│       ├── config.ts           # Environment variables
│       ├── auth.ts             # OAuth2 + API key auth
│       ├── helpers/            # API clients & utilities
│       │   ├── api.ts          # Jellyfin, Sonarr, Radarr
│       │   ├── qbittorrent.ts  # qBittorrent (cookie auth)
│       │   ├── pyload.ts       # PyLoad (session + CSRF)
│       │   ├── files.ts        # File ops, archive extraction, ffmpeg
│       │   └── jobs.ts         # Background job system
│       └── tools/              # 25 MCP tools
│           ├── register.ts     # Tool registry
│           ├── jellyfin.ts     # Server status, search, details
│           ├── library.ts      # File management, renaming, subtitles
│           ├── sonarr.ts       # TV series (auto ID resolution)
│           ├── radarr.ts       # Movies (duplicate prevention)
│           ├── downloads.ts    # PyLoad + queue management
│           └── maintenance.ts  # Optimization, cleanup, jobs
└── mcp-telegram-client/        # Telegram bot (optional)
    └── src/
        └── index.ts            # Grammy + OpenRouter/Gemini
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.
