<p align="center">
  <a href="../README.md"><img src="https://img.shields.io/badge/← Volver-readme-grey?style=flat-square" alt="Volver"></a>
  &nbsp;
  <a href="README.en.md"><img src="https://img.shields.io/badge/lang-English-blue?style=flat-square" alt="English"></a>
</p>

# Mediabox MCP — Español

Servidor multimedia auto-alojado con gestión inteligente via [MCP](https://modelcontextprotocol.io/) y una aplicación de escritorio nativa.

## ¿Qué es esto?

Mediabox MCP es un stack de servidor multimedia basado en Docker que combina [Jellyfin](https://jellyfin.org/) con un servidor MCP (Model Context Protocol) y una aplicación de Escritorio. Esto permite que cualquier asistente de IA — Claude, GPT, Gemini, nuestra App de Escritorio, o un bot de Telegram — administre tu biblioteca de medios completa con lenguaje natural.

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
1. Preguntar tu modo de despliegue (**Local**, **VPS**, o **Tunnel**), preferencias, credenciales, timezone e integraciones opcionales
2. Generar los archivos de configuración e iniciar los contenedores Docker
3. Auto-configurar todas las conexiones entre servicios (API keys, clientes de descarga, bibliotecas, etc.)

**Modo VPS:** Incluye un reverse proxy [Caddy](https://caddyserver.com/) con HTTPS automático via Let's Encrypt. Todos los puertos se enlazan a `127.0.0.1` y cada servicio obtiene su propio subdominio (ej. `jellyfin.tudominio.com`, `sonarr.tudominio.com`).

**Modo Tunnel:** Para usuarios en casa detrás de NAT/CGNAT o sin IP pública. Agrega un contenedor [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) que crea una conexión saliente hacia la red de Cloudflare — no necesitas abrir puertos en tu router. Requiere una cuenta gratuita de Cloudflare y un dominio. Los hostnames públicos se configuran en el [dashboard de Zero Trust](https://one.dash.cloudflare.com/).

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

Mediabox MCP se estructura como un monorepo que contiene varios paquetes:

```
mediabox-mcp/
├── docker-compose.yml          # Stack completo de servicios
├── .env.example                # Plantilla de variables de entorno
├── packages/
│   ├── chat-core/              # Motor compartido de IA + tools de MCP
│   ├── contracts/              # Tipos compartidos para APIs
│   ├── core/                   # Motor de orquestación (generación, clientes API)
│   ├── desktop/                # App de escritorio Tauri que incluye UI y MCP sidecar
│   ├── mcp-server/             # Servidor MCP y REST (TypeScript + Express)
│   ├── mcp-telegram-client/    # Cliente de Telegram (opcional)
│   ├── mediabox-cli/           # CLI interactivo (npx create-mediabox)
│   └── ui/                     # UI de React para la app de escritorio
```

## Contribuir

Las contribuciones son bienvenidas. Por favor abre un issue primero para discutir los cambios que te gustaría hacer.
