<p align="center">
  <a href="../README.md"><img src="https://img.shields.io/badge/← Volver-readme-grey?style=flat-square" alt="Volver"></a>
  &nbsp;
  <a href="README.en.md"><img src="https://img.shields.io/badge/lang-English-blue?style=flat-square" alt="English"></a>
</p>

# Mediabox MCP — Español

Servidor multimedia auto-alojado con gestión inteligente vía [MCP](https://modelcontextprotocol.io/), una aplicación de escritorio nativa y un bot de Telegram.

## ¿Qué es esto?

Mediabox MCP es un stack basado en Docker que envuelve [Jellyfin](https://jellyfin.org/), Sonarr, Radarr, Prowlarr, qBittorrent, PyLoad y FlareSolverr detrás de un único servidor MCP. Cualquier asistente de IA — Claude, GPT, Gemini, nuestra App de Escritorio o un bot de Telegram — puede administrar toda la biblioteca con lenguaje natural.

En vez de navegar cinco interfaces web, dices *"descarga la última temporada de Mi Serie"* y el sistema se encarga de buscar, descargar, organizar y refrescar la biblioteca.

El repo expone tres formas de usar el mismo stack de Docker:

- **App de Escritorio** (Tauri 2) — instalación local con asistente de configuración integrado, dashboard, chat con IA, visor de logs, rotación de API keys de los \*arr, copia de seguridad / restauración y actualización de imágenes Docker con un clic.
- **CLI** (`npx create-mediabox`) — el mismo motor de orquestación que usa el wizard de escritorio, expuesto como un asistente interactivo de un solo uso para servidores headless.
- **Servidor MCP** — endpoint `Streamable HTTP` protegido con OAuth en `/mcp`. Conéctalo a cualquier cliente MCP (Claude Desktop, ChatGPT, agentes propios) o ejecuta el bot opcional de Telegram.

## Requisitos

- **Todos los modos:** Docker, Docker Compose, Node.js >= 22
- **Compilar la App de Escritorio (sólo si la construyes localmente):** toolchain de Rust (para Tauri 2) y [Bun](https://bun.sh/) (para el sidecar `bun build --compile`)
- **VPS:** un dominio apuntando al host (para HTTPS / OAuth)
- Una máquina con al menos 4 GB de RAM

## Instalación

### Opción A: App de Escritorio (recomendada para uso local/portátil)

```bash
git clone https://github.com/JuanCMPDev/mediabox-mcp.git
cd mediabox-mcp
npm install
npm run dev:desktop          # modo desarrollo
# o
npm run build:desktop        # build de producción (.msi / .dmg / .AppImage)
```

En el primer arranque la app te guía por un wizard de 9 pasos:

1. **Idioma** — Inglés o Español (cambiable luego desde Ajustes)
2. **Pre-flight** — verifica que Docker esté instalado y corriendo
3. **Despliegue** — Local / VPS / Tunnel + tag de imagen y directorio de trabajo del stack
4. **Sistema** — zona horaria, PUID/PGID
5. **Rutas multimedia** — películas, series, anime, música (con un *probe* del filesystem que avisa si la ruta está en disco del sistema, exFAT, OneDrive, etc.)
6. **Servicios** — admin de Jellyfin, contraseña de qBittorrent, credenciales de PyLoad, Bazarr opcional
7. **Asistente IA** — elige OpenRouter, Google AI (Gemini) o salta el paso
8. **Bot de Telegram** — opcional, replica el chat de IA en tu teléfono
9. **Revisión** — última oportunidad antes de que arranque el deploy

La fase de deploy muestra progreso en vivo de cada paso (`docker compose up`, wizard de Jellyfin, extracción de API keys de los \*arr, creación de bibliotecas, etc.). Al terminar, un paso post-deploy abre Prowlarr para que añadas al menos un indexador.

### Opción B: Setup automatizado vía CLI

```bash
npx create-mediabox
```

El CLI interactivo:
1. Pregunta tu modo de despliegue (**Local**, **VPS** o **Tunnel**), preferencias, credenciales, zona horaria e integraciones opcionales
2. Genera todos los archivos de configuración e inicia los contenedores Docker
3. Auto-configura todas las conexiones entre servicios (API keys, clientes de descarga, bibliotecas, etc.)

**Modo VPS:** incluye un reverse proxy [Caddy](https://caddyserver.com/) con HTTPS automático vía Let's Encrypt. Todos los puertos se enlazan a `127.0.0.1` y cada servicio obtiene su propio subdominio (ej. `jellyfin.tudominio.com`, `sonarr.tudominio.com`).

**Modo Tunnel:** para usuarios en casa detrás de NAT/CGNAT o sin IP pública. Agrega un contenedor [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) que crea una conexión saliente hacia la red de Cloudflare — no necesitas abrir puertos en tu router. Requiere una cuenta gratuita de Cloudflare y un dominio. Los hostnames públicos se configuran en el [dashboard de Zero Trust](https://one.dash.cloudflare.com/).

Flags del CLI:
- `--local-build` — compila el servidor MCP y el bot de Telegram desde el código fuente en vez de descargar las imágenes pre-compiladas
- `--generate-only` — escribe `.env`, `docker-compose.yml` y `Caddyfile` sin iniciar Docker (útil para inspeccionar antes)

Después del setup, el único paso manual es agregar tus indexadores de torrents en Prowlarr (`http://localhost:9696`).

### Opción C: Setup manual

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

**Chat dentro de la App de Escritorio:**

Define `LLM_PROVIDER` y la API key correspondiente en `.env`. El panel de chat aparece en la App de Escritorio en cuanto hay un proveedor configurado. Soporta `openrouter` y `google` (Gemini); la misma key puede alimentar también al bot de Telegram.

</details>

## Funciones de la App de Escritorio

Una vez termina el wizard, la App expone cuatro vistas principales:

- **Dashboard** — widgets en vivo: sesión actual de Jellyfin, salud del servidor (CPU/RAM/disco/uptime), cola de descargas (qBittorrent + PyLoad fusionadas) y conteos de la biblioteca.
- **Biblioteca** — accesos rápidos a cada carpeta multimedia; abre directamente en el explorador del sistema.
- **Chat** — asistente de IA con renderizado de Markdown, *tool-call chips* expandibles para ver argumentos y resultados, y `Choice cards` para desambiguar (p.ej. "¿quieres *La noche de los muertos vivientes* (1968) o (1990)?"). El historial persiste entre reinicios.
- **Ajustes** — edita lo que configuró el wizard, sin re-desplegar:
  - **Resumen del stack** — directorio de trabajo, modo de despliegue, tag de imagen, dominio base, versión de la app
  - **Asistente IA** — cambiar de proveedor, rotar API key, cambiar modelo
  - **Bot de Telegram** — habilitar/deshabilitar, rotar token, IDs permitidos
  - **Contraseñas de servicios** — qBittorrent (la rota en vivo), PyLoad, admin de Jellyfin (vía la API de Jellyfin)
  - **API keys de los \*arr** — botón "Rotar" para Sonarr / Radarr / Prowlarr (el contenedor se reinicia brevemente mientras se cablea la nueva key)
  - **Servicios en vivo** — abrir cada web UI, ver logs en un *drawer* lateral
  - **Sistema / Rutas multimedia** — cambiar zona horaria, PUID/PGID o carpetas (los contenedores que cocinan env-vars en `up` se recrean, los demás sólo se reinician)
  - **Actualizaciones** — `docker compose pull` con el progreso transmitido a la UI; fija o actualiza el tag de imagen
  - **Preferencias** — idioma (Inglés/Español), intervalo de refresco del dashboard, refresco programado de la biblioteca de Jellyfin
  - **Ciclo de vida del stack** — start / stop / restart de todos los contenedores
  - **Avanzado** — editor del `.env` completo (claves en allowlist), reset del wizard, exportar / importar un `.zip` con toda la configuración

## Cómo encajan las piezas

```
mediabox-mcp/
├── docker-compose.yml          # Stack completo de servicios
├── .env.example                # Plantilla de variables de entorno
└── packages/
    ├── chat-core/              # @mediabox/chat-core — motor de LLM + tool-calling MCP
    │                             Proveedores: OpenRouter y Google AI (Gemini)
    │                             Router de tools virtuales, prompts, historial
    ├── contracts/              # @mediabox/contracts — paquete sólo de tipos
    │                             compartido entre mcp-server y ui
    ├── core/                   # @mediabox/core — motor de orquestación headless
    │                             Generadores (compose, env, Caddyfile, qBittorrent)
    │                             Clientes (Jellyfin, *arr, qBit, Prowlarr)
    │                             Interfaz Deployer + DockerCliDeployer
    ├── desktop/                # @mediabox/desktop — shell de escritorio Tauri 2
    │                             Empaqueta @mediabox/ui como SPA
    │                             Lanza mcp-server como sidecar `bun --compile`
    │                             Comandos Tauri: probe_workdir, pick_directory,
    │                             export_config, import_config, restart_sidecar, …
    ├── mcp-server/             # mediabox-mcp — Express + servidor MCP
    │                             /mcp                — transporte MCP Streamable HTTP (OAuth2)
    │                             /api/dashboard/*    — salud, sesiones, descargas, biblioteca
    │                             /api/chat/*         — chat NDJSON (LLM + tool calls)
    │                             /api/setup/*        — stream del wizard, editor de .env,
    │                                                    streaming de logs, updates,
    │                                                    rotación de API keys *arr,
    │                                                    ciclo de vida del stack
    ├── mcp-telegram-client/    # Bot de Telegram opcional (usa @mediabox/chat-core)
    ├── mediabox-cli/           # create-mediabox — wizard de `npx create-mediabox`
    │                             Mismo motor de orquestación que la app de escritorio
    └── ui/                     # @mediabox/ui — React + Vite + TanStack Query + i18next
                                  La carga la app de escritorio y el build de dev en navegador
```

El paquete `@mediabox/core` es la fuente única de verdad del pipeline de deploy — tanto el CLI como el wizard de escritorio entran ahí, y el mismo stream de `DeployEvent` alimenta los spinners `ora` del CLI y la UI de progreso del escritorio.

## Scripts comunes

Desde la raíz del repo:

```bash
npm run dev:desktop      # Compila el sidecar + corre Tauri dev (UI hot reload)
npm run dev              # mcp-server + ui en dev (sin Tauri)
npm run dev:mcp          # Sólo el servidor MCP (REST + /mcp)
npm run dev:ui           # Sólo la UI de React (apunta a dev:mcp)

npm run build            # Compila todos los workspaces
npm run build:desktop    # Compila sidecar → build de UI → tauri build
npm run sidecar:build    # Sólo (re)compilar el binario sidecar

npm test                 # Tests unitarios en todos los workspaces (vitest)
```

## Contribuir

Las contribuciones son bienvenidas. Por favor abre un issue primero para discutir los cambios que te gustaría hacer.
