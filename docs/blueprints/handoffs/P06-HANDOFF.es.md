# Cierre de Fase P06 — Consultas Normalizadas y Acotadas

Documento de entrega y cierre correspondiente a la **Fase P06** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md). Esta fase forma parte del lote de entrega **PR03** (P06–P07).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P06 — Consultas normalizadas y acotadas |
| **Lote / PR** | PR03 (lote P06–P07) |
| **Rama de trabajo** | `work/local-agent/p06-p07-queries-catalog` |
| **Rama base** | `integration/local-agent-v1` |
| **Fecha de entrega** | 2026-09-10 |

---

## 1. Alcance y Archivos Implementados

- **Nuevos:**
  - `packages/mcp-server/src/queries/envelope.ts`: Constructores de `ToolEnvelope<T>` (`createToolEnvelope`, `createErrorEnvelope`) y serialización segura `safeSerializeEnvelope` que garantiza salida JSON 100% sintácticamente válida sin cortes de caracteres UTF-8 ni de surrogates (`QRY-02`).
  - `packages/mcp-server/src/queries/pagination.ts`: Paginación mediante cursores opacos firmados con HMAC-SHA256 (`createOpaqueCursor`, `verifyOpaqueCursor`, `paginateSlice`), vinculando `installationId`, `principalId`, `snapshotId` y expiración (`QRY-04`).
  - `packages/mcp-server/src/queries/budgets.ts`: Límites y tracker de presupuestos de consulta (`QueryBudgetTracker`): máx. 3 páginas, máx. 2 búsquedas de releases, respuesta máx. 8 KiB y control de cancelación inmediata (`AbortSignal`) (`QRY-06`).
  - `packages/mcp-server/src/queries/cache.ts`: `QueryCache` en memoria con aislamiento estricto multi-inquilino y multi-rol, expiración TTL e invalidación dirigida por etiquetas de eventos/mutaciones (`QRY-05`).
  - `packages/mcp-server/src/queries/clients.ts`: Clientes estructurados para Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent y PyLoad que reportan `completeness` y errores saneados, eliminando el antipatrón de silenciar caídas de servicios como ceros o listas vacías (`QRY-03`).
  - `packages/mcp-server/src/queries/queries.test.ts`: Suite de pruebas para el Gate G06 validando todos los criterios de P06 (`QRY-01` a `QRY-06`).
- **Modificados:**
  - `packages/contracts/src/index.ts`: Definición canónica de contratos `ToolEnvelope<T>`, `DataSourceStatus`, `EnvelopePage`, `EnvelopeBudget`, etc.
  - `package.json`: Script `test:queries` para evaluación del Gate G06.

---

## 2. Invariantes y Criterios Cumplidos

| ID | Criterio | Evidencia / Test | Estado |
|---|---|---|---|
| **QRY-01** | Fixture de 10.000 elementos entrega proyección válida dentro de presupuesto y total correcto | `packages/mcp-server/src/queries/queries.test.ts` (10k items paginados a 20 con totalItems exacto) | **Cumplido** |
| **QRY-02** | Unicode/campos enormes nunca cortan JSON | `packages/mcp-server/src/queries/queries.test.ts` (Texto de 300k chars con emojis y surrogates serializado a JSON válido ≤ 8 KiB) | **Cumplido** |
| **QRY-03** | Error parcial y dato ausente son distinguibles | `packages/mcp-server/src/queries/queries.test.ts` (`status: partial` y `unavailable` diferenciado de `ok` con `data: null`) | **Cumplido** |
| **QRY-04** | Cursor ajeno/cambiado/caducado se rechaza | `packages/mcp-server/src/queries/queries.test.ts` (Rechazo con `ERR_INVALID_CURSOR`, `ERR_EXPIRED_CURSOR`, `ERR_CURSOR_MISMATCH`) | **Cumplido** |
| **QRY-05** | Cache no mezcla instalaciones/permisos y se invalida tras cambios | `packages/mcp-server/src/queries/queries.test.ts` (Aislamiento entre tenants e invalidación selectiva por tags) | **Cumplido** |
| **QRY-06** | Cancelación y presupuesto impiden consultas ilimitadas | `packages/mcp-server/src/queries/queries.test.ts` (Límites de 3 páginas, 2 búsquedas de releases y `AbortSignal`) | **Cumplido** |

---

## 3. Gates Evaluados

| Gate | Check | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** |
| **G01** | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | **PASS** (513 tests pasando) |
| **G06** | `npm run test:queries` | **PASS** (31 tests pasando: 23 en `queries.test.ts` + 8 en `catalog-envelope.test.ts`) |

---

## Addendum QA (2026-09-10)

Las herramientas de catálogo se conectaron a las primitivas de P06 (presupuestos, tracking de páginas, serialización acotada y cursores firmados). Se agregaron 8 tests en `queries/catalog-envelope.test.ts` para verificar la serialización acotada bajo presupuestos estrictos, totalizando 31 tests en Gate G06.
