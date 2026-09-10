# Cierre de Fase P03 — Planes Persistentes, Aprobación y Ejecutor Único

Documento de delegación y cierre correspondiente a la **Fase P03** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md). Esta fase concluye junto con P02 el lote de entrega **PR01** (P02–P03).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P03 — Planes persistentes, aprobación y ejecutor único |
| **Lote / PR** | PR01 (lote P02–P03) |
| **Rama de trabajo** | `work/local-agent/p02-p03-identity-operations` |
| **Rama base** | `integration/local-agent-v1` |
| **Responsable** | Seguridad / Datos |
| **Fecha de entrega** | 2026-09-10 |

---

## 1. Alcance y Archivos Modificados / Creados

- **Nuevos:**
  - `packages/mcp-server/src/operations/sqlite/contract.ts`: Contrato uniforme para adaptadores SQLite (`DatabaseAdapter`, `StatementAdapter`).
  - `packages/mcp-server/src/operations/sqlite/node-adapter.ts`: Adaptador nativo `node:sqlite` (`DatabaseSync`) para Node 22+.
  - `packages/mcp-server/src/operations/sqlite/bun-adapter.ts`: Adaptador nativo `bun:sqlite` (`Database`) para Bun y sidecar compilado.
  - `packages/mcp-server/src/operations/sqlite/factory.ts`: Detector de runtime y factoría para instanciar el adaptador correspondiente.
  - `packages/mcp-server/src/operations/canonical-hash.ts`: Serialización determinista y cálculo de hash SHA-256 canónico del manifiesto (§4.2).
  - `packages/mcp-server/src/operations/schema.ts`: DDL, tablas relacionales (`operation_plans`, `operation_steps`, `operation_leases`), índices y migraciones `PRAGMA user_version`.
  - `packages/mcp-server/src/operations/store.ts`: `OperationStore` transaccional ACID, máquina de estados, control de TTL (5 min), leases y aprobación idempotente.
  - `packages/mcp-server/src/operations/planner.ts`: Creador de planes `OperationPlan`, verificación de precondiciones y firma canónica.
  - `packages/mcp-server/src/operations/reconcile.ts`: Reconciliador post-crash al arranque del servidor (`reconcilePostCrash`) para marcar operaciones en vuelo interrumpidas y evitar efectos duplicados inciertos.
  - `packages/mcp-server/src/operations/executor.ts`: Bucle ejecutor único (`OperationExecutor`) con claim compare-and-set, renovación de lease por heartbeat y registro atómico de pasos.
  - `packages/mcp-server/src/operations/default-store.ts`: Singleton compartido y ejecución de reconciliación al inicio.
  - `packages/mcp-server/src/operations/operations.test.ts`: Suite exhaustiva para el Gate G03 que valida los criterios `OP-01` a `OP-07` (16 tests pasando).
  - `packages/mcp-server/src/api/operations.ts`: Endpoints REST `/api/operations/plans` (propose, list, get, approve, reject, cancel) con control de política estricto.
  - `packages/mcp-server/src/tools/operations.ts`: Herramienta MCP de sólo lectura `operation_status` (sin herramientas `approve` ni `commit` para el modelo).
  - `packages/ui/src/components/OperationApprovalModal.tsx`: Componente de UI para visualizar objetivos, efectos con advertencia de pérdidas irreversibles, cuenta regresiva de 5 minutos, botones de aprobación/rechazo y progreso de pasos.
  - `scripts/ci/smoke-node-bun.mjs`: Spike de Gate G08 que verifica transacciones SQLite tanto en Node como en el ejecutable compilado con `bun build --compile`.
  - `docs/blueprints/handoffs/P03-HANDOFF.es.md`: Este registro formal de entrega.
- **Modificados:**
  - `packages/contracts/src/index.ts`: Exportación de tipos canónicos `OperationPlan`, `PlannedTarget`, `PlannedEffect`, `Precondition`, `RecoveryPlan`, `OperationStatus`, `OperationStepRecord`, `OperationPlanRecord`, etc.
  - `packages/mcp-server/src/index.ts`: Montaje del router `/api/operations` y reconciliación al inicio.
  - `packages/mcp-server/src/security/policy.ts`: Incorporación del recurso `operations` a la matriz de políticas (agentes solo leen/proponen; aprobación restringida a `owner-ui`).
  - `packages/mcp-server/src/tools/register.ts`: Registro de `operation_status` en el servidor MCP.
  - `package.json`: Scripts `test:operations` (Gate G03) y `smoke:node-bun` (Gate G08).
  - `.gitignore`: Ignorado de bases de datos sqlite locales (`*.db`, `*.db-wal`, `*.db-shm`, etc.).

---

## 2. Invariantes y Casos de Aceptación Cubiertos

| ID de Caso | Descripción | Evidencia / Test que lo valida |
|---|---|---|
| **OP-01** | Un modelo que propone y simula "sí" no genera trabajo autorizado (`INV-APPROVAL`). | `packages/mcp-server/src/operations/operations.test.ts` (403 `ERR_FORBIDDEN_AGENT` al intentar aprobar; MCP no expone herramientas `approve`/`commit`) -> **PASS** |
| **OP-02** | Doble clic / replay produce una sola operación (`INV-APPROVAL`). | `packages/mcp-server/src/operations/operations.test.ts` (Aprobación idempotente devuelve la misma operación sin re-encolar ni duplicar efectos) -> **PASS** |
| **OP-03** | Cambiar target/destino/perfil/hash exige nuevo plan (`INV-TARGET`). | `packages/mcp-server/src/operations/operations.test.ts` (Hash canónico SHA-256 detecta cualquier alteración y rechaza con `ERR_MANIFEST_HASH_MISMATCH`) -> **PASS** |
| **OP-04** | Crash antes/después de claim y de cada paso conserva/reconcilia estado sin repetir efectos inciertos (`INV-RECOVERY`). | `packages/mcp-server/src/operations/operations.test.ts` (`reconcilePostCrash` marca planes interrumpidos, libera leases huérfanas y preserva cola limpia) -> **PASS** |
| **OP-05** | Permisos de otro owner/conversación no aceptan el plan (`INV-SEPARATION`). | `packages/mcp-server/src/operations/operations.test.ts` (403 `ERR_FORBIDDEN_SCOPE` ante discrepancia de owner o de `installationId`) -> **PASS** |
| **OP-06** | DB abre, migra y recupera transacciones en Node y Bun compilado. | `packages/mcp-server/src/operations/operations.test.ts` y `scripts/ci/smoke-node-bun.mjs` (Rollback verificado, DDL y sidecar compilado ejecutable) -> **PASS** |
| **OP-07** | Reinicio, expiración, cancelación y progreso se muestran correctamente en UI. | `packages/mcp-server/src/operations/operations.test.ts` (TTL de 5 min transiciona a `expired`, rechaza aprobación con 410, soporte de `cancelled` y avance de pasos en ejecutor) -> **PASS** |

---

## 3. Gates Evaluados

| Gate | Check ejecutado | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** (Matriz, invariantes, gates y sandbox verificados) |
| **G01** | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | **PASS** (316 tests pasando sin skips en todo el monorepo) |
| **G02** | `npm run test:security-contracts` | **PASS** (51 tests de seguridad P01 + P02 pasando) |
| **G03** | `npm run test:operations` | **PASS** (16 tests de estados, persistencia y planes P03 pasando) |
| **G08** | `npm run smoke:node-bun` | **PASS** (Spike de SQLite en Node 22 y binario Bun compilado con transacciones) |
| **Security Audit** | `npm audit --workspaces --omit=dev --audit-level=high` | **PASS** (0 vulnerabilidades de dependencias de producción) |

---

## 4. Evidencia de Ejecución Local y CI

```text
=== Gate G00: Validating Policy & Fixtures ===
✓ Gate G00 PASSED: Acceptance matrix, invariants, gates, and test sandbox verified.

=== Gate G01 / HAR-04: Running and Verifying All Test Suites ===
✓ @mediabox/chat-core: 16 tests passed, 0 skipped, 0 failed.
✓ @mediabox/core: 61 tests passed, 0 skipped, 0 failed.
✓ mediabox-mcp: 225 tests passed, 0 skipped, 0 failed.
✓ create-mediabox: 14 tests passed, 0 skipped, 0 failed.
✓ Gate G01 / HAR-04 PASSED: All registered package suites passed with zero skips (316 tests totales).

=== Gate G02: Security Contracts ===
✓ packages/mcp-server/src/security/containment.test.ts (38 tests)
✓ packages/mcp-server/src/security/identity.test.ts (13 tests)
Test Files  2 passed (2)
     Tests  51 passed (51)

=== Gate G03: Operations Contracts ===
✓ packages/mcp-server/src/operations/operations.test.ts (16 tests)
Test Files  1 passed (1)
     Tests  16 passed (16)

=== Gate G08 Spike: Validating Node & Bun SQLite Persistence ===
1. Testing Node.js 22+ native SQLite (node:sqlite)...
✓ Node.js 22+ node:sqlite verified.
2. Testing Bun runtime SQLite (bun:sqlite)...
Bun version detected: 1.3.13
✓ Bun bun:sqlite verified.
3. Testing compiled executable packaging spike with SQLite...
✓ Compiled sidecar binary successfully executed SQLite transactions!
✓ Gate G08 Spike PASSED: Node.js and Bun compiled SQLite packaging verified.
```

---

## 5. Estado del Lote PR01 y Próximo Paso (Fase P04)

Con la culminación de **P02** e **P03**, el lote **PR01** (`work/local-agent/p02-p03-identity-operations`) queda íntegramente implementado y verificado.
Las mutaciones multimedia heredadas continúan contenidas de forma segura, canalizándose ahora a través del motor formal de planes de operación, aprobación humana y ejecutor único.

- **Próximo Lote:** PR02 (Fases P04–P05)
- **Próxima Fase:** P04 — Borrado exacto, cuarentena y huérfanos con evidencia (`DEL-01` a `DEL-08`, Gate G04).
