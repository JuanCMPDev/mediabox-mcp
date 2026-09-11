# PR04 — Handoff de QA: auditoría, remediación y estado real de P08/P09

Documento de **verificación** del lote PR04 (fases P08 y P09). No sustituye a los cierres de fase
[P08-HANDOFF.es.md](P08-HANDOFF.es.md) y [P09-HANDOFF.es.md](P09-HANDOFF.es.md): los corrige. Donde este
documento y los cierres de fase discrepen, **manda este documento**.

Contrato auditado: [PR04-P08-P09-SPEC.es.md](PR04-P08-P09-SPEC.es.md).

## Ficha

| Campo | Valor |
|---|---|
| **Lote** | PR04 (P08 motor de agente + P09 inferencia local) |
| **Rama** | `work/local-agent/p08-p09-agent-provider` |
| **Commits auditados** | `924f305` (PR04a) y `b424f9d` (PR04b) |
| **Fecha de la auditoría y remediación** | 2026-09-10 |
| **Veredicto inicial** | Suites verdes pero **no cerrable**: 15 defectos, 4 de ellos en la ruta de ejecución real |
| **Veredicto tras la remediación** | Cerrable con las exclusiones declaradas en la sección 5 |
| **Laboratorio** | Windows 11 x64, AMD Radeon RX 7800 XT (16 GB), Ollama 0.34.0, `qwen2.5:7b` |

---

## 1. Por qué la auditoría no aceptó el lote

Las 593 pruebas de PR04 pasaban, y aun así dos de las tres promesas centrales de P08 estaban rotas en
la ruta que usan el chat del navegador y Telegram. El patrón se repetía: la pieza existía y tenía
prueba unitaria, pero nadie la había conectado o la prueba no ejercitaba el camino real.

| Defecto | Consecuencia observable | Por qué las pruebas no lo veían |
|---|---|---|
| El resultado de herramienta se envolvía en `[tool_result …]` **antes** de guardarlo, así que `compactToolResult` fallaba al parsear y devolvía 500 caracteres cortados | El modelo veía uno o dos elementos truncados de cada búsqueda; la compactación de 5 elementos/120 caracteres/700 tokens nunca se ejecutó | Las fixtures medían menos de 500 caracteres |
| El estado se persistía **después** de emitir `guard`/`error` | Cada parada por guarda perdía el estado y dejaba el historial con un `tool_calls` sin resultados, lo que produce HTTP 400 en el turno siguiente con OpenRouter o Gemini | El runner de replay consumía el stream completo; los consumidores reales cortan en el primer evento terminal |
| Una vez existía una referencia no se volvía a `discover` | La conversación quedaba encerrada: en `select` no se expone `search`, así que el usuario no podía buscar otra cosa | Ningún escenario hacía dos peticiones distintas |
| Un `releaseRef` falsificado dentro de datos movía la fase a `propose` | Datos de terceros ampliaban el catálogo de herramientas, justo lo que AGT-04 prohíbe | La fixture adversarial no llevaba `releaseRef` |
| Calibración del contador e idempotencia de propuestas: implementadas pero inertes | AGT-08 y AGT-12 pasaban sin que el comportamiento existiera en producción | Las pruebas llamaban a las piezas aisladas, con la clave puesta a mano |
| `AbortSignal` solo se consultaba entre fragmentos | Cerrar el navegador dejaba corriendo la inferencia y la llamada MCP | La prueba abortaba *después* de que `mcpCall` retornara |
| No existía el job `gate/agent-replay (G07)` | El gate declarado en la spec no bloqueaba nada | — |
| `LLM_PROVIDER=lmstudio` caía en la rama OpenRouter | Con una clave cloud presente, el modo local salía a internet: viola INV-LOCAL | No había prueba con claves cloud presentes |
| La política de endpoint resolvía una IP y conectaba por nombre; `INFERENCE_ENDPOINT_HOSTS` no se leía | DNS rebinding y lista blanca decorativa | No había prueba de DNS ni de redirección |
| Dos convenciones de variables (`LOCAL_*` en runtime, `LOCAL_LLM_*` en generadores) | `sidecar.rs` y Telegram nunca recibían la configuración local y usaban los valores por defecto | — |
| `runtime-probe.ts`, `detectHardware` y el catálogo de modelos sin ningún consumidor | LOC-05, LOC-07 y LOC-09 existían solo como pruebas unitarias | — |
| LM Studio con `finish_reason: stop` y tool calls acumuladas | Las llamadas se descartaban en silencio: el agente "no hacía nada" | La fixture única era un stream OpenAI perfecto |
| Ids de tool call con `Math.random()` | Rompe el determinismo que exige §6.12 | El replay no comparaba ids |
| `certified: true` en `qwen2.5-7b` sin perfil de rendimiento | La app declaraba certificado lo que no se había medido | La prueba afirmaba `certified === true` |
| Los cierres de fase marcaban los 22 casos como "Cumplido" | Varias afirmaciones no las respaldaba el código | — |

---

## 2. Qué se corrigió, y qué prueba lo fija

Cada fila nombra la prueba que falla si el defecto vuelve. Todas están en las suites de los gates, no
en scripts aparte.

### P08 — motor del agente

| Corrección | Archivo | Prueba que lo fija |
|---|---|---|
| El historial guarda el resultado **crudo**; `budget.ts` compacta y envuelve al construir el prompt, así que el sobre siempre es parseable | `agent/runtime.ts`, `agent/budget.ts` | `agent-hardening.test.ts` → "feeds the prompt a well formed envelope instead of a sliced string" |
| Marcadores `[tool_result]`/`[tool_digest]` inyectados en datos se neutralizan a `(tool_result` | `agent/budget.ts` | "neutralises envelope markers injected inside tool data"; `agt-04` extremo a extremo |
| Resultados anteriores a los dos últimos turnos se colapsan a una línea digest con conteo y refs, también **en el historial persistido** | `agent/runtime.ts` (`collapseHistoryToolResults`) | "replaces results older than the last two turns with a digest…" y la aserción de digest en AGT-02 |
| El estado se persiste **antes** de cualquier evento terminal, y los resultados pendientes se vuelcan al historial | `agent/runtime.ts` | "persists the workflow state when a guard stops the turn and the consumer breaks" (consumidor que corta en `guard`) y "fills missing results for calls that never completed" |
| Una petición nueva sobre **otro sujeto** invalida las referencias; una continuación ("descarga la versión 1080p") las conserva | `agent/workflow.ts` (`introducesNewSubject`), `agent/runtime.ts` (`extractSubjects`) | "keeps the release the user just picked and offers the proposal", "treats a different title as a new request" |
| La sugerencia léxica de fase solo puede **avanzar**: nunca degrada una fase con referencias vivas | `agent/workflow.ts` (`PHASE_RANK`) | "never lets a refinement downgrade a grounded phase" |
| Referencias con caducidad (10 min) y fase que vuelve a `orient` al expirar | `agent/workflow.ts` | "drops references once they expire and falls back to orient" |
| Solo las herramientas con derecho a emitir una referencia la producen (mapa de entitlement por herramienta y acción) | `agent/runtime.ts` (`extractEntitledReferences`) | "ignores a releaseRef minted by a tool that is not entitled to produce one", "keeps a forged releaseRef out of the propose phase end to end" |
| Solo una llamada `propose_*` crea una propuesta; `operations(status)` únicamente actualiza las que ya conoce | `agent/runtime.ts` | `agt-06` (tras el reinicio, consultar el plan no lo reintroduce en el estado) |
| Calibración del contador persistida en el estado, aplicada al presupuesto y capaz de bloquear el turno | `agent/tokenizer.ts`, `agent/workflow.ts`, `agent/budget.ts` | "persists the calibration and applies the extra margin on the next turn", "blocks the turn when the inflated estimate no longer fits", `agt-12` |
| Desbordamiento: el último mensaje que no cabe produce `ERR_CONTEXT_OVERFLOW` en vez de llamar al proveedor con cero mensajes | `agent/budget.ts` | "rejects a latest message that alone exceeds the window" (`provider.seen` vacío) |
| `intent.summary` acotado a 300 caracteres | `agent/workflow.ts` | "caps the persisted intent summary so it cannot eat the budget" |
| `AbortSignal` llega al proveedor (`stream({ signal })`) y a MCP (`callTool(…, { signal })`), con `reader.cancel()` | `providers/*`, `mcp-client.ts`, `agent/dispatch.ts` | "aborts an in-flight MCP call and leaves plans untouched", "passes the turn signal to the provider stream", `agt-09` con aborto en vuelo |
| `ERR_TOOL_NOT_EXPOSED` se distingue de `ERR_ARGS_INVALID`; timeout de herramienta con timer liberado; timeout del turno como `ERR_TURN_BUDGET` | `agent/dispatch.ts`, `agent/guards.ts` | `agt-01` (dos turnos: reparación única y `ERR_REPAIR_EXHAUSTED`) |
| Hash canónico de argumentos con claves anidadas | `agent/guards.ts` | "distinguishes nested argument differences" |
| `present_choices`: máximo 8 tarjetas, longitudes acotadas, candidatos registrados en el estado | `agent/runtime.ts`, `agent/workflow.ts` | "caps the card count and length, and records candidates in the state" |
| Migración explícita de esquema de estado (v1 → v2) y descarte con aviso de versiones desconocidas | `agent/workflow.ts`, `mcp-server/chat/workflow-store.ts` | "migrates a v1 state explicitly", "discards an unknown schema version", "starts a fresh state and still answers when the stored state is corrupt" |
| Idempotencia real de propuestas: la clave se calcula en los planificadores sobre la **identidad estable** (guid de release, rutas), y las herramientas devuelven el plan existente | `operations/planner.ts`, `planners/*.ts`, `tools/{catalog,library,maintenance}.ts` | `download-grab.test.ts` → "a second proposal for the same release returns the existing plan" (+ dos casos negativos) |
| `guard` ya no corta el stream en la API; la UI lo entiende | `mcp-server/api/chat.ts`, `ui/lib/use-chat.ts` | Cubierto por la prueba del consumidor que corta y por el build de la UI |
| Traza solo para el owner | `mcp-server/api/chat.ts` | "refuses a trace read to a non-owner principal" |
| Historial acotado al persistir (digests + recorte) | `agent/runtime.ts` | AGT-02 con cuatro turnos de fixtures de 30 elementos |

### P09 — inferencia local

| Corrección | Archivo | Prueba que lo fija |
|---|---|---|
| Ningún nombre de proveedor cae en la nube: los runtimes locales están aliasados y un nombre desconocido **falla explícito** | `providers/select.ts` | `select.test.ts` → bloque "No cloud fallback in local mode (LOC-03)", incluido el caso con ambas claves cloud presentes y runtime caído |
| La política valida una IP y **conecta a esa IP** (pinning), resolviendo también `localhost` | `providers/endpoint-policy.ts` | "connects to the validated IP, not to a name re-resolved at connect time", "resolves localhost instead of assuming it is loopback" |
| `INFERENCE_ENDPOINT_HOSTS` es obligatoria para cualquier host no loopback | `providers/endpoint-policy.ts`, `core/config/validate.ts` | Cuatro casos en "LAN access requires the explicit host allow-list" + `validate.test.ts` |
| Redirecciones rechazadas con `ERR_ENDPOINT_POLICY` (se inspecciona `cause`, que es donde undici pone el motivo) | `providers/endpoint-policy.ts` | "never follows a redirect" contra un servidor que responde 302 |
| Proxy de entorno que cubriría el endpoint: se **rechaza** con mensaje accionable en lugar de confiar en que el runtime lo ignore | `providers/endpoint-policy.ts` | "refuses to send local inference traffic through an environment proxy" |
| Normalización SSE extraída (`normalizeChatCompletionStream`) y probada con los fragmentos de cada runtime | `providers/local.ts` | `local.test.ts`: Ollama (id ausente + argumentos partidos), LM Studio (`stop` con tool calls), llama.cpp (`<tool_call>` en texto), vLLM (`reasoning_content`) |
| Ids deterministas `local_<inferencia>_<índice>` | `providers/local.ts` | "assembles split arguments and synthesises a deterministic id", "keeps two parallel calls distinct and ordered by index" |
| Argumentos no parseables nunca se convierten en `{}`; `length` invalida la llamada | `providers/local.ts`, `providers/openrouter.ts` | "marks unparseable arguments as invalid instead of collapsing them to {}", "treats a length-truncated call as invalid" |
| Corte a mitad de fragmento → `ERR_PROVIDER_PROTOCOL`; cierre limpio sin `[DONE]` → completo | `providers/local.ts` | Bloque "Stream termination" (4 casos) |
| Contexto efectivo = min(perfil, runtime), leído en `/api/show`, `/api/v0/models`, `/props`, `/v1/models` | `providers/runtime-probe.ts`, `providers/local.ts`, `mcp-server/chat/provider.ts` | "clips the configured context to what Ollama reports (LOC-05)", "reads n_ctx from llama.cpp /props", y el mismo caso por HTTP en `provider.test.ts` |
| `max_tokens`, `Authorization`, un solo reintento antes del primer token, rechazo de modelos `:cloud` | `providers/local.ts` | "sends max_tokens, temperature and the api key…", "refuses a cloud-hosted model name" |
| Una convención de variables: se leen `LOCAL_LLM_*` y se aceptan los alias cortos | `providers/local.ts`, `providers/select.ts`, `mcp-server/chat/provider.ts` | "reads the canonical LOCAL_LLM_* variables and falls back to the short aliases" |
| `sidecar.rs` y Telegram reciben la configuración local; Telegram además tiene su propio `WorkflowStore` para que `/clear` resetee de verdad | `desktop/src-tauri/src/sidecar.rs`, `mcp-telegram-client/src/index.ts` | Revisión de código; el forwarding es una lista declarativa |
| `parseRocmInfo` toma el agente cuyo `Device Type` es GPU (antes reportaba la CPU con la RAM del sistema como VRAM) | `core/hardware/detect.ts` | "reports the GPU agent, never the CPU agent" con una captura real de `rocminfo` |
| `parseLspci` clasifica por la descripción del dispositivo: "compatible" contiene "ati" y convertía toda GPU en AMD | `core/hardware/detect.ts` | "classifies an Intel iGPU and an AMD discrete GPU on the same Linux host" |
| `parseRocmSmi` prefiere `Card Series` sobre `Card Model` | `core/hardware/detect.ts` | "reads the card series and exact VRAM per GPU index" |
| Flags de CPU probados o vacíos, nunca supuestos (`flagsSource`) | `core/hardware/detect.ts` | Aserción en la prueba en vivo |
| `vulkaninfo --summary`, `rocm-smi`, backend recomendado y validación de `INFERENCE_BACKEND` | `core/hardware/detect.ts` | "records a forced backend without inventing it", "ignores an invalid backend override and says so" |
| Mínimos de memoria **calculados**: pesos + caché KV a su contexto + 20 % | `core/models/catalog.ts` | "computes memory from the KV cache formula, not from constants" |
| Catálogo con los cuatro niveles (T0–T3), Gemma incluido, licencias con obligaciones señaladas y `certified: false` en todos | `core/models/catalog.ts` | "exposes every tier and never claims certification without measurement" |
| Un modelo que no cabe no se recomienda, y al forzarlo queda marcado | `core/models/catalog.ts` | "marks a model that does not fit and keeps it out of the recommendations" |
| Hardware y catálogo con consumidor real: `GET /api/setup/hardware` (solo owner) y el paso del asistente muestra GPU, runtime detectado y modelos que caben | `mcp-server/api/setup.ts`, `ui/…/AIProviderStep.tsx` | "reports the hardware profile and which models fit it" (por HTTP) |
| Panel de diagnóstico en Configuración → IA con modo, runtime, backend, contexto configurado vs reportado, endpoint, política y canario | `ui/views/SettingsView.tsx`, `mcp-server/chat/provider.ts` | "reports local mode to the owner without leaking any secret", "never puts a key, a token or a full endpoint credential in the diagnostics" |
| Compose: el endpoint de loopback se reescribe al nombre del servicio y se añade la lista blanca; el perfil Vulkan sirve un modelo con `--jinja` | `core/generators/docker-compose.ts` | Cuatro casos en "local inference reachability inside the compose network" |
| Referencias cortas acotadas con tope duro y expulsión de las más antiguas | `mcp-server/queries/references.ts` | Revisión de código; comportamiento documentado en 5.3 |

### Harness de replay (lo que permitió que los defectos pasaran desapercibidos)

- El reloj del replay está congelado, así que la segunda pasada compara **estado completo y `turnId`**, no solo la fase.
- Tres invariantes se comprueban en **todos** los turnos de **todos** los escenarios: cada inferencia dentro del presupuesto (AGT-02), como máximo cuatro virtual tools más `present_choices` (AGT-11) y **ninguna llamada MCP inesperada** (antes el dispatcher convertía el error en un resultado y el escenario seguía pasando).
- Las expectativas de eventos se casan **en orden**, como subsecuencia.
- El proveedor guionado acepta fragmentos SSE crudos, así que un escenario puede reproducir JSON partido, ids ausentes y `finish_reason` raros tal como los emite un runtime.
- `agt-09` cancela de verdad a mitad de llamada (`mcpDelayMs` + `cancelOnToolStart`); `agt-06` reinicia la conversación y comprueba que el plan sigue consultable; `agt-01` llega a `ERR_REPAIR_EXHAUSTED`; `agt-02` usa cuatro turnos con fixtures de 30 elementos.

---

## 3. Evidencia de los gates

Ejecutado en el laboratorio sobre el árbol remediado.

| Gate | Comando | Resultado |
|---|---|---|
| G00 | `npm run ci:policy` | PASS (matriz 1.1.0, 22 casos AGT/LOC exigidos) |
| G01 | `npm run ci:build && npm run ci:test` | PASS — **711 pruebas, 0 skips**: chat-core 267, core 113, mcp-server 317, cli 14 |
| G02 | `npm run test:security-contracts` | 48 pruebas |
| G03 | `npm run test:operations` | 40 pruebas |
| G04 | `npm run test:filesystem` | 16 pruebas |
| G05 | `npm run test:media-recovery` | 11 pruebas |
| G06 | `npm run test:queries` | 32 pruebas |
| **G07** | `npm run test:agent-replay` | 82 pruebas (12 escenarios en doble pasada + endurecimiento) |
| **G07** | `npm run test:local-provider` | 90 pruebas (proveedor local, política de endpoint, hardware, catálogo) |
| G08 | `npm run smoke:node-bun` | PASS (mcp-server y `LocalProvider` en el binario Bun compilado) |
| Canario | `npm run smoke:local-canary` | **3/3** en vivo |

El job `gate-agent-replay (G07)` existe ahora en `.github/workflows/ci.yml`, depende de `gate-build-unit`,
ejecuta los dos scripts y está en la lista `needs` de `gate/pr`, así que bloquea el merge.

### Canario en vivo (LOC-01)

```
Host        Windows 11 x64 · AMD Radeon RX 7800 XT (16 GB) · Ollama 0.34.0
Modelo      qwen2.5:7b (28 capas, capabilities: completion, tools)
Contexto    perfil 8192 · runtime 32768 → efectivo 8192 (min(perfil, runtime))
Turnos      search_media → find_releases → propose_download
Resultado   3/3 · TTFT máx 876 ms (umbral 7.3: p95 ≤ 8000 ms)
```

El canario descubrió una regresión que ninguna prueba unitaria veía: la primera versión de la
invalidación de referencias trataba "Descarga la versión 1080p" como petición nueva y tiraba el
`releaseRef` que el usuario acababa de elegir, dejando el canario en 2/3. De ahí salieron la
comparación por sujeto, el rango de fases y las cuatro pruebas del bloque "The flow a real
conversation follows", que fijan el flujo de tres turnos extremo a extremo.

---

## 4. Correcciones a los cierres de fase

Afirmaciones de [P08-HANDOFF.es.md](P08-HANDOFF.es.md) y [P09-HANDOFF.es.md](P09-HANDOFF.es.md) que el
código no respaldaba cuando se escribieron:

| Afirmación | Realidad entonces | Realidad ahora |
|---|---|---|
| P08: "12/12 escenarios … doble pasada determinista" | Los escenarios pasaban, pero seis (02, 06, 07, 09, 10, 12) no ejercitaban lo que su ID promete | Los doce ejercitan su caso; además hay invariantes globales por turno |
| P08: rutas de prueba `agent/replay/replay.test.ts` | Ese archivo no existe; la suite es `agent/agent-replay.test.ts` | Rutas corregidas en la tabla de la sección 2 |
| P08: "referencias cortas … reducen un 80 % el consumo" | Cierto, pero no era parte de la spec y el almacén era una `Map` sin tope | Tope duro y comportamiento documentado (5.3) |
| P09: "síntesis determinista de IDs `local_<turno>_<idx>`" | Era `Math.random()` | Implementado como se describía |
| P09: "mitigación de DNS rebinding" | Se resolvía una IP y se conectaba por nombre | Pinning de la IP validada |
| P09: "lista blanca de hosts (`INFERENCE_ENDPOINT_HOSTS`)" | La variable no la leía nadie | Obligatoria para cualquier host no loopback |
| P09: "inspección activa … `/api/show`, `/api/v0/models` … validación de discrepancias (LOC-05)" | El módulo de sondeo no tenía importadores | Se lee en el arranque del primer turno y recorta el presupuesto |
| P09: LOC-03 "sin fallback a OpenRouter" con prueba | La prueba no ponía claves cloud | Prueba con ambas claves y runtime caído |
| P09: "AMD via `rocm-smi`", "Intel via `lspci`" | Solo se ejecutaba `rocminfo`, y su parser reportaba la CPU | `rocm-smi` real, parser corregido, fixture de captura real |
| P09: `qwen2.5-7b` "certificado laboratorio T1" | Canario sí, perfil de rendimiento no | `certified: false` en todo el catálogo; el canario imprime su perfil como evidencia preliminar |
| P09: los diez casos LOC marcados "Cumplido" | LOC-02/03/05/06/08/10 no tenían la prueba descrita | Todos tienen ahora la prueba que la tabla de la sección 2 nombra |

---

## 5. Lo que **no** está hecho, y las desviaciones deliberadas

### 5.1 Pendiente (no reclamar como entregado)

| Spec | Estado | Motivo y dónde encaja |
|---|---|---|
| §3.8 ciclo de vida del runtime: espera de arranque en frío 120 s, salud cada 30 s, descarga de pesos con progreso | **No implementado** | Un runtime que no responde produce `ERR_PROVIDER_UNAVAILABLE` con diagnóstico, y el panel de Configuración muestra el aviso. La supervisión periódica y la descarga con progreso son trabajo de P10 |
| §3.5 `INFERENCE_TLS_FINGERPRINT` | **No implementado**; `https` se **rechaza** | `fetch` no expone verificación de huella, y pinning de IP y validación de certificado por nombre son incompatibles. Fallar cerrado es preferible a aceptar una configuración que no se puede verificar |
| §3.6 parser `hermes-xml` declarado por `ModelProfile` | Implementado pero gobernado por el **runtime** (llama.cpp), no por el perfil del modelo | El perfil aún no viaja al proveedor; cuando lo haga, la puerta se moverá al perfil |
| §2.9 timeouts de primer token (60 s cloud / 120 s local) e inferencia total 300 s | Subsumidos por el reloj del turno (120 s) | Un límite más estricto y ya probado; si el perfil local con carga en frío necesita más, hay que subir el reloj del turno, no añadir un segundo temporizador |
| §3.2 NPU (Lemonade, OpenVINO) | Solo alias de runtime | Declarado experimental por la propia spec |
| §3.4 `sharesGpuWithTranscode` | Campo y aviso implementados, **sin perfil que lo declare** | Requiere la medición de P11 para saber con qué GPU compite Jellyfin |
| Certificación de cualquier backend | **Ninguno certificado** | La spec exige canario **y** perfil de rendimiento. Hay canario reproducible en ROCm/Windows; el perfil (p95 sobre benchmark) es P11 |
| Imágenes y modelos por digest en compose | Etiquetas, no digests | La propia spec lo deja para P10 |

### 5.2 Matriz real de backends

Nivel según §3.1.4, sin adornos:

| Backend | Nivel real | Qué lo respalda |
|---|---|---|
| ROCm (AMD, Windows con `HSA_OVERRIDE_GFX_VERSION`) | **soportado**, canario verde | Canario 3/3 en vivo sobre RX 7800 XT; sin perfil de rendimiento |
| CPU | **soportado** | Detección y dimensionado probados con fixtures; sin canario medido |
| CUDA | **soportado** | Detección (`nvidia-smi`) y perfil de compose probados con fixtures; sin hardware NVIDIA en laboratorio |
| Vulkan | **soportado** | Detección (`vulkaninfo`) y servicio de compose completo; sin canario |
| Metal | **experimental** | Solo parser de `system_profiler`; sin hardware Apple |
| SYCL (Intel) | **experimental** | Clasificación por `lspci`/WMI; nada más |
| NPU | **experimental, no anunciado** | Solo alias de runtime |

### 5.3 Desviaciones deliberadas respecto a la spec

1. **`select` y `monitor` exponen `catalog(search)`** además de lo que fija la tabla de §2.3. Sin eso, una
   conversación con referencia viva no puede iniciar otra búsqueda, que es exactamente el encierro que se
   corrigió. Son lecturas, y el recuento por fase sigue en dos o tres herramientas.
2. **`select` expone `operations(status)`** para que una pregunta sobre un plan se pueda responder desde
   cualquier fase de lectura.
3. **La fase `propose` se recorta por intención** (descarga → `catalog`, borrado → `library_ops`,
   conversión → `media_format`), como pide §2.3; con intención desconocida se exponen las tres, que es el
   comportamiento anterior.
4. **Proxies de entorno: se rechazan en vez de ignorarse.** Ni Node ni Bun permiten desactivar el proxy
   por petición de forma portable, así que se falla con un mensaje que dice qué variable estorba.
5. **Referencias cortas (`mref_<12 hex>`) en memoria del proceso.** No estaba en la spec; se conserva
   porque las refs firmadas consumían la mayor parte de un contexto de 8K. Consecuencia asumida y
   documentada: un reinicio las invalida y el usuario vuelve a buscar, igual que al expirar el TTL.
6. **`proposalKey` se calcula sobre la identidad estable** (guid de la release, rutas canónicas), no sobre
   el token opaco: cada búsqueda emite una ref nueva, así que usar la ref impediría toda deduplicación.
7. **El esquema del estado es v2**, con migración explícita desde v1 (`candidates` y `calibration` nuevos).

### 5.4 Riesgos que quedan abiertos

- **Sin hardware NVIDIA, Intel ni Apple en laboratorio**: sus rutas están probadas con fixtures capturadas y
  revisión de código, no con ejecución.
- **La clasificación de intención es léxica**. Acierta en los flujos del canario y en las pruebas, pero un
  mensaje ambiguo puede empezar en la fase equivocada; el coste está acotado porque cada fase solo expone
  lecturas y una propuesta, y toda mutación sigue requiriendo aprobación del owner.
- **El canario usa un MCP falso**. Prueba que el modelo encadena tres llamadas con datos reales del
  resultado anterior, no que los servicios respondan.
- **Telegram persiste el workflow en memoria**: un reinicio del bot pierde el estado de conversación (los
  planes viven en SQLite y sobreviven).

---

## 6. Cómo reproducir la verificación

```bash
npm ci
npm run ci:policy          # G00
npm run ci:build           # todos los paquetes
npm run ci:test            # G01: 711 pruebas, 0 skips
npm run test:agent-replay  # G07 (motor): 12 escenarios en doble pasada
npm run test:local-provider # G07 (proveedor local, hardware, catálogo)
npm run smoke:node-bun     # G08 incluida la carga de LocalProvider en Bun
npm run smoke:local-canary # LOC-01: requiere un runtime local escuchando
```

El canario detecta Ollama en `127.0.0.1:11434`; sin runtime cae a modo guionado, y en ese modo **no es
evidencia de compatibilidad** (el proveedor guionado emite justo las llamadas que el ledger comprueba).
Solo cuenta la ejecución en vivo, con el SHA revisado, adjuntando la salida del perfil de rendimiento.

## 7. Estado de los casos de aceptación

Los 22 casos de la matriz 1.1.0 tienen ahora la prueba que la sección 2 nombra. Dos matices que conviene
leer antes de firmar:

- **LOC-01** está verde en el laboratorio ROCm/Windows con `qwen2.5:7b`. Es un canario, no una
  certificación: ningún perfil del catálogo lleva `certified: true`.
- **LOC-07** cubre NVIDIA, AMD, Intel, Apple y CPU en los tres sistemas operativos mediante capturas de
  salida real más la ejecución en vivo sobre este host. Las rutas de Metal y SYCL no se han ejecutado en
  su hardware.

---

## 8. Referencias

- Contrato del lote: [PR04-P08-P09-SPEC.es.md](PR04-P08-P09-SPEC.es.md)
- Cierres de fase (corregidos por este documento): [P08-HANDOFF.es.md](P08-HANDOFF.es.md), [P09-HANDOFF.es.md](P09-HANDOFF.es.md)
- Blueprint: [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md) §4.5, §4.6, §7.3, §7.5
- Matriz de aceptación: [LOCAL-AGENT-ACCEPTANCE.json](../LOCAL-AGENT-ACCEPTANCE.json) (versión 1.1.0)
- Suites de remediación: `packages/chat-core/src/agent/agent-hardening.test.ts`,
  `packages/chat-core/src/providers/{local,endpoint-policy,select}.test.ts`,
  `packages/core/src/hardware/detect.test.ts`, `packages/core/src/models/catalog.test.ts`,
  `packages/mcp-server/src/chat/provider.test.ts`, `packages/mcp-server/src/operations/download-grab.test.ts`
