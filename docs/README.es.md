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
- Node.js >= 20
- Un VPS o máquina local con al menos 4GB de RAM
- Un dominio (opcional, para HTTPS y OAuth del MCP)

## Instalación

### Opción A: Setup automatizado (recomendado)

```bash
npx create-mediabox
```

El CLI interactivo va a:
1. Preguntar tus preferencias (rutas de media, credenciales, timezone, integraciones opcionales)
2. Generar los archivos de configuración e iniciar los contenedores Docker
3. Auto-configurar todas las conexiones entre servicios (API keys, clientes de descarga, bibliotecas, etc.)

Usa `--local-build` para compilar el servidor MCP y el bot de Telegram desde el código fuente en vez de descargar imágenes pre-compiladas.

Usa `--generate-only` para generar los archivos sin iniciar Docker (útil para inspeccionar antes de ejecutar).

Después del setup, el único paso manual es agregar tus indexadores de torrents en Prowlarr (`http://localhost:9696`).

### Opción B: Setup manual

<details>
<summary>Clic para expandir los pasos de instalación manual</summary>

#### 1. Clonar y configurar

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
cp .env.example .env
```

#### 2. Levantar el stack

```bash
docker compose up -d
```

#### 3. Configurar Jellyfin

1. Abre `http://tu-servidor:8096`
2. Completa el wizard — crea tu usuario admin
3. Agrega bibliotecas apuntando a `/data/movies`, `/data/tv`, `/data/anime`
4. Ve a **Dashboard > API Keys > +** y crea una nueva API key
5. Copia la key a tu `.env` como `JELLYFIN_API_KEY`

#### 4. Configurar qBittorrent

1. Abre `http://tu-servidor:8085`
2. Login por defecto: `admin` / revisa los logs para la contraseña inicial:
   ```bash
   docker logs qbittorrent 2>&1 | grep "temporary password"
   ```
3. Cambia la contraseña en **Settings > Web UI**
4. Copia tu nueva contraseña al `.env` como `QBIT_PASSWORD`

#### 5. Configurar Prowlarr

1. Abre `http://tu-servidor:9696`
2. Agrega tus indexadores de torrents en **Settings > Indexers**
3. Agrega Sonarr/Radarr en **Settings > Apps** (usa sus API keys de los siguientes pasos)
4. Agrega el proxy FlareSolverr: **Settings > Indexer Proxies > +**
   - Host: `http://flaresolverr:8191`

#### 6. Configurar Sonarr

1. Abre `http://tu-servidor:8989`
2. Copia la API key de **Settings > General** al `.env` como `SONARR_API_KEY`
3. Agrega root folders: `/tv` y `/anime`
4. Agrega qBittorrent como cliente de descarga (host: `qbittorrent`, port: `8085`)

#### 7. Configurar Radarr

1. Abre `http://tu-servidor:7878`
2. Copia la API key de **Settings > General** al `.env` como `RADARR_API_KEY`
3. Agrega root folder: `/movies`
4. Agrega qBittorrent como cliente de descarga

#### 8. Configurar el servidor MCP

Llena tu `.env` y reinicia:

```bash
docker compose up -d
```

#### 9. Conectar un cliente de IA

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

Agrega al `.env`:
```env
TELEGRAM_BOT_TOKEN=<de BotFather>
LLM_PROVIDER=openrouter
LLM_MODEL=openai/gpt-4o
OPENROUTER_API_KEY=<de OpenRouter>
ALLOWED_TELEGRAM_USERS=<tu ID de Telegram>
```

</details>

## Estructura del Proyecto

```
mediabox-mcp/
├── docker-compose.yml          # Stack completo (9 servicios)
├── .env.example                # Plantilla de variables de entorno
├── mediabox-cli/               # CLI de setup (npx create-mediabox)
│   └── src/
│       ├── index.ts            # Entry point, orquesta las 4 fases
│       ├── wizard.ts           # Prompts interactivos
│       ├── generator.ts        # Generación de archivos (.env, compose, qbit)
│       ├── orchestrator.ts     # Docker compose + polling de readiness
│       ├── configurator.ts     # Auto-config via APIs de servicios
│       ├── templates/          # Plantillas de .env, docker-compose, qbittorrent
│       └── services/           # Jellyfin, Sonarr, Radarr, Prowlarr, qBit
├── mcp-server/                 # Servidor MCP (TypeScript)
│   └── src/
│       ├── index.ts            # Express + transporte Streamable HTTP
│       ├── config.ts           # Variables de entorno
│       ├── auth.ts             # OAuth2 + auth por API key
│       ├── helpers/            # Clientes API y utilidades
│       └── tools/              # 25 herramientas MCP
└── mcp-telegram-client/        # Bot de Telegram (opcional)
    └── src/
        └── index.ts            # Grammy + OpenRouter/Gemini
```

## Contribuir

Las contribuciones son bienvenidas. Por favor abre un issue primero para discutir los cambios que te gustaría hacer.
