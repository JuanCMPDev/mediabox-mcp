# Cierre de Fase P07 — Identidad Multimedia, Ranking y Descarga Verificable

Documento de entrega y cierre correspondiente a la **Fase P07** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md). Esta fase concluye junto con P06 el lote de entrega **PR03** (P06–P07).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P07 — Identidad multimedia, ranking y descarga verificable |
| **Lote / PR** | PR03 (lote P06–P07) |
| **Rama de trabajo** | `work/local-agent/p06-p07-queries-catalog` |
| **Rama base** | `integration/local-agent-v1` |
| **Fecha de entrega** | 2026-09-10 |

---

## 1. Alcance y Archivos Implementados

- **Nuevos:**
  - `packages/mcp-server/src/queries/references.ts`: Generación y validación de referencias opacas `mediaRef` y `releaseRef` firmadas con HMAC-SHA256. Encriptan/ocultan IDs y URLs sensibles de indexadores, con verificación estricta de tiempo de expiración (30 min) y tipo de entidad (`CAT-02`).
  - `packages/mcp-server/src/queries/catalog.ts`: Búsqueda agregada en bibliotecas e indexadores con desambiguación canónica de homónimos y remakes mediante IDs estables (`tmdbId`, `tvdbId`, `imdbId`, año) (`CAT-01`).
  - `packages/mcp-server/src/queries/releases.ts`: Motor de ranking determinista versionado (`v1.0.0`) con aplicación de restricciones duras (seeders > 0, idioma estricto donde el idioma desconocido es rechazado para audio latino), preferencias de resolución y razones explicativas estructuradas (`CAT-03`).
  - `packages/mcp-server/src/operations/planners/download.ts`: Planificador declarativo `createDownloadPlan` que genera un `OperationPlan` para aprobación humana, previene duplicados en colas activas y nunca cancela descargas ajenas salvo plan explícito de `media_download_replacement` (`CAT-05`).
  - `packages/mcp-server/src/tools/catalog.ts`: Nuevas herramientas MCP unificadas de consulta y propuesta: `search_media`, `media_details`, `find_releases`, `propose_download`, `library_summary` y `storage_summary`.
- **Modificados:**
  - `packages/contracts/src/index.ts`: Contratos `MediaItem`, `ReleaseCandidate`, `TypedSelection` y extensión de `ChatChoiceItem` con propiedad `selection`.
  - `packages/mcp-server/src/operations/handlers.ts`: Handler para el paso `download.grab` con reconciliación por identidad (`reconcileGrab`) tras timeouts de red (`CAT-06`).
  - `packages/mcp-server/src/tools/jellyfin.ts`: Renombrado de la herramienta legada interna de búsqueda a `jellyfin_search` para dar paso a la fachada unificada `search_media`.
  - `packages/mcp-server/src/tools/register.ts`: Registro de `registerCatalogTools`.
  - `packages/ui/src/components/chat/ChoiceCards.tsx`: Soporte para emisión de selecciones tipadas (`TypedSelection`) al pulsar tarjetas interactivas de chat (`CAT-04`).

---

## 2. Invariantes y Criterios Cumplidos

| ID | Criterio | Evidencia / Test | Estado |
|---|---|---|---|
| **CAT-01** | Obras homónimas/años/remakes no se mezclan | `packages/mcp-server/src/queries/queries.test.ts` (*Pet Sematary* 1989 y 2019 reciben IDs y `mediaRef` disjuntos) | **Cumplido** |
| **CAT-02** | Referencias expiradas/ajenas/tipo incorrecto no se ejecutan | `packages/mcp-server/src/queries/queries.test.ts` (Rechazos `ERR_EXPIRED_REFERENCE`, `ERR_REFERENCE_WRONG_TYPE`, `ERR_REFERENCE_MISMATCH`) | **Cumplido** |
| **CAT-03** | Ranking determinista conserva restricciones y trata idioma desconocido correctamente | `packages/mcp-server/src/queries/queries.test.ts` (Dead torrents e idioma desconocido rechazados ante audio latino estricto; razones transparentes) | **Cumplido** |
| **CAT-04** | Clic de tarjeta no genera instrucciones libres ni amplía alcance | `packages/mcp-server/src/queries/queries.test.ts` & `packages/ui/src/components/chat/ChoiceCards.tsx` (Emisión de `TypedSelection` estructurada) | **Cumplido** |
| **CAT-05** | Repetir una solicitud no duplica ni cancela una descarga ajena | `packages/mcp-server/src/queries/queries.test.ts` (Duplicado detectado con `ERR_DUPLICATE_DOWNLOAD`; `cancel_previous` solo en replacement explícito) | **Cumplido** |
| **CAT-06** | Timeout de grab se reconcilia por identidad y muestra estados submitted/available | `packages/mcp-server/src/queries/queries.test.ts` (Reconciliación exitosa vía `reconcileGrab` consultando colas activas) | **Cumplido** |

---

## 3. Gates Evaluados

| Gate | Check | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** |
| **G01** | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | **PASS** (513 tests pasando) |
| **G02** | `npm run test:security-contracts` | **PASS** (48 tests pasando) |
| **G03** | `npm run test:operations` | **PASS** (36 tests pasando: 16 en `operations.test.ts` + 10 en `executor-hardening.test.ts` + 10 en `download-grab.test.ts`) |
| **G06** | `npm run test:queries` | **PASS** (31 tests pasando: 23 en `queries.test.ts` + 8 en `catalog-envelope.test.ts`) |

---

## Addendum QA (2026-09-10)

El flujo de `download.grab` implementa ejecución real y reconciliación determinista por GUID e identidad. Se añadieron las suites `operations/download-grab.test.ts` (10 tests) y `operations/executor-hardening.test.ts` (10 tests), consolidando 36 tests en Gate G03. Las herramientas MCP vinculan el contexto de sesión de la invocación para scopes de plan correctos.
