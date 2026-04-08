<p align="center">
  <img src="assets/logo.png" width="120" alt="Mediabox MCP">
</p>

<h1 align="center">Mediabox MCP</h1>

<p align="center">
  Self-hosted media server with AI-powered management via MCP
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.0--beta-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center">
  <a href="docs/README.en.md"><img src="https://img.shields.io/badge/docs-English-blue?style=for-the-badge" alt="English"></a>
  &nbsp;
  <a href="docs/README.es.md"><img src="https://img.shields.io/badge/docs-Español-red?style=for-the-badge" alt="Español"></a>
</p>

---

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
   │        ByParr                 │
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
| **Jellyfin** | `server_status` `activity_log` `search_media` `show_details` | Library browsing, monitoring, playback history |
| **Library** | `manage_library` `manage_files` `rename_episodes` `fix_subtitles` | File ops, subtitle conversion, batch renaming |
| **Sonarr** | `series_search` `series_status` `series_remove` `series_releases` `series_grab` | TV/anime management with auto ID resolution |
| **Radarr** | `movie_search` `movie_status` `movie_remove` `movie_releases` `movie_grab` | Movie management with duplicate prevention |
| **Downloads** | `download_add` `download_status` `cancel_downloads` | PyLoad, queue management, orphan cleanup |
| **Maintenance** | `optimize_media` `cleanup_server` `check_jobs` | Strip tracks, clean server, monitor jobs |

### Quick Start

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
cp .env.example .env
docker compose up -d
```

Then follow the full setup guide in your language above.

---

## License

[MIT](LICENSE)
