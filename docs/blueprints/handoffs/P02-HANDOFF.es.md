# Cierre de Fase P02 — Identidad por Petición y Frontera Owner/Agente

Documento de delegación y cierre correspondiente a la **Fase P02** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md). Esta fase constituye la primera mitad del lote **PR01** (P02–P03).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P02 — Identidad por petición y frontera owner/agente |
| **Lote / PR** | PR01 (lote P02–P03) |
| **Rama de trabajo** | `work/local-agent/p02-p03-identity-operations` |
| **Rama base** | `integration/local-agent-v1` |
| **Responsable** | Seguridad |
| **Fecha de entrega** | 2026-09-10 |

---

## 1. Alcance y Archivos Modificados / Creados

- **Nuevos:**
  - `packages/mcp-server/src/security/session.ts`: `SessionManager` con ciclo de vida de sesiones delegadas, verificación de TTL y caducidad (`ERR_TOKEN_EXPIRED`), revocación explícita (`ERR_TOKEN_REVOKED`), e invalidación reactiva de transportes.
  - `packages/mcp-server/src/security/policy.ts`: Matriz canónica de roles y permisos según §4.1 (`owner-ui`, `agent-session`, `installer`, `executor`, `external-client`), función `assertCanAccess` y middleware `requirePolicy`.
  - `packages/mcp-server/src/security/identity.test.ts`: Suite exhaustiva para el Gate G02 que valida los criterios ID-01 a ID-05 (13 tests sobre HTTP real).
  - `docs/blueprints/handoffs/P02-HANDOFF.es.md`: Este registro formal de entrega.
- **Modificados:**
  - `packages/contracts/src/index.ts`: Tipos canónicos `Principal` y `PrincipalKind`.
  - `packages/mcp-server/src/auth.ts`: Integración con `SessionManager`, resolución de tokens estáticos y dinámicos, y guardias reforzados `isOwner` / `requireOwner`.
  - `packages/mcp-server/src/index.ts`: Enlace de sesiones MCP al `Principal` (`TransportSessionBinding`), verificación anti-secuestro de sesiones MCP ajenas (`ERR_SESSION_MISMATCH`), invalidación de transportes MCP ante revocación, y endpoints de administración de sesiones (`GET/POST /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-all`).
  - `package.json`: Actualización del script `test:security-contracts` para ejecutar todas las suites de seguridad bajo `packages/mcp-server/src/security` (51 tests totales).

---

## 2. Invariantes y Casos de Aceptación Cubiertos

| ID de Caso | Descripción | Evidencia / Test que lo valida |
|---|---|---|
| **ID-01** | Matriz completa identidad × ruta × acción coincide con la política. | `packages/mcp-server/src/security/identity.test.ts` -> **PASS** |
| **ID-02** | Intercalar dos sesiones/principales no mezcla contexto ni resultados, y las sesiones MCP no pueden ser secuestradas por otro principal. | `packages/mcp-server/src/security/identity.test.ts` (20 requests concurrentes + test de usurpación MCP con 403 code -32001) -> **PASS** |
| **ID-03** | Un agente autenticado no exporta secretos, cambia endpoint ni aprueba. | `packages/mcp-server/src/security/identity.test.ts` (403 `ERR_FORBIDDEN_AGENT` en `/api/setup/*`, `/api/setup/env-raw`, PATCH env, restarts y sesiones) -> **PASS** |
| **ID-04** | Revocación/caducidad invalida también una sesión MCP viva. | `packages/mcp-server/src/security/identity.test.ts` (401 `ERR_TOKEN_EXPIRED` por TTL, 401 `ERR_TOKEN_REVOKED`, y cierre reactivo de transporte MCP vivo tras revocación) -> **PASS** |
| **ID-05** | Bootstrap no puede reclamarse por un visitante de localhost. | `packages/mcp-server/src/security/identity.test.ts` (401 en `/api/setup/start`, `/api/setup/info`, etc. desde localhost con y sin Origin) -> **PASS** |

---

## 3. Gates Evaluados

| Gate | Check ejecutado | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** (Matriz e invariantes verificados) |
| **G01** | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | **PASS** (Build topológico limpio, 300 tests pasando, 0 skips) |
| **G02** | `npm run test:security-contracts` | **PASS** (51 tests de seguridad: 38 de contención P01 + 13 de identidad P02) |
| **Security Audit** | `npm audit --workspaces --omit=dev --audit-level=high` | **PASS** (0 vulnerabilidades en dependencias de producción) |

---

## 4. Evidencia de Ejecución Local y CI

```text
=== Gate G00: Validating Policy & Fixtures ===
✓ Gate G00 PASSED: Acceptance matrix, invariants, gates, and test sandbox verified.

=== Gate G01 / HAR-04: Running and Verifying All Test Suites ===
✓ @mediabox/chat-core: 16 tests passed, 0 skipped, 0 failed.
✓ @mediabox/core: 61 tests passed, 0 skipped, 0 failed.
✓ mediabox-mcp: 209 tests passed, 0 skipped, 0 failed.
✓ create-mediabox: 14 tests passed, 0 skipped, 0 failed.
✓ Gate G01 / HAR-04 PASSED: All registered package suites passed with zero skips (300 tests).

=== Gate G02: Security Contracts (P01 + P02) ===
✓ packages/mcp-server/src/security/containment.test.ts (38 tests)
✓ packages/mcp-server/src/security/identity.test.ts (13 tests)
Test Files  2 passed (2)
     Tests  51 passed (51)
```

---

## 5. Próximo Paso (Fase P03)

- **Objetivo:** Planes persistentes, aprobación humana y ejecutor único (`OP-01` a `OP-07`, Gates G02, G03 y G08).
- **Alcance previsto:**
  - Diseñar `OperationPlan`, `PlannedTarget`, `PlannedEffect`, `RecoveryPlan` y hash canónico SHA-256 (§4.2).
  - Persistencia con adaptadores SQLite (`node:sqlite` para Node y `bun:sqlite` para Bun).
  - Spike obligatorio de empaquetado transaccional en el sidecar compilado.
  - Máquina de estados: `planned → awaiting_approval → queued → running → verifying → succeeded`.
  - Reconciliación post-crash y prevención de replay o auto-aprobación del modelo.
