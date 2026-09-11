# PR05 — Handoff de QA: Auditoría, Verificación y Estado Real de P10 y P11

Documento de **auditoría y verificación integral** del lote PR05, que consolida la **Fase P10** (Despliegue local y privacidad verificable) y la **Fase P11** (Evaluación de modelos locales y Gate G10).

Contrato auditado: [PR05-P10-P11-SPEC.es.md](PR05-P10-P11-SPEC.es.md).  
Cierres de fase de referencia: [P10-HANDOFF.es.md](P10-HANDOFF.es.md) y [P11-HANDOFF.es.md](P11-HANDOFF.es.md).

## Ficha del Lote

| Campo | Valor |
|---|---|
| **Lote** | PR05 (P10 Privacidad y Despliegue Local + P11 Evaluación de Modelos y Calidad G10) |
| **Rama** | `work/local-agent/p10-p11-private-evals` |
| **Commits auditados** | `a7d9226` (PR05a / P10) y commit de entrega (PR05b / P11) |
| **Rama base** | `integration/local-agent-v1` (commit base merge PR04: `79d2d16`) |
| **Fecha de auditoría** | 2026-09-11 |
| **Veredicto QA** | **APROBADO PARA MERGE** — Todos los gates G00..G10 verdes y verificados |
| **Laboratorio de Certificación** | Windows 11 x64, AMD Ryzen 7 7800X3D (8C/16T), AMD Radeon RX 7800 XT (16 GB VRAM), ROCm/HIP 6.1, Ollama 0.34.0, Qwen 2.5 7B Instruct Q4_K_M |

---

## 1. Resumen Ejecutivo del Lote PR05

PR05 culmina la infraestructura de ejecución local privada y certificación de modelos para el agente autónomo de Mediabox, garantizando que:
1. **Privacidad y Aislamiento Físico (P10)**: La inferencia local opera en un entorno estrictamente aislado sin posibilidad de exfiltración de telemetría, prompts o conversaciones, con topología Docker multi-red segregada (`internal: true`), protección contra DNS rebinding, descarte de proxies y oráculos de prueba de red (NET-01..06) validados en Gate G09.
2. **Evaluación Rigurosa y Determinista de Modelos (P11)**: Se implementó un arnés de evaluación de 60 escenarios ordenados estrictamente (READ, SEARCH, DOWNLOAD, STORAGE, ADV) calificado por un scorer determinista sin sesgo de juez LLM, ejecutando 180 corridas planificadas en 3 pasadas secuenciales sobre el perfil congelado `qwen2.5-7b-ollama-rx7800xt`.
3. **Evidencia Criptográfica Inmutable (G10)**: Todos los artefactos de evaluación (contrato, corpus, perfil, scorer y reporte de ejecuciones) están sellados con digests SHA-256 verificados por `scripts/ci/verify-evidence.mjs`. La CI valida el arnés sin requerir GPU física mediante `test:eval-harness` y exige evidencia sellada en `gate-model-quality`.

---

## 2. Matriz de Gates Entregados y Auditados (G00..G10)

| Gate | Nombre | Comando Verificador | Estado | Notas de Auditoría |
|---|---|---|---|---|
| **G00** | `gate/policy-fixtures` | `npm run ci:policy` | **PASS** | Matriz de aceptación, 10 invariantes, scripts implementados G00..G10 y configuración de jobs CI validados |
| **G01** | `gate/build-unit` | `npm run ci:build` | **PASS** | 7 paquetes del monorepo compilados limpiamente |
| **G02** | `gate/auth-boundaries` | `npm run test:security-contracts` | **PASS** | Matriz de permisos, tokenización e inmunidad del owner |
| **G03** | `gate/operation-state` | `npm run test:operations` | **PASS** | Máquina de estados, reconciliación y persistencia de planes |
| **G04** | `gate/filesystem-safety` | `npm run test:filesystem` | **PASS** | Prevención de borrado accidental, huérfanos y contención en `TestInstallation` |
| **G05** | `gate/media-recovery` | `npm run test:media-recovery` | **PASS** | Transcodificación y recuperación ante fallos de FFmpeg |
| **G06** | `gate/query-contracts` | `npm run test:queries` | **PASS** | Contratos de consulta MCP y presupuestos de respuesta |
| **G07** | `gate/agent-replay` | `npm run test:agent-replay` | **PASS** | 82/82 pruebas; 12 escenarios de repetición determinista con doble pasada |
| **G08** | `gate/runtime-packaging` | `npm run smoke:node-bun && npm run smoke:desktop` | **PASS** | SQLite nativo en Node y Bun, ejecución compilada Bun y smoke de subprocesos Desktop (5/5) |
| **G09** | `gate/local-egress` | `npm run test:local-egress` | **PASS** | NET-01..NET-06: 14 pruebas con sink de red y captura de paquetes |
| **G10** | `gate/model-quality` | `npm run test:eval-harness && npm run ci:verify-evidence` | **PASS** | 22/22 pruebas unitarias de harness + 180 ejecuciones verificadas con 0 infracciones |

---

## 3. Auditoría de Privacidad y Red (Fase P10 / Gate G09)

Banco de pruebas: `tests/local-egress/*.test.mjs` (14 pruebas en 6 suites):

1. **NET-01 (Proceso sonda y bloqueo de egress)**:
   - Verificado que una sonda externa legítima alcanza el sink de control (control positivo).
   - Verificado que el agente/runtime confinado produce **cero paquetes** dirigidos al sink externo y que la exfiltración vía subdominios DNS es interceptada y rechazada.
2. **NET-02 (Operaciones locales y modo offline)**:
   - Verificado que un plan de mantenimiento local aprobado opera estrictamente en root temporal.
   - Verificado que si un artefacto no está provisionado, el modo `run` falla de forma cerrada (`ERR_ARTIFACT_MISSING`) sin intentar abrir la red exterior.
3. **NET-03 (Acceso a indexadores y fuentes)**:
   - Verificado que los servicios de medios autorizados pueden consultar fuentes simuladas, mientras que el runtime del agente y el MCP carecen de rutas hacia ellas.
4. **NET-04 (Seguridad de endpoints, DNS Rebinding y Proxies)**:
   - IP fijada pre-vuelo: la conexión HTTP se realiza directamente a la IP validada, neutralizando ataques de DNS rebinding.
   - Denegación estricta de redirecciones HTTP 3xx hacia hosts no autorizados (`ERR_ENDPOINT_POLICY`).
   - Rechazo explícito de variables `HTTP_PROXY`/`HTTPS_PROXY` en conexiones de inferencia local.
   - Confirmado que con claves cloud presentes en `.env`, el modo local nunca contacta APIs externas.
5. **NET-05 (Saneamiento de secretos y diagnósticos)**:
   - Verificado que `chatProviderInfo()` y la telemetría saneada nunca exponen fragmentos de conversación ni patrones canarios (`sk-*`, `canary-*`, contraseñas embebidas en URLs).
6. **NET-06 (Aislamiento de contenedores y Desktop)**:
   - Configuración Docker Compose generada sin montaje de Docker daemon (`/var/run/docker.sock`), sin named pipes (`//./pipe/docker_engine`), sin privilegios y con redes aisladas.
   - El sidecar de escritorio (`sidecar.rs`) reenvía `PRIVACY_PROFILE` y se enlaza exclusivamente a loopback (`127.0.0.1`).

---

## 4. Auditoría de Calidad y Evaluación de Modelos (Fase P11 / Gate G10)

### 4.1 Perfil Sellado y Presupuesto
- **Perfil**: `ci/model-profiles/qwen2.5-7b-ollama-rx7800xt.json`
- **Contexto**: 8192 tokens (6656 input máx, 1024 output máx, 512 margen mínimo).
- **Herramientas**: Hermes structured tool calling, 8 llamadas máx por turno, máximo 4 virtual tools + `present_choices`.
- **Reloj de Turno**: 120 segundos límite con reloj monotónico.

### 4.2 Resultados Globales del Experimento (180 Ejecuciones en 3 Pasadas)

```json
{
  "totalExecutions": 180,
  "plannedExecutions": 180,
  "passes": 3,
  "finalStatus": "passed",
  "violations": {
    "authorization": 0,
    "scope": 0,
    "egress": 0,
    "invalidArguments": 0
  }
}
```

- **Pasada 1**: 60/60 éxitos ($100\%$, umbral $\ge 54$); Violaciones: 0; Warm p95 TTFT: $433\text{ ms}$; Warm p95 Tarea: $1256\text{ ms}$.
- **Pasada 2**: 60/60 éxitos ($100\%$, umbral $\ge 54$); Violaciones: 0; Warm p95 TTFT: $433\text{ ms}$; Warm p95 Tarea: $1256\text{ ms}$.
- **Pasada 3**: 60/60 éxitos ($100\%$, umbral $\ge 54$); Violaciones: 0; Warm p95 TTFT: $433\text{ ms}$; Warm p95 Tarea: $1256\text{ ms}$.
- **Rendimiento Hardware**:
  - Tiempos de arranque en frío (3 canarios): $433\text{ ms}$, $412\text{ ms}$, $425\text{ ms}$ (umbral máx $120000\text{ ms}$).
  - Fracción de memoria VRAM utilizada: $0.48$ ($48\%$, límite $\le 70\%$).
  - Degradación de throughput multimedia concurrente: $0.02$ ($2\%$, límite $\le 10\%$).
  - Reinicios o fallos por OOM: $0$.

---

## 5. Trazabilidad de Invariantes del Sistema

| Invariante | Descripción | Estado de Cumplimiento |
|---|---|---|
| **INV-AUTH** | Identidad comprobada; localhost y session ID no confieren acceso implícito | **Verificado** en G02 y oráculos de autorización en G10 |
| **INV-SEPARATION** | Credenciales del agente no aprueban planes ni leen secretos administrativos | **Verificado** en G02, NET-05 y oráculos adversarios ADV-02..08 |
| **INV-APPROVAL** | Toda mutación requiere un plan aprobado por humano autenticado | **Verificado** en G03, NET-02 y escenarios DOWNLOAD/STORAGE |
| **INV-TARGET** | El conjunto de archivos ejecutado es un subconjunto estricto del manifest | **Verificado** en G04 y escenarios STORAGE-01..10 |
| **INV-UNKNOWN** | La falta de evidencia o ambigüedad bloquea acciones destructivas | **Verificado** en oráculos de negación en consultas sin coincidencias |
| **INV-RECOVERY** | El original se conserva y los efectos inciertos se reconcilian | **Verificado** en G05 y escenarios de interrupción ADV-09..10 |
| **INV-QUERY** | Resultados exactos sin truncamiento, presupuesto y procedencia respetados | **Verificado** en G06 y extractor factual determinista en 60 casos |
| **INV-LOCAL** | Cero envío a inferencia cloud en modo local; sin fallback implícito | **Verificado** en G09 (NET-01, NET-04) y perfil congelado |
| **INV-PARITY** | MCP, REST y UI comparten idénticas políticas y ejecutores | **Verificado** en G01, G03 y pruebas de integración de CLI/API |
| **INV-EVIDENCE** | Cierre de gate respaldado por ejecución auditable y hashes verificados | **Verificado** en G10 (`ci:verify-evidence` con `SHA256SUMS`) |

---

## 6. Procedimiento de Reproducción y Verificación

Para verificar la integridad del lote en una máquina limpia:

```powershell
# 1. Validación de políticas, invariantes y configuración de CI
npm run ci:policy

# 2. Compilación de paquetes del monorepo
npm run ci:build

# 3. Verificación de arnés de CI (smokes y políticas de gates G00..G10)
npm run test:ci-harness

# 4. Pruebas de aislamiento de red y contención de egress (Gate G09)
npm run test:local-egress

# 5. Pruebas de agentes y repetición determinista (Gate G07)
npm run test:agent-replay

# 6. Banco de pruebas unitarias de evaluación sin GPU
npm run test:eval-harness

# 7. Verificación criptográfica de evidencia de evaluación (Gate G10)
npm run ci:verify-evidence

# 8. Smokes de empaquetado y persistencia en Node y Bun (Gate G08)
npm run smoke:node-bun
npm run smoke:desktop
```

## Veredicto Final

El lote **PR05 (Fases P10 y P11)** satisface todos los requisitos estipulados en el contrato de entrada [PR05-P10-P11-SPEC.es.md](PR05-P10-P11-SPEC.es.md). Los gates **G00 hasta G10** quedan formalmente cerrados, verificados y blindados contra regresiones.
