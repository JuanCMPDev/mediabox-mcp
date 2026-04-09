<p align="center">
  <a href="../README.md"><img src="https://img.shields.io/badge/← Volver-readme-grey?style=flat-square" alt="Volver"></a>
  &nbsp;
  <a href="README.en.md"><img src="https://img.shields.io/badge/lang-English-blue?style=flat-square" alt="English"></a>
</p>

# Mediabox MCP — Español

Servidor multimedia auto-alojado con gestión inteligente via [MCP](https://modelcontextprotocol.io/).

## ¿Qué es esto?

Mediabox MCP es un stack de servidor multimedia basado en Docker que combina [Jellyfin](https://jellyfin.org/) con un servidor MCP (Model Context Protocol). Esto permite que cualquier asistente de IA — Claude, GPT, Gemini, o un bot de Telegram — administre tu biblioteca de medios completa con lenguaje natural.

En vez de navegar múltiples interfaces web, simplemente dices *"descarga la última temporada de Mi Serie"* y el sistema se encarga de todo: buscar, descargar, organizar archivos y refrescar tu biblioteca.

## Requisitos

- Docker y Docker Compose
- Un VPS o máquina local con al menos 4GB de RAM
- Un dominio (para HTTPS y OAuth del MCP)

## Instalación

### 1. Clonar y configurar

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
cp .env.example .env
```

Deja el `.env` casi vacío por ahora — irás llenando las API keys a medida que configures cada servicio.

### 2. Levantar el stack

```bash
docker compose up -d
```

La primera ejecución construirá las imágenes del MCP server y el bot de Telegram. Todos los servicios arrancarán, pero aún no estarán conectados entre sí.

### 3. Configurar Jellyfin

1. Abre `http://tu-servidor:8096`
2. Completa el wizard — crea tu usuario admin, idioma, etc.
3. Agrega bibliotecas apuntando a `/data/movies`, `/data/tv`, `/data/anime`
4. Ve a **Dashboard > API Keys > +** y crea una nueva API key
5. Copia la key a tu `.env` como `JELLYFIN_API_KEY`

### 4. Configurar qBittorrent

1. Abre `http://tu-servidor:8085`
2. Login por defecto: `admin` / revisa los logs para la contraseña inicial:
   ```bash
   docker logs qbittorrent 2>&1 | grep "temporary password"
   ```
3. Ve a **Settings > Web UI** y cambia la contraseña
4. Ve a **Settings > Downloads** y configura el path de descarga como `/downloads`
5. Copia tu nueva contraseña al `.env` como `QBIT_PASSWORD`

### 5. Configurar Prowlarr

1. Abre `http://tu-servidor:9696`
2. Completa el wizard de configuración
3. Ve a **Settings > Indexers** y agrega tus indexadores de torrents
4. Ve a **Settings > Apps** y agrega conexiones para:
   - **Sonarr:** URL `http://sonarr:8989`, API key de Sonarr (siguiente paso)
   - **Radarr:** URL `http://radarr:7878`, API key de Radarr (siguiente paso)
5. Ve a **Settings > Indexer Proxies > +** y agrega un proxy **FlareSolverr**:
   - Tag: `flaresolverr`
   - Host: `http://flaresolverr:8191`
   - (En realidad es [ByParr](https://github.com/ThePhaseless/Byparr) corriendo como reemplazo compatible de FlareSolverr)

### 6. Configurar Sonarr (Series/Anime)

1. Abre `http://tu-servidor:8989`
2. Ve a **Settings > General** — copia la API key al `.env` como `SONARR_API_KEY`
3. Ve a **Settings > Media Management > Root Folders** y agrega:
   - `/tv` para series
   - `/anime` para anime
4. Ve a **Settings > Download Clients > +** y agrega **qBittorrent**:
   - Host: `qbittorrent`, Puerto: `8085`
   - Usuario: `admin`, Contraseña: tu contraseña de qBit

### 7. Configurar Radarr (Películas)

1. Abre `http://tu-servidor:7878`
2. Ve a **Settings > General** — copia la API key al `.env` como `RADARR_API_KEY`
3. Ve a **Settings > Media Management > Root Folders** y agrega `/movies`
4. Ve a **Settings > Download Clients > +** y agrega **qBittorrent**:
   - Host: `qbittorrent`, Puerto: `8085`
   - Usuario: `admin`, Contraseña: tu contraseña de qBit

### 8. Sincronizar Prowlarr con Sonarr/Radarr

Vuelve a Prowlarr (**Settings > Apps**) y llena las API keys que copiaste de Sonarr y Radarr. Haz clic en **Test** en cada una para confirmar la conexión.

### 9. Configurar el servidor MCP

Llena los valores restantes del `.env`:

```env
TZ=UTC

JELLYFIN_API_KEY=<del paso 3>
SONARR_API_KEY=<del paso 6>
RADARR_API_KEY=<del paso 7>
QBIT_PASSWORD=<del paso 4>

MCP_PUBLIC_URL=https://tu-dominio.com
MCP_AUTH_SECRET=<cualquier cadena aleatoria>
INTERNAL_API_KEY=<cualquier cadena aleatoria>
```

Luego reinicia el stack:

```bash
docker compose up -d
```

Verifica que el servidor MCP esté corriendo:

```bash
curl https://tu-dominio.com/health
# → {"status":"ok","name":"mediabox-mcp","version":"0.4.0-beta"}
```

### 10. Conectar un cliente de IA

**Claude Desktop / claude.ai:**

```json
{
  "mcpServers": {
    "mediabox": {
      "url": "https://tu-dominio.com/mcp"
    }
  }
}
```

**Bot de Telegram (opcional):**

1. Crea un bot con [@BotFather](https://t.me/BotFather) en Telegram
2. Obtén una API key de [OpenRouter](https://openrouter.ai/) o [Google AI Studio](https://aistudio.google.com/)
3. Agrega al `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=<de BotFather>
   OPENROUTER_API_KEY=<de OpenRouter>
   ALLOWED_TELEGRAM_USERS=<tu ID de usuario de Telegram>
   ```
4. Reinicia: `docker compose up -d`

## Estructura del Proyecto

```
mediabox-mcp/
├── docker-compose.yml          # Stack completo (9 servicios)
├── .env.example                # Plantilla de variables de entorno
├── mcp-server/                 # Servidor MCP (TypeScript)
│   └── src/
│       ├── index.ts            # Express + transporte Streamable HTTP
│       ├── config.ts           # Variables de entorno
│       ├── auth.ts             # OAuth2 + auth por API key
│       ├── helpers/            # Clientes API y utilidades
│       │   ├── api.ts          # Jellyfin, Sonarr, Radarr
│       │   ├── qbittorrent.ts  # qBittorrent (auth por cookie)
│       │   ├── pyload.ts       # PyLoad (sesión + CSRF)
│       │   ├── files.ts        # Archivos, extracción, ffmpeg
│       │   └── jobs.ts         # Sistema de tareas en segundo plano
│       └── tools/              # 25 herramientas MCP
│           ├── register.ts     # Registro de herramientas
│           ├── jellyfin.ts     # Estado, búsqueda, detalles
│           ├── library.ts      # Archivos, renombrado, subtítulos
│           ├── sonarr.ts       # Series (resolución automática de IDs)
│           ├── radarr.ts       # Películas (prevención de duplicados)
│           ├── downloads.ts    # PyLoad + gestión de cola
│           └── maintenance.ts  # Optimización, limpieza, tareas
└── mcp-telegram-client/        # Bot de Telegram (opcional)
    └── src/
        └── index.ts            # Grammy + OpenRouter/Gemini
```

## Contribuir

Las contribuciones son bienvenidas. Por favor abre un issue primero para discutir los cambios que te gustaría hacer.
