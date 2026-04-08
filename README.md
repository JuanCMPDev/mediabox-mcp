<p align="center">
  <img src="assets/logo.png" width="120" alt="Mediabox MCP">
</p>

<h1 align="center">Mediabox MCP</h1>

<p align="center">
  Self-hosted media server with AI-powered management via MCP
  <br>
  <a href="#-english">English</a> · <a href="#-español">Español</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.0--beta-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

---

## 🇬🇧 English

### What is this?

Mediabox MCP is a Docker-based media server stack that combines [Jellyfin](https://jellyfin.org/) with an [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server. This lets any AI assistant — Claude, GPT, Gemini, or a Telegram bot — manage your entire media library through natural language.

Instead of clicking through multiple web UIs, you just say *"download the latest season of My Show"* and the system handles everything: searching, downloading, organizing files, and refreshing your library.

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Your AI Client                       │
│          (Claude / Telegram Bot / Any MCP Client)        │
└──────────────────┬───────────────────────────────────────┘
                   │ MCP Protocol (Streamable HTTP)
                   ▼
┌──────────────────────────────────────────────────────────┐
│                   MCP Server (:3000)                     │
│        24 tools · OAuth2 · Express · TypeScript          │
└──┬──────────┬──────────┬──────────┬──────────┬───────────┘
   ▼          ▼          ▼          ▼          ▼
Jellyfin   Sonarr    Radarr    qBittorrent   PyLoad
 :8096     :8989     :7878      :8085        :8000
   │          │          │          │
   │       Prowlarr ◄───┘          │
   │        :9696                  │
   │          │                    │
   │      FlareSolverr             │
   │        :8191                  │
   ▼                               ▼
┌──────────────────────────────────────────────────────────┐
│                   Shared Media Volume                    │
│           /data/movies · /data/tv · /data/anime          │
└──────────────────────────────────────────────────────────┘
```

### MCP Tools (24)

| Category | Tools | Description |
|----------|-------|-------------|
| **Jellyfin** | `server_status`, `activity_log`, `search_media`, `show_details` | Library browsing, server monitoring, playback history |
| **Library** | `manage_library`, `manage_files`, `rename_episodes`, `fix_subtitles` | File operations, subtitle conversion (ASS→SRT), batch renaming |
| **Sonarr** | `series_search`, `series_status`, `series_remove`, `series_releases`, `series_grab` | TV/anime search, monitoring, manual episode grabs |
| **Radarr** | `movie_search`, `movie_status`, `movie_remove`, `movie_releases`, `movie_grab` | Movie search, monitoring, manual release grabs |
| **Downloads** | `download_add`, `download_status`, `cancel_downloads` | PyLoad file hosters, queue management, duplicate purging |
| **Maintenance** | `optimize_media`, `cleanup_server`, `check_jobs` | Strip unwanted audio/sub tracks, clean orphans, async job monitoring |

### Prerequisites

- Docker & Docker Compose
- A VPS or local machine (tested on 6 cores / 12GB RAM / 100GB NVMe)
- API keys for Jellyfin, Sonarr, Radarr

### Quick Start

1. **Clone the repo**

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
```

2. **Create your `.env` file**

```bash
cp .env.example .env
# Edit .env with your API keys
```

Required environment variables:

```env
# Jellyfin
JELLYFIN_API_KEY=your-jellyfin-api-key

# Download stack
SONARR_API_KEY=your-sonarr-api-key
RADARR_API_KEY=your-radarr-api-key
QBIT_PASSWORD=your-qbittorrent-password

# MCP Server
MCP_PUBLIC_URL=https://your-domain.com
MCP_AUTH_SECRET=random-secret-string
INTERNAL_API_KEY=random-internal-key

# Telegram bot (optional)
TELEGRAM_BOT_TOKEN=your-bot-token
OPENROUTER_API_KEY=your-openrouter-key
ALLOWED_TELEGRAM_USERS=123456789,987654321
```

3. **Start everything**

```bash
docker compose up -d
```

4. **Connect your MCP client**

The MCP server is available at `http://your-server:3000/mcp` (Streamable HTTP transport with OAuth2).

For internal services (like the Telegram bot), use Bearer authentication with your `INTERNAL_API_KEY`.

### Project Structure

```
mediabox-mcp/
├── docker-compose.yml          # Full service stack
├── .env.example                # Environment variable template
├── mcp-server/                 # MCP server (TypeScript)
│   └── src/
│       ├── index.ts            # Express app + transport
│       ├── config.ts           # Environment variables
│       ├── auth.ts             # OAuth2 provider
│       ├── helpers/            # API clients & utilities
│       │   ├── api.ts          # Jellyfin, Sonarr, Radarr
│       │   ├── qbittorrent.ts  # qBittorrent client
│       │   ├── pyload.ts       # PyLoad client
│       │   ├── files.ts        # File operations, ffmpeg
│       │   └── jobs.ts         # Async job system
│       └── tools/              # MCP tool definitions
│           ├── register.ts     # Tool registry
│           ├── jellyfin.ts     # 4 tools
│           ├── library.ts      # 4 tools
│           ├── sonarr.ts       # 5 tools
│           ├── radarr.ts       # 5 tools
│           ├── downloads.ts    # 3 tools
│           └── maintenance.ts  # 3 tools
└── mcp-telegram-client/        # Telegram bot (optional)
    └── src/
        └── index.ts            # Grammy + OpenRouter/Gemini
```

### Using with Claude Desktop

Add this to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "mediabox": {
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

### Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

---

## 🇪🇸 Español

### ¿Qué es esto?

Mediabox MCP es un stack de servidor multimedia basado en Docker que combina [Jellyfin](https://jellyfin.org/) con un servidor [MCP](https://modelcontextprotocol.io/) (Model Context Protocol). Esto permite que cualquier asistente de IA — Claude, GPT, Gemini, o un bot de Telegram — administre tu biblioteca de medios completa con lenguaje natural.

En vez de navegar múltiples interfaces web, simplemente dices *"descarga la última temporada de Mi Serie"* y el sistema se encarga de todo: buscar, descargar, organizar archivos y refrescar tu biblioteca.

### Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│                    Tu Cliente de IA                       │
│         (Claude / Bot Telegram / Cualquier MCP Client)   │
└──────────────────┬───────────────────────────────────────┘
                   │ Protocolo MCP (Streamable HTTP)
                   ▼
┌──────────────────────────────────────────────────────────┐
│                  Servidor MCP (:3000)                     │
│        24 herramientas · OAuth2 · Express · TypeScript   │
└──┬──────────┬──────────┬──────────┬──────────┬───────────┘
   ▼          ▼          ▼          ▼          ▼
Jellyfin   Sonarr    Radarr    qBittorrent   PyLoad
 :8096     :8989     :7878      :8085        :8000
   │          │          │          │
   │       Prowlarr ◄───┘          │
   │        :9696                  │
   │          │                    │
   │      FlareSolverr             │
   │        :8191                  │
   ▼                               ▼
┌──────────────────────────────────────────────────────────┐
│                 Volumen de Media Compartido               │
│           /data/movies · /data/tv · /data/anime          │
└──────────────────────────────────────────────────────────┘
```

### Herramientas MCP (24)

| Categoría | Herramientas | Descripción |
|-----------|-------------|-------------|
| **Jellyfin** | `server_status`, `activity_log`, `search_media`, `show_details` | Explorar biblioteca, monitorear servidor, historial de reproducción |
| **Biblioteca** | `manage_library`, `manage_files`, `rename_episodes`, `fix_subtitles` | Operaciones de archivos, conversión de subtítulos (ASS→SRT), renombrado masivo |
| **Sonarr** | `series_search`, `series_status`, `series_remove`, `series_releases`, `series_grab` | Búsqueda de series/anime, monitoreo, descarga manual de episodios |
| **Radarr** | `movie_search`, `movie_status`, `movie_remove`, `movie_releases`, `movie_grab` | Búsqueda de películas, monitoreo, descarga manual de releases |
| **Descargas** | `download_add`, `download_status`, `cancel_downloads` | File hosters vía PyLoad, gestión de cola, purga de duplicados |
| **Mantenimiento** | `optimize_media`, `cleanup_server`, `check_jobs` | Eliminar pistas de audio/subtítulos, limpiar huérfanos, monitoreo de tareas async |

### Requisitos

- Docker y Docker Compose
- Un VPS o máquina local (probado con 6 cores / 12GB RAM / 100GB NVMe)
- API keys de Jellyfin, Sonarr, Radarr

### Inicio Rápido

1. **Clona el repo**

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
```

2. **Crea tu archivo `.env`**

```bash
cp .env.example .env
# Edita .env con tus API keys
```

Variables de entorno requeridas:

```env
# Jellyfin
JELLYFIN_API_KEY=tu-api-key-de-jellyfin

# Stack de descargas
SONARR_API_KEY=tu-api-key-de-sonarr
RADARR_API_KEY=tu-api-key-de-radarr
QBIT_PASSWORD=tu-password-de-qbittorrent

# Servidor MCP
MCP_PUBLIC_URL=https://tu-dominio.com
MCP_AUTH_SECRET=cadena-secreta-random
INTERNAL_API_KEY=clave-interna-random

# Bot de Telegram (opcional)
TELEGRAM_BOT_TOKEN=tu-token-de-bot
OPENROUTER_API_KEY=tu-api-key-de-openrouter
ALLOWED_TELEGRAM_USERS=123456789,987654321
```

3. **Levanta todo**

```bash
docker compose up -d
```

4. **Conecta tu cliente MCP**

El servidor MCP está disponible en `http://tu-servidor:3000/mcp` (transporte Streamable HTTP con OAuth2).

Para servicios internos (como el bot de Telegram), usa autenticación Bearer con tu `INTERNAL_API_KEY`.

### Estructura del Proyecto

```
mediabox-mcp/
├── docker-compose.yml          # Stack completo de servicios
├── .env.example                # Plantilla de variables de entorno
├── mcp-server/                 # Servidor MCP (TypeScript)
│   └── src/
│       ├── index.ts            # App Express + transporte
│       ├── config.ts           # Variables de entorno
│       ├── auth.ts             # Proveedor OAuth2
│       ├── helpers/            # Clientes API y utilidades
│       │   ├── api.ts          # Jellyfin, Sonarr, Radarr
│       │   ├── qbittorrent.ts  # Cliente qBittorrent
│       │   ├── pyload.ts       # Cliente PyLoad
│       │   ├── files.ts        # Operaciones de archivo, ffmpeg
│       │   └── jobs.ts         # Sistema de tareas async
│       └── tools/              # Definiciones de herramientas MCP
│           ├── register.ts     # Registro de herramientas
│           ├── jellyfin.ts     # 4 herramientas
│           ├── library.ts      # 4 herramientas
│           ├── sonarr.ts       # 5 herramientas
│           ├── radarr.ts       # 5 herramientas
│           ├── downloads.ts    # 3 herramientas
│           └── maintenance.ts  # 3 herramientas
└── mcp-telegram-client/        # Bot de Telegram (opcional)
    └── src/
        └── index.ts            # Grammy + OpenRouter/Gemini
```

### Usar con Claude Desktop

Agrega esto a tu configuración MCP de Claude Desktop:

```json
{
  "mcpServers": {
    "mediabox": {
      "url": "https://tu-dominio.com/mcp"
    }
  }
}
```

### Contribuir

Las contribuciones son bienvenidas. Por favor abre un issue primero para discutir los cambios que te gustaría hacer.

---

## License / Licencia

This project is licensed under the [MIT License](LICENSE).
