# Cierre de Fase P01 — Contención Inmediata de Autenticación y Mutaciones Heredadas

Documento de delegación y cierre correspondiente a la **Fase P01** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md). Esta fase concluye junto con P00 el lote de entrega **PR00**.

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P01 — Contención inmediata de autenticación y mutaciones heredadas |
| **Lote / PR** | PR00 (lote P00–P01) — [#11](https://github.com/JuanCMPDev/mediabox-mcp/pull/11) |
| **Rama de trabajo** | `fix/auth-delete-containment` |
| **Rama base** | `master` |
| **Responsable** | Integrador / Seguridad |
| **Fecha de entrega** | 2026-09-09 |

---

## 1. Alcance y Archivos Modificados / Creados

- **Nuevos:**
  - `packages/mcp-server/src/helpers/containment.ts`: Clase `MutationContainedError`, aserción `assertMutationAllowed(operation, reason)` y formateador MCP `containedMutationResult`.
  - `packages/mcp-server/src/security/containment.test.ts`: Suite exhaustiva del Gate G02 que valida los criterios SEC-01 a SEC-06 (38 tests).
  - `docs/blueprints/handoffs/P01-HANDOFF.es.md`: Este registro formal de entrega.
- **Modificados:**
  - `packages/mcp-server/src/auth.ts`: Retirada de `JellyfinOAuthProvider` (cierre de B01), tipado de `Principal` (`owner` vs `agent`), middleware de autorización `authMiddleware` endurecido y guardia `requireOwner` (cierre de B02 e INV-SEPARATION).
  - `packages/mcp-server/src/index.ts`: Retirada de rutas OAuth emisoras sustituidas por rechazo explícito 403 `ERR_OAUTH_DISABLED` (SEC-01), protección de `/api/setup` con `requireOwner` (SEC-05), y refactor de `createApp` para pruebas.
  - `packages/mcp-server/src/chat/loopback-client.ts`: Conexión de cliente loopback con `AGENT_API_KEY` en vez de `INTERNAL_API_KEY` (cierre de B02).
  - `packages/mcp-server/src/tools/library.ts`: Contención de `manage_library.create`, `manage_files.move`, `manage_files.delete` (cierre de B03), `rename_episodes` (!dryRun) y `fix_subtitles` (!dryRun, cierre de B07).
  - `packages/mcp-server/src/tools/downloads.ts`: Contención de `download_add`, `download_status.delete`, `download_status.organize`, `download_direct` y `cancel_downloads` (cierre de B04).
  - `packages/mcp-server/src/tools/maintenance.ts`: Contención de `cleanup_server` al aplicar mutaciones (cierre de B05 y B06) y `optimize_media.optimize`.
  - `packages/mcp-server/src/tools/sonarr.ts`: Contención de `series_search.add`, `series_remove`, `series_grab` y `series_import`.
  - `packages/mcp-server/src/tools/radarr.ts`: Contención de `movie_search.add`, `movie_remove`, `movie_grab` y `movie_import`.
  - `packages/mcp-server/src/api/dashboard.ts`: Contención con 403 de `POST /sessions/:id/stop` y `DELETE /downloads/qbit/:hash` (cierre de B08).
  - `packages/mcp-server/src/tools/sandbox-wiring.test.ts`: Actualización de pruebas para verificar la contención de operaciones destructivas bajo P01.
  - `packages/mcp-server/src/auth.test.ts`: Pruebas de asignación de `Principal` (`owner` vs `agent`) y `requireOwner`.
  - `package.json`: Incorporación del script `test:security-contracts` (Gate G02).
  - `.github/workflows/ci.yml`: Inclusión del job `gate/auth-boundaries (G02)`.

---

## 2. Invariantes y Casos de Aceptación Cubiertos

| ID de Caso | Descripción | Evidencia / Test que lo valida |
|---|---|---|
| **SEC-01** | Flujo anónimo de registro/authorize/token no obtiene acceso (cierre B01). | `packages/mcp-server/src/security/containment.test.ts` (5 tests -> 403 `ERR_OAUTH_DISABLED`) -> **PASS** |
| **SEC-02** | Token ajeno/expirado y session ID conocida no acceden a MCP ni REST (`INV-AUTH`). | `packages/mcp-server/src/security/containment.test.ts` (4 tests -> 401 Unauthorized) -> **PASS** |
| **SEC-03** | Cada acción mutante inventariada se rechaza antes de un efecto (`OPERATION_MUTATION_CONTAINED`). | `packages/mcp-server/src/security/containment.test.ts` (22 tests de herramientas y REST) -> **PASS** |
| **SEC-04** | Las reproducciones previas (B01, B03, B04) y el barrido global de downloads (B05) no destruyen datos. | `packages/mcp-server/src/security/containment.test.ts` (reproducciones con spies en 0 llamadas destructivas) -> **PASS** |
| **SEC-05** | Owner conserva bootstrap y lecturas mientras el agente no lee env/admin (`INV-SEPARATION`). | `packages/mcp-server/src/security/containment.test.ts` + `auth.test.ts` (403 `ERR_FORBIDDEN_AGENT`) -> **PASS** |
| **SEC-06** | Contratos de error y payloads estructurados cumplen especificación canónica. | `packages/mcp-server/src/security/containment.test.ts` (validación de payload y campos) -> **PASS** |
| **B01–B08** | Cierre completo de las 8 brechas críticas inventariadas en el blueprint. | Validado integralmente en el Gate G02. |

---

## 3. Gates Evaluados

| Gate | Check ejecutado | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** (Matriz válida, stubs temporales verificados) |
| **G01** | `npm run ci:build && npm run ci:typecheck && npm run ci:test` | **PASS** (Build topológico limpio, 287 tests unitarios pasando, 0 skips) |
| **G02** | `npm run test:security-contracts` | **PASS** (38 tests de límites de autenticación y contención de mutaciones) |
| **Security Audit** | `npm audit --workspaces --omit=dev --audit-level=high` | **PASS** (0 vulnerabilidades de dependencias de producción) |

---

## 4. Estado del Lote PR00

Con la finalización de **P00** y **P01**, el lote **PR00** se encuentra completamente implementado, probado y verificado según todos los requisitos del blueprint y la matriz canónica de aceptación.

- **Próxima Fase:** P02 (Identidad por petición y frontera owner/agente con tokens delegados de sesión).
