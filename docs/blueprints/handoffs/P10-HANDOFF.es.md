# Cierre de Fase P10 — Despliegue Local y Privacidad Verificable

Documento de entrega y cierre correspondiente a la **Fase P10** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md) y de la especificación [PR05-P10-P11-SPEC.es.md](PR05-P10-P11-SPEC.es.md). Esta entrega constituye la **Parte 1 de PR05** (P10: Despliegue local y privacidad verificable) previa al inicio de P11 (Evaluación de modelos locales y Gate G10).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P10 — Despliegue local y privacidad verificable |
| **Lote / PR** | PR05 (Parte 1 / sublote PR05a) |
| **Rama de trabajo** | `work/local-agent/p10-p11-private-evals` |
| **Rama base** | `integration/local-agent-v1` (commit base merge PR04: `79d2d16`) |
| **Fecha de entrega** | 2026-09-11 |
| **Gates asociados** | G09 `gate/local-egress` (junto con G00..G08 verificados) |

---

## 1. Alcance y Componentes Implementados

### 1.1 Contratos de Privacidad y Artefactos (`packages/contracts`)
- **Perfiles de Privacidad (`PrivacyProfile`)**:
  - `'offline-library'`: Aislamiento total offline sin salida a Internet, sin Telegram ni proveedores cloud.
  - `'local-agent-online-media'`: Inferencia del agente estrictamente confinada a la red privada local; únicamente los componentes de adquisición (descargadores/indexadores) acceden a Internet.
- **Manifiesto de Artefactos (`ArtifactManifest`)**:
  - Estructura formal de artefactos (`weights`, `manifest`, `binary`, `dataset`) con digests multi-plataforma SHA256 (`ArtifactPlatformDigests`), tipo de archivo (`gguf`, `safetensors`, `binary`, `json`), tamaño en bytes y URI de descarga saneada.
- **Control de Ciclo de Vida y Recursos (`RuntimeLifecycleState`, `RuntimeResourceLimits`)**:
  - Estados: `'not_provisioned' | 'stopped' | 'starting' | 'ready' | 'degraded' | 'failed' | 'stopping'`.
  - Límites de contexto (`maxContextTokens`), memoria VRAM/RAM (`maxMemoryBytes`) y concurrencia de inferencias (`maxParallelInferences`).

### 1.2 Validación, Ciclo de Vida y Generadores Core (`packages/core`)
- **Validación de Perfil de Privacidad (`packages/core/src/config/validate.ts`)**:
  - En `'offline-library'`, prohíbe explícitamente configuración de bot de Telegram, túneles Cloudflare y modelos cloud externos.
  - En `'local-agent-online-media'`, exige endpoint local/privado para inferencia del agente.
- **Gestión de Manifiestos de Artefactos (`packages/core/src/artifacts/manifest.ts`)**:
  - Saneamiento de URIs: redacta contraseñas o tokens embebidos (`user:pass@host` -> `host`).
  - Verificación estricta de hash SHA-256 en dos fases: `prepare` (descarga/registro inicial) vs `run` (ejecución offline). Si un artefacto falta en modo `run`, falla de forma cerrada (`ERR_ARTIFACT_MISSING`) sin intentar abrir la red.
- **Máquina de Estados de Ciclo de Vida (`packages/core/src/runtime/lifecycle.ts`)**:
  - Transiciones verificadas: `not_provisioned` -> `stopped` -> `starting` -> `ready` -> `stopping` -> `stopped`.
  - Guard de admisión de inferencia (`acquireInferenceSlot()` / `releaseInferenceSlot()`): rechaza peticiones con `ERR_RUNTIME_BUSY` si se excede `maxParallelInferences`.
  - Polling de arranque a 30s con timeout de 120s en estado `starting`.
- **Topología de Redes Docker Compose Segregadas (`packages/core/src/generators/docker-compose.ts`)**:
  - `mediabox-inference-net` (`internal: true`): conecta exclusivamente `mcp-server` con los contenedores de inferencia local (`inference-*`).
  - `mediabox-services-net` (`internal: true`): conecta `mcp-server` con los servicios de medios (`radarr`, `sonarr`, `jellyfin`).
  - `mediabox-external-net` (`driver: bridge`): asignada únicamente a descargadores (`qbittorrent`) e indexadores (`prowlarr`) cuando el perfil es `local-agent-online-media`.
  - `mcp-server` y los contenedores de inferencia **nunca** forman parte de `mediabox-external-net`.
  - En `offline-library`, se omiten completamente `mediabox-telegram` y `cloudflared`.
  - El contenedor de `mcp-server` nunca monta `/var/run/docker.sock`, named pipes de Windows (`//./pipe/docker_engine`), variable `DOCKER_HOST`, ni `privileged: true`.

### 1.3 Confinamiento, Saneamiento y Políticas de Endpoint (`packages/chat-core`, `packages/mcp-server`, `packages/desktop`)
- **Validación Estricta de Endpoints (`packages/chat-core/src/providers/endpoint-policy.ts`)**:
  - Rechaza endpoints con credenciales embebidas (`http://user:pass@127.0.0.1`).
  - Bloquea direcciones IP públicas en inferencia privada, DNS rebinding, redirecciones HTTP no autorizadas y proxies de entorno (`HTTP_PROXY` / `HTTPS_PROXY`).
- **Saneador de Diagnósticos (`packages/mcp-server/src/helpers/diagnostics-sanitizer.ts`)**:
  - Lista blanca estricta para telemetría y diagnósticos.
  - Elimina automáticamente campos de prompts, mensajes de conversación, cabeceras HTTP de autenticación, y patrones de secretos canario (`sk-*`, `canary-*`, contraseñas en URLs).
  - Integrado en `chatProviderInfo()` en `packages/mcp-server/src/chat/provider.ts`.
- **Sidecar de Escritorio (`packages/desktop/src-tauri/src/sidecar.rs`)**:
  - Reenvío explícito de la variable `PRIVACY_PROFILE` al subproceso sidecar.
  - Enlace estricto a loopback (`127.0.0.1`), impidiendo exposición accidental a la red local.

### 1.4 Banco de Pruebas y Oráculos NET-01..06 (`tests/local-egress/`)
- `harness.mjs`: Entorno de aislamiento local con sink TCP/UDP controlado para captura de tráfico y DNS autoritativo local para pruebas de rebinding.
- `net-01-egress-probe.test.mjs`: NET-01 — Proceso sonda confinado; cero paquetes al sink externo y bloqueo de exfiltración por DNS.
- `net-02-offline-operations.test.mjs`: NET-02 — Operaciones de mantenimiento aprobadas ejecutadas en root temporal; fallo cerrado de artefactos ausentes sin abrir tráfico.
- `net-03-isolated-sources.test.mjs`: NET-03 — Endpoints de fuentes e indexador accesibles por componentes de medios autorizados, pero inaccesibles para el agente.
- `net-04-endpoint-security.test.mjs`: NET-04 — Mitigación de DNS rebinding, bloqueo de redirects no autorizados y rechazo de proxies en inferencia local.
- `net-05-secret-sanitization.test.mjs`: NET-05 — Diagnósticos y reportes saneados; ausencia absoluta de secretos canarios y texto de usuario.
- `net-06-container-isolation.test.mjs`: NET-06 — Validación de topología Docker Compose: ausencia de socket Docker, soporte para rutas de volumen con espacios/Unicode y bind a loopback en Desktop.

### 1.5 Gate G09 e Integración en CI (`scripts/ci/`, `.github/workflows/ci.yml`)
- `package.json`: Script registrado `"test:local-egress": "node --test tests/local-egress/*.test.mjs"`.
- `scripts/ci/implemented-gates.mjs` y `.test.mjs`: Verificación automatizada de G00..G09 (script y job en CI sin `continue-on-error`).
- `.github/workflows/ci.yml`: Nuevo job `gate-local-egress` (`gate/local-egress (G09)`) ejecutado en pull requests e integrado en `gate-pr`.

---

## 2. Invariantes y Criterios Cumplidos (P10)

| ID | Criterio | Evidencia / Test | Estado |
|---|---|---|---|
| **NET-01** | Proceso sonda y bloqueo de egress hacia sinks externos | `tests/local-egress/net-01-egress-probe.test.mjs` (Zero paquetes capturados en sink externo, bloqueo de exfiltración DNS) | **Cumplido** |
| **NET-02** | Operaciones locales y mantenimiento con egress público denegado | `tests/local-egress/net-02-offline-operations.test.mjs` (Plan de mantenimiento local ejecutado en root temporal; fallo cerrado sin red en artefactos faltantes) | **Cumplido** |
| **NET-03** | Acceso a indexador y fuentes solo por componentes autorizados | `tests/local-egress/net-03-isolated-sources.test.mjs` (Fuentes y Torznab aislados del agente/runtime de inferencia) | **Cumplido** |
| **NET-04** | Seguridad de endpoints, DNS rebinding, redirects y proxies | `tests/local-egress/net-04-endpoint-security.test.mjs` (IP fijada pre-vuelo contra DNS rebinding, denegación de redirects externos y rechazo de proxies) | **Cumplido** |
| **NET-05** | Saneamiento de diagnósticos, secretos canario y conversaciones | `tests/local-egress/net-05-secret-sanitization.test.mjs` (`chatProviderInfo` y telemetría no filtran secretos `canary-*`, `sk-*` ni fragmentos de chat) | **Cumplido** |
| **NET-06** | Aislamiento de contenedores, montajes y endpoints | `tests/local-egress/net-06-container-isolation.test.mjs` (Compose sin `/var/run/docker.sock`, sin named pipes, rutas Unicode/espacios y loopback en Desktop) | **Cumplido** |
| **INV-SEPARATION** | Separación física de redes entre agente, servicios e internet | `packages/core/src/generators/docker-compose.test.ts` & `tests/local-egress/net-06-container-isolation.test.mjs` | **Cumplido** |
| **INV-LOCAL** | Inferencia confinada a endpoints locales sin fallback | `packages/chat-core/src/providers/select.test.ts` & `tests/local-egress/net-04-endpoint-security.test.mjs` | **Cumplido** |
| **INV-EVIDENCE** | Evidencia reproducible mediante tests deterministas y oráculos | Banco de pruebas `test:local-egress` y verificación CI en G09 | **Cumplido** |

---

## 3. Gates Evaluados

| Gate | Check | Resultado | Detalle |
|---|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** | Matriz de aceptación, invariantes, scripts implementados G00..G09 y flujo CI verificados |
| **G01** | `npm run ci:build && npm run ci:test` | **PASS** | 7 paquetes compilados (`@mediabox/contracts`, `@mediabox/core`, `@mediabox/chat-core`, `mediabox-mcp`, `mcp-telegram-client`, `create-mediabox`, `@mediabox/ui`). 466 tests unitarios ejecutados, 0 skips, 0 fallos |
| **G07** | `npm run test:agent-replay` | **PASS** | 12/12 escenarios de repetición determinista pasando doble pasada (82 tests) |
| **G08** | `npm run smoke:node-bun && npm run smoke:desktop` | **PASS** | SQLite nativo en Node y Bun, inicialización de `LocalProvider` en Bun compilado, y smoke de subprocesos en Desktop (5/5 assertions) |
| **G09** | `npm run test:local-egress` | **PASS** | 14/14 tests ejecutados en las 6 suites NET-01..NET-06 |
| **Harness**| `npm run test:ci-harness` | **PASS** | 14/14 tests verificando rutas de fallo de gates G00..G09 y drivers de smoke |
| **Lab Canary** | `npm run smoke:local-canary:scripted` | **PASS** | Flujo canario de 3 turnos completado con score 3/3 sin contactar red externa |

---

## 4. Estado de Entrega y Traspaso a Fase P11 (Parte 2 de PR05)

Con la implementación y verificación de los Pasos 1, 2 y 3:
1. Queda sellada y certificada la **Fase P10** (Parte 1 de PR05).
2. Se satisface plenamente el **Gate G09** (`gate/local-egress`).
3. La base de código queda lista para ejecutar la **Fase P11** (Parte 2 de PR05):
   - Integración y ejecución de la suite de evaluación de modelos locales (`npm run eval:local`).
   - Verificación de los umbrales fijos del contrato de evaluación (`docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json`).
   - Validación del **Gate G10** (`gate/model-quality`).
