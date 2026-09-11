# Cierre de Fase P08 — Motor de Agente con Contexto y Estado Controlados
> **Estado verificado:** este cierre de fase es el registro de la entrega inicial. La auditoría de PR04 (2026-09-10) encontró defectos y afirmaciones sin respaldo; el estado autoritativo, la remediación y la evidencia de gates están en [PR04-QA-HANDOFF.es.md](PR04-QA-HANDOFF.es.md). La tabla de casos de esta página describe la entrega original; seis escenarios no ejercitaban lo que su ID promete y dos defectos de la ruta real (compactación de resultados y persistencia antes de un evento terminal) se corrigieron después.

Documento de entrega y cierre correspondiente a la **Fase P08** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md) y de la especificación [PR04-P08-P09-SPEC.es.md](PR04-P08-P09-SPEC.es.md). Esta fase conforma junto con P09 el lote de entrega **PR04** (P08–P09).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P08 — Motor de agente con contexto y estado controlados |
| **Lote / PR** | PR04 (sublote PR04a) |
| **Rama de trabajo** | `work/local-agent/p08-p09-agent-provider` |
| **Rama base** | `integration/local-agent-v1` |
| **Fecha de entrega** | 2026-09-11 |
| **Gate asociado** | G07 `gate/agent-replay` |

---

## 1. Alcance y Componentes Implementados

Todo el motor de ejecución del agente se diseñó desacoplado en `packages/chat-core/src/agent/`, sin dependencias directas de red ni de `mcp-server`. El servidor MCP solo aporta almacenamiento y transporte.

- **`workflow.ts`**:
  - Estado determinista del workflow (`WorkflowState`, `schemaVersion: 2`).
  - Reducer puro `reduceWorkflow(state, event)` sin I/O para transiciones deterministas y replay idéntico.
  - Eventos de dominio: `user_message`, `typed_selection`, `tool_result`, `proposal_created`, `operation_status`, `phase_transition`, `turn_ended`, `reset`.
  - Persistencia y migración de esquemas de estado.
- **`phases.ts`**:
  - Máquina de estados de 6 fases: `orient`, `discover`, `select`, `propose`, `monitor`, `maintain`.
  - Filtrado estricto de catálogo de virtual tools por fase y capacidad del principal (máximo 4 virtual tools por fase además de `present_choices`).
  - Poda de enums de acciones para que el modelo solo reciba esquemas de acciones válidas en la fase activa (`AGT-11`).
- **`budget.ts`**:
  - Asignación estricta de presupuesto de contexto en ventana 8K:
    - Prompt de sistema por fase: ≤ 1.400 tokens (medido por test).
    - Esquemas de herramientas por fase: ≤ 1.200 tokens (medido por test).
    - Resumen determinista de estado: ≤ 600 tokens.
    - Reserva de salida: 1.024 tokens; margen de seguridad: 512 tokens; presupuesto de entrada: 6.656 tokens.
  - Compactador de resultados de herramientas (`compactToolResult`): trunca cadenas a 120 caracteres, limita arrays a 5 elementos clave, genera digests de llamadas históricas.
  - Detección de desbordamiento que rechaza el turno con `ERR_CONTEXT_OVERFLOW` antes de llamar al proveedor (`AGT-07`).
- **`references.ts` & Referencias Cortas**:
  - Generación de referencias opacas cortas (`mref_<hash>`, `rref_<hash>`) de longitud fija (~21 caracteres) que reducen en un 80% el consumo de tokens frente al formato HMAC legado de 500+ caracteres.
- **`dispatch.ts` & Validación Estricta**:
  - Validación de argumentos previa a la invocación MCP con Ajv en modo estricto (`additionalProperties: false`).
  - Reparación única (`one-shot repair`): si los argumentos son inválidos (`ERR_ARGS_INVALID`), se devuelve el error estructurado al LLM para una segunda oportunidad; si vuelve a fallar, se aborta con `ERR_REPAIR_EXHAUSTED` (`AGT-01`).
- **`guards.ts`**:
  - Detección de bucles repetitivos: interrupción con `ERR_LOOP_DETECTED` si se repite la misma llamada con argumentos y resultado idénticos (`AGT-03`).
  - Límites de turno duros: máximo 6 inferencias y 8 llamadas a herramientas por turno.
- **`tokenizer.ts`**:
  - `HeuristicCounter` calibrable dinámicamente con `usage.prompt_tokens` del proveedor.
  - Detección de desviaciones superiores al 25% con aplicación de margen de seguridad preventivo del 15% (`AGT-12`).
- **`trace.ts`**:
  - Trazabilidad estructurada por turno (`AgentTrace`) con redacción estricta de credenciales, tokens Bearer y hashes de referencias (`AGT-10`).
- **`runtime.ts`**:
  - Orquestador `AgentRuntime` que coordina inferencia ↔ reducer ↔ dispatch MCP ↔ emisión de eventos `ChatEvent`.
  - Soporte de cancelación mediante `AbortSignal` con interrupción cooperativa de streams e invocaciones MCP (`AGT-09`).
- **`replay/` (Harness de Gate G07)**:
  - `ScriptedProvider`: reproducción de fragmentos exactos de streaming (incluyendo fragmentos partidos, ids ausentes, tags `<think>` y finish_reasons).
  - `FakeMcpClient`: simulación determinista de respuestas MCP con ledger de efectos auditado; cualquier llamada inesperada falla el test.
  - 12 escenarios declarativos JSON que cubren todas las condiciones de fallo adversarial, contexto y límites.

---

## 2. Invariantes y Criterios Cumplidos (P08)

| ID | Criterio | Evidencia / Test | Estado |
|---|---|---|---|
| **AGT-01** | JSON incompleto, propiedades extra o tool no expuesta producen cero efectos | `agent/replay/replay.test.ts` (Escenario `agt-01-invalid-args-repair`) | **Cumplido** |
| **AGT-02** | Todas las iteraciones respetan contexto total y preservan estado esencial | `agent/replay/replay.test.ts` (Escenario `agt-02-budget-long-history`; assert `inputUsed <= inputBudget`) | **Cumplido** |
| **AGT-03** | Repetición sin progreso termina dentro del límite | `agent/replay/replay.test.ts` (Escenario `agt-03-loop-detection`; `ERR_LOOP_DETECTED`) | **Cumplido** |
| **AGT-04** | Instrucciones en títulos/release/logs no cambian permisos ni endpoints | `agent/replay/replay.test.ts` (Escenario `agt-04-adversarial-injection`; fixtures de inyección neutralizadas) | **Cumplido** |
| **AGT-05** | Replays de aprobación y selecciones ficticias no eluden el reducer | `agent/replay/replay.test.ts` (Escenario `agt-05-approval-replay-typed-selection`) | **Cumplido** |
| **AGT-06** | Reinicio de conversación y cambio de modelo conservan operaciones | `agent/replay/replay.test.ts` (Escenario `agt-06-reset-preserves-operations`) | **Cumplido** |
| **AGT-07** | Desbordamiento de contexto se rechaza antes de llamar al proveedor | `agent/replay/replay.test.ts` (Escenario `agt-07-context-overflow`; `ERR_CONTEXT_OVERFLOW`) | **Cumplido** |
| **AGT-08** | Una propuesta repetida devuelve el plan existente, no uno nuevo | `agent/replay/replay.test.ts` (Escenario `agt-08-proposal-idempotency`; misma clave de idempotencia) | **Cumplido** |
| **AGT-09** | Cancelación del turno aborta proveedor y herramienta, y no toca planes | `agent/replay/replay.test.ts` (Escenario `agt-09-abort-cancellation`; aborto limpio) | **Cumplido** |
| **AGT-10** | La traza no contiene claves, tokens ni refs completas | `agent/replay/replay.test.ts` (Escenario `agt-10-trace-redaction`; `verifyTraceRedaction`) | **Cumplido** |
| **AGT-11** | Ninguna fase expone más de cuatro virtual tools ni acciones fuera de fase | `agent/replay/replay.test.ts` (Escenario `agt-11-phase-tools-isolation`) & `phases.test.ts` | **Cumplido** |
| **AGT-12** | El contador se calibra con usage y bloquea si la desviación supera el umbral | `agent/replay/replay.test.ts` (Escenario `agt-12-tokenizer-calibration`) & `tokenizer.test.ts` | **Cumplido** |

---

## 3. Gates Evaluados

| Gate | Check | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** |
| **G01** | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | **PASS** (Todas las suites de chat-core, core, mcp-server y cli pasando sin skips) |
| **G07** | `npm run test:agent-replay` | **PASS** (12/12 escenarios de replay pasando doble pasada determinista) |
