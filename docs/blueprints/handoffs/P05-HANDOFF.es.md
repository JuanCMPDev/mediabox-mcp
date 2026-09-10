# Cierre de Fase P05 — Movimientos y Formatos Recuperables

Documento de entrega y cierre correspondiente a la **Fase P05** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md). Esta fase concluye junto con P04 el lote de entrega **PR02** (P04–P05).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P05 — Movimientos y formatos recuperables |
| **Lote / PR** | PR02 (lote P04–P05) |
| **Rama de trabajo** | `work/local-agent/p04-p05-files-media` |
| **Rama base** | `integration/local-agent-v1` |
| **Fecha de entrega** | 2026-09-10 |

---

## 1. Alcance y Archivos Implementados

- **Nuevos:**
  - `packages/mcp-server/src/storage/media-jobs.ts`: Separación estricta de `inspect`, `remux`, `subtitle-convert` y `transcode` con perfiles cerrados predefinidos (`cpu_av1_transcode`, `cpu_hevc_transcode`). Validación de salida con `ffprobe` antes de reemplazar el original y creación de backups de recuperación.
  - `packages/mcp-server/src/operations/planners/media-format.ts`: Planner `createMediaFormatPlan` para generar planes declarativos `media_format_conversion` con estimación de recursos de disco para staging.
- **Modificados:**
  - `packages/mcp-server/src/tools/maintenance.ts`: Eliminación de la herramienta heredada `optimize_media`. Incorporación de `inspect_format` (de sólo lectura) y `propose_media_job` (que genera planes para aprobación).
  - `packages/mcp-server/src/operations/handlers.ts`: Handlers de pasos registrados en `OperationExecutor` para `media.remux`, `media.transcode` y `media.subtitle-convert`.
  - `packages/mcp-server/src/index.ts`: Inicialización del ejecutor global de operaciones en segundo plano (`globalOperationExecutor.start()`).

---

## 2. Invariantes y Criterios Cumplidos

| ID | Criterio | Estado |
|---|---|---|
| **MED-01** | Salida inválida preserva el archivo original; staging validado con `ffprobe` | Cumplido |
| **MED-02** | Reemplazo recuperable con backup antes de swap | Cumplido |
| **MED-04** | Perfiles cerrados deterministas; cero comandos FFmpeg arbitrarios redactados por el LLM | Cumplido |
| **MED-06** | Soporte de cancelación mediante `AbortSignal` durante la transcodificación | Cumplido |
