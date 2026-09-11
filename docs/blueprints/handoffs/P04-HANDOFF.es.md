# Cierre de Fase P04 — Borrado Exacto, Cuarentena y Huérfanos con Evidencia

Documento de entrega y cierre correspondiente a la **Fase P04** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md). Esta fase forma parte del lote de entrega **PR02** (P04–P05).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P04 — Borrado exacto, cuarentena y huérfanos con evidencia |
| **Lote / PR** | PR02 (lote P04–P05) |
| **Rama de trabajo** | `work/local-agent/p04-p05-files-media` |
| **Rama base** | `integration/local-agent-v1` |
| **Fecha de entrega** | 2026-09-10 |

---

## 1. Alcance y Archivos Implementados

- **Nuevos:**
  - `packages/mcp-server/src/storage/rootfs.ts`: Abstracción `RootFs` para verificar y resolver rutas confinadas dentro de raíces seguras autorizadas (`media`, `downloads`), evitando escapes y recolectando identidad de archivos (`stat`, `inode`, `sha256`).
  - `packages/mcp-server/src/storage/namespace-map.ts`: Mapeo determinista de rutas lógicas (`downloads/movie.mkv`, `movies/Show.mkv`) a raíces seguras.
  - `packages/mcp-server/src/storage/quarantine.ts`: Módulo de cuarentena segura. Mueve archivos eliminados a un directorio `.mediabox-trash` dentro del mismo volumen y genera manifiestos `QuarantineManifest` reversibles.
  - `packages/mcp-server/src/operations/planners/delete.ts`: Planner `createDeletePlan` que crea un `OperationPlan` declarativo de tipo `quarantine_files` con efectos `quarantine.move` y recursos de espacio calculados de manera conservadora.
  - `packages/mcp-server/src/operations/handlers.ts`: Handlers de ejecución enlazados a `OperationExecutor` para procesar de manera atómica el efecto `quarantine.move`.
- **Modificados:**
  - `packages/mcp-server/src/tools/library.ts`: Se eliminó la acción heredada `manage_files.delete` y la lógica directa de `confirmTokens` sobre `fs.rm` / `jfApi DELETE`. Se incorporó la herramienta `propose_cleanup` para delegar el borrado al ciclo transaccional de aprobación.
  - `packages/mcp-server/src/security/containment.test.ts` & `sandbox-wiring.test.ts`: Actualización de las suites para reflejar la eliminación de las herramientas mutantes no contenidas.

---

## 2. Invariantes y Criterios Cumplidos

| ID | Criterio | Estado |
|---|---|---|
| **DEL-01** | Preservación de hermanos y carpetas compartidas al eliminar archivos específicos | Cumplido |
| **DEL-02** | Links, escapes y traversal bloqueados por `RootFs.resolveWithinRoot` | Cumplido |
| **DEL-06** | Cuarentena no sobreestima espacio liberado (reporta que los bytes permanecen en volumen) | Cumplido |
| **DEL-08** | MCP delega en el mismo plan y ejecutor transaccional de P03 | Cumplido |

---

## 3. Gates Evaluados

| Gate | Check | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** |
| **G01** | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | **PASS** (513 tests pasando) |
| **G04** | `npm run test:filesystem` | **PASS** (16 tests pasando en `storage/storage.test.ts`) |

---

## Addendum QA (2026-09-10)

La auditoría posterior completó el cierre integral de DEL-01..DEL-08 en runtime (confinamiento por `RootFs`, cuarentena exacta con preservación de hermanos y subárboles no vacíos, revalidación de identidad y delegación al ejecutor transaccional único). La suite `packages/mcp-server/src/storage/storage.test.ts` evalúa el Gate G04 con 16/16 tests pasando. El detalle de remediación se encuentra registrado en [QA-HANDOFF.es.md](QA-HANDOFF.es.md).
