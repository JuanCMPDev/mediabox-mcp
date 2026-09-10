# Cierre de Fase P00 — Entorno de Pruebas Seguro

Documento de delegación y cierre correspondiente a la **Fase P00** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P00 — Entorno de pruebas que no pueda tocar bibliotecas reales |
| **Lote / PR** | PR00 (lote P00–P01) — [#11](https://github.com/JuanCMPDev/mediabox-mcp/pull/11) |
| **Rama de trabajo** | `fix/auth-delete-containment` |
| **Rama base** | `master` |
| **Responsable** | Integrador / Seguridad |
| **Fecha de entrega** | 2026-09-09 |

---

## 1. Alcance y Archivos Modificados / Creados

- **Nuevos:**
  - `docs/blueprints/LOCAL-AGENT-ACCEPTANCE.json`: Matriz de aceptación canónica (invariantes, gates, casos P00..P13).
  - `docs/blueprints/LOCAL-AGENT-HANDOFF.es.md`: Plantilla de delegación y handoff.
  - `docs/blueprints/handoffs/P00-HANDOFF.es.md`: Registro formal de cierre de P00.
  - `packages/core/src/testing/test-installation.ts`: Sandbox `TestInstallation`, `EffectLedger`, reloj inyectable y stubs.
  - `packages/core/src/testing/test-installation.test.ts`: Pruebas unitarias para HAR-01, HAR-02 y HAR-03.
  - `scripts/ci/check-policy.mjs`: Validador automatizado del Gate G00.
  - `scripts/ci/verify-suites.mjs`: Ejecutor y verificador de suites no vacías y sin skips (Gate G01 / HAR-04).
- **Modificados:**
  - `packages/mcp-server/src/tools/sandbox-wiring.test.ts`: Aislamiento de `fs.rm` de `node:fs/promises` para evitar borrados reales (cierre de B11).
  - `package.json`: Scripts de CI (`ci:policy`, `ci:build`, `ci:typecheck`, `ci:test`), build topológico y overrides de dependencias.
  - `packages/mcp-server/package.json` y `packages/chat-core/package.json`: Retirada de `--passWithNoTests`.
  - `.github/workflows/ci.yml`: Integración formal de los gates G00 y G01 en GitHub Actions.

---

## 2. Invariantes y Casos de Aceptación Cubiertos

| ID de Caso | Descripción | Evidencia / Test que lo valida |
|---|---|---|
| **HAR-01** | Todas las escrituras y borrados de test quedan estrictamente bajo la raíz temporal de TestInstallation. | `packages/core/src/testing/test-installation.test.ts` -> PASS |
| **HAR-02** | Symlink hacia fuera o marker aleatorio incorrecto bloquea el teardown antes de cualquier borrado. | `packages/core/src/testing/test-installation.test.ts` -> PASS |
| **HAR-03** | El ledger de efectos detecta operaciones imprevistas o no registradas y sale con código no cero. | `packages/core/src/testing/test-installation.test.ts` -> PASS |
| **HAR-04** | Todos los paquetes con suites registradas se ejecutan; cero suites vacías o skips imprevistos. | `scripts/ci/verify-suites.mjs` (244 tests, 0 skips, 0 fallos) -> PASS |
| **B11** | CI ejecuta todas las suites y sandbox-wiring no toca rutas de disco reales. | `packages/mcp-server/src/tools/sandbox-wiring.test.ts` -> PASS |

---

## 3. Gates Evaluados

| Gate | Check ejecutado | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** (Local y GitHub Actions 20s) |
| **G01** | `npm run ci:build && npm run ci:typecheck && npm run ci:test` | **PASS** (Local y GitHub Actions 50s) |
| **Security Audit** | `npm audit --workspaces --omit=dev --audit-level=high` | **PASS** (0 vulnerabilidades con overrides) |
| **Docker Build** | Smoke test de builds de imágenes Docker | **PASS** (GitHub Actions 2m 6s) |

---

## 4. Evidencia de Ejecución Local y CI

- **GitHub Actions Run:** [Run 34379001640](https://github.com/JuanCMPDev/mediabox-mcp/actions/runs/34379001640)
- **Pull Request:** [PR #11](https://github.com/JuanCMPDev/mediabox-mcp/pull/11)
- **Suites Unitarias:**
  - `@mediabox/chat-core`: 16 tests pasados
  - `@mediabox/core`: 61 tests pasados
  - `mediabox-mcp`: 153 tests pasados
  - `create-mediabox`: 14 tests pasados
  - Total: 244 tests pasando sin fallos ni omisiones.

---

## 5. Próximo Paso (Fase P01)

- **Objetivo:** Contención inmediata de autenticación y mutaciones heredadas (SEC-01 a SEC-06, Gate G02).
- **Archivos previstos:**
  - Retirar emisor OAuth inseguro en `packages/mcp-server/src/auth.ts` e `index.ts`.
  - Bloquear / contener mutaciones multimedia heredadas no autorizadas hasta P03.
  - Separar acceso admin/owner de las credenciales del agente (`loopback-client.ts`).
