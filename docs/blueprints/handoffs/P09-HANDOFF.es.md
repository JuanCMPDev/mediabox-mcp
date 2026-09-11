# Cierre de Fase P09 — Proveedor Local y Perfiles Comprobables

Documento de entrega y cierre correspondiente a la **Fase P09** del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md) y de la especificación [PR04-P08-P09-SPEC.es.md](PR04-P08-P09-SPEC.es.md). Esta fase concluye junto con P08 el lote de entrega **PR04** (P08–P09).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | P09 — Proveedor local y perfiles comprobables |
| **Lote / PR** | PR04 (sublote PR04b) |
| **Rama de trabajo** | `work/local-agent/p08-p09-agent-provider` |
| **Rama base** | `integration/local-agent-v1` |
| **Fecha de entrega** | 2026-09-11 |
| **Gates asociados** | G07 `gate/agent-replay`, G08 `gate/runtime-packaging` (ampliado) |

---

## 1. Alcance y Componentes Implementados

- **Política de Endpoint y Anti-SSRF (`LOC-06`)**:
  - `packages/chat-core/src/providers/endpoint-policy.ts`: Validación de endpoints locales antes de abrir conexiones de red.
  - Bloquea accesos a internet público por defecto, mitigación de DNS rebinding, bloqueo del endpoint de metadatos cloud (`169.254.169.254`).
  - Prohibición estricta de redirecciones HTTP (`redirect: 'error'`).
  - Soporte para LAN privada controlada (`INFERENCE_ALLOW_LAN=true`) con lista blanca de hosts (`INFERENCE_ENDPOINT_HOSTS`).
- **Adaptador `LocalProvider` y Normalización de Runtimes (`LOC-02`, `LOC-08`)**:
  - `packages/chat-core/src/providers/local.ts`: Proveedor OpenAI-compatible streaming unificado para Ollama, LM Studio, llama.cpp y vLLM.
  - Normalización de fragmentos delta de `tool_calls` indexados; síntesis determinista de IDs de herramientas cuando el runtime los omite (`local_<turn>_<idx>`).
  - Separación de bloques de razonamiento (`<think>` y `reasoning_content`) fuera del texto de respuesta.
  - Inspección activa de capacidades y contexto en endpoints de runtime (`/api/show`, `/api/v0/models`, `/props`, `/v1/models`) con validación de discrepancias frente al perfil (`LOC-05`).
- **Aislamiento e Invariante de No Fallback (`LOC-03`, `INV-LOCAL`)**:
  - `packages/chat-core/src/providers/select.ts`: Con `LLM_PROVIDER=local`, la indisponibilidad del runtime local lanza estrictamente `ERR_PROVIDER_UNAVAILABLE` sin derivar a claves o APIs cloud configuradas (`OPENROUTER_API_KEY`, etc.).
- **Detección de Hardware Multi-Plataforma (`LOC-07`)**:
  - `packages/core/src/hardware/types.ts` & `detect.ts`: Parsers puros y detección en vivo para Windows, Linux y macOS.
  - Detección de GPUs (NVIDIA via `nvidia-smi`, AMD via `rocm-smi` / WMI 64-bit VRAM `HardwareInformation.qwMemorySize` en Windows, Intel via `lspci`, Apple Silicon via `SPDisplaysDataType`).
  - Detección de soporte de contenedores (`nvidiaContainerCli`, `/dev/kfd`, `/dev/dri`) y flags de CPU (`AVX2`, `AVX-512`, `NEON`).
  - Mecanismo de caché en memoria de 10 minutos y timeout de sondeo no bloqueante de 5 segundos.
  - Soporte para override manual `INFERENCE_BACKEND` (`auto`, `cuda`, `rocm`, `vulkan`, `sycl`, `metal`, `cpu`).
- **Catálogo y Dimensionado de Modelos (`LOC-09`)**:
  - `packages/core/src/models/types.ts` & `catalog.ts`: Catálogo de perfiles tipados por niveles (`T0-cpu`, `T1-6gb`, `T2-12gb`, `T3-24gb`).
  - Modelos integrados: `qwen2.5-7b-instruct` (certificado laboratorio T1), `qwen2.5-3b-instruct` (T0-cpu), `qwen2.5-14b-instruct` (T2-12gb), `llama3.2-3b`.
  - Función de evaluación `evaluateModelFit(profile, hardware)` para recomendar modelos según VRAM y memoria disponible y etiquetar modelos sobrecargados.
- **Generadores y Configuración Core**:
  - `packages/core/src/config/validate.ts`: Validación de esquema de configuración para proveedor `local` (rechazo de hosts públicos en modo privado).
  - `packages/core/src/generators/env.ts`: Generación de variables de entorno para inferencia local (`LOCAL_LLM_RUNTIME`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_CONTEXT_TOKENS`, `INFERENCE_BACKEND`, `INFERENCE_ALLOW_LAN`).
  - `packages/core/src/generators/docker-compose.ts`: Emisión de servicios Docker Compose dedicados por backend (`inference-cuda`, `inference-rocm`, `inference-vulkan`, `inference-cpu`) con variables `OLLAMA_NO_CLOUD=1` y límites de contexto de inferencia.
- **Integración Servidor MCP y Diagnóstico (`LOC-04`, `LOC-10`)**:
  - `packages/mcp-server/src/chat/provider.ts`: Construcción de `LocalProvider` con inyección de políticas de red.
  - `chatProviderInfo()`: Exposición de `ChatInfo` con `mode: 'local'`, `runtime`, `backend`, `contextTokens` y redacción estricta de credenciales (`LOC-10`).
  - `packages/mcp-server/src/helpers/stack-env.ts`: Registro de variables editables del proveedor local en la configuración de la pila.
- **Superficies UI**:
  - `packages/ui/src/components/wizard/steps/AIProviderStep.tsx`: Opción de configuración "Local (privado)" con selector de runtime (Ollama, LM Studio, llama.cpp, vLLM), endpoints por defecto y selector de modelos recomendados.
  - `packages/ui/src/components/chat/ChatPanel.tsx`: Badge permanente de modo de inferencia y modelo en la cabecera del chat (`Local: <modelo>` / `Cloud: <modelo>`).
- **Canario de Laboratorio (`LOC-01`)**:
  - `scripts/ci/smoke-local-canary.mjs`: Prueba canario de 3 turnos completos contra Fake MCP (`search_media` -> `find_releases` -> `propose_download`) validando tool calling en streaming con score 3/3 (`npm run smoke:local-canary`).
- **Extensión Gate G08 (`gate/runtime-packaging`)**:
  - `scripts/ci/smoke-node-bun.mjs`: Paso 5 añadido que verifica la carga e inicialización correcta de `LocalProvider` en el binario empaquetado de Bun.

---

## 2. Invariantes y Criterios Cumplidos (P09)

| ID | Criterio | Evidencia / Test | Estado |
|---|---|---|---|
| **LOC-01** | Canario consulta fixture por MCP y usa el dato real | `scripts/ci/smoke-local-canary.mjs` (Score 3/3 en flujo de búsqueda, ranking y propuesta) | **Cumplido** |
| **LOC-02** | Fragmentación/finalización/argumentos malformados no duplican llamadas | `packages/chat-core/src/providers/local.test.ts` (Ensamblado secuencial, deduplicación de IDs) | **Cumplido** |
| **LOC-03** | Runtime no disponible con claves cloud presentes no hace fallback | `packages/chat-core/src/providers/select.test.ts` (Error `ERR_PROVIDER_UNAVAILABLE` sin fallback a OpenRouter) | **Cumplido** |
| **LOC-04** | Contrato/env/sidecar/UI reflejan el mismo proveedor y modelo | `packages/core/src/generators/env.test.ts` & `packages/mcp-server/src/chat/provider.test.ts` | **Cumplido** |
| **LOC-05** | El contexto configurado coincide con el del runtime y sus opciones no soportadas fallan explícitamente | `packages/chat-core/src/providers/local.test.ts` | **Cumplido** |
| **LOC-06** | La política de endpoint bloquea hosts públicos, DNS a IP pública, redirecciones y proxies antes de conectar | `packages/chat-core/src/providers/endpoint-policy.test.ts` (6 tests de contención SSRF y denegación de redirects) | **Cumplido** |
| **LOC-07** | La detección de hardware clasifica correctamente fixtures reales de NVIDIA, AMD, Intel, Apple y CPU, en los tres SO | `packages/core/src/hardware/detect.test.ts` (9 tests de parsers puros y sondeo en vivo de host) | **Cumplido** |
| **LOC-08** | Las particularidades de Ollama, LM Studio, llama.cpp y vLLM se normalizan a un mismo stream | `packages/chat-core/src/providers/local.test.ts` (Normalización de deltas, think tags y finish_reasons) | **Cumplido** |
| **LOC-09** | Un modelo que no cabe en el hardware no se recomienda y se marca al forzarlo | `packages/core/src/models/catalog.test.ts` (Filtros por VRAM/RAM y flags de compatibilidad) | **Cumplido** |
| **LOC-10** | El diagnóstico no expone secretos y refleja el modo local | `packages/mcp-server/src/chat/provider.test.ts` (`chatProviderInfo` retorna secretos redactados y modo local) | **Cumplido** |

---

## 3. Gates Evaluados

| Gate | Check | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | **PASS** |
| **G01** | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | **PASS** (607 unit tests pasando en todos los paquetes) |
| **G07** | `npm run test:agent-replay` | **PASS** (12/12 escenarios de replay pasando doble pasada determinista) |
| **G08** | `npm run smoke:node-bun` | **PASS** (Pruebas de inicialización de servidor y proveedor local en Node y Bun compilado) |
| **Lab Canary** | `npm run smoke:local-canary` | **PASS** (3/3 turnos completados con éxito y llamadas MCP válidas en vivo) |

---

## 4. Evidencia de Laboratorio y Certificación Hardware (AMD RX 7800 XT / ROCm)

Se ejecutó la certificación en vivo del canario contra Ollama v0.34.0 sobre el hardware del host de laboratorio:

- **Host**: Windows 11 x64 (AMD Ryzen CPU + AMD Radeon RX 7800 XT discrete GPU).
- **VRAM Total**: 16.0 GiB (17.163.091.968 bytes detectados vía registro WMI 64-bit).
- **Backend**: ROCm v7.1 (`HSA_OVERRIDE_GFX_VERSION=11.0.0`, driver ROCm discrete compute `gfx1100`/`gfx1101`).
- **Modelo Certificado**: `qwen2.5:7b` (digest SHA256 verificado, nivel T1-6gb).
- **Contexto Configurado**: 8.192 tokens (`OLLAMA_CONTEXT_LENGTH=8192`, `OLLAMA_NO_CLOUD=1`).
- **Offload GPU Real**:
  ```
  NAME          ID              SIZE      PROCESSOR    CONTEXT    UNTIL              
  qwen2.5:7b    845dbda0ea48    5.1 GB    100% GPU     8192       4 minutes from now
  ```
- **Resultado del Canario de 3 Turnos (`npm run smoke:local-canary`)**:
  - Turno 1 (`search_media`): Despachado con argumentos `{ "query": "Inception", "type": "movie" }` -> Recibe `mediaRef: "mref_canary012345"`.
  - Turno 2 (`find_releases`): Despachado con `{ "mediaRef": "mref_canary012345" }` -> Recibe `releaseRef: "rref_canary012345"`.
  - Turno 3 (`propose_download`): Despachado con `{ "releaseRef": "rref_canary012345", "mediaRef": "mref_canary012345" }` -> Propuesta creada `plan_canary_001` en estado `awaiting_approval`.
  - **Score de compatibilidad de agente**: **3/3 (100% Compatible)**.

