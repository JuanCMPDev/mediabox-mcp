# PR05 — Flujo del agente por intención y capacidades de lectura

Rediseño del flujo de fases para almacenamiento, formatos y descargas. Es la vía
de calidad elegida el 2026-09-13 entre las del §7.3 de
[PR05-QA-HANDOFF.es.md](PR05-QA-HANDOFF.es.md), y parte del estado verificado de
ese documento (experimento G10 n.º 2, `132a45a`).

| Campo | Valor |
|---|---|
| Rama | `work/local-agent/p10-p11-private-evals` |
| Base | `132a45a` |
| Commits | `5d2aeaa` lecturas MCP y router; `c76dcb4` flujo del agente; `7956db7` corpus v3 y documentación; `25849f4` correcciones que destapó el experimento 3; `6f0d035`, `7c6b9a7` y `88831c7` pasos que completa el runtime (§2.4) |
| Fecha | 2026-09-13 |
| Estado | Medido en los experimentos G10 3 y 4 (§9) y, con el corpus v4 y correcciones de producto, en el 5: 43–46 de 60; con `qwen3.5:9b`, en el 6: 41–44; con los pasos que completa el runtime (§2.4), en el 7: 55, 54 y 57, con SEARCH en 7/10 en la pasada 2. No compatible; G10 sigue en rojo. |

## 1. Problema

El experimento 2 dejó tres causas de fallo que dependían del diseño, no del modelo:

- **STORAGE 0/10.** El catálogo dependía de la fase. Para proponer, el modelo
  tenía que descubrir que `library_ops list` o `media_format analyze` lo
  llevaban a `propose`, y no lo hacía. Además, en `propose` desaparecían las
  lecturas que todavía necesitaba.
- **READ-06 sin herramienta.** La cola de descargas no estaba expuesta en
  ninguna fase.
- **Filtros tratados como títulos.** "2020" o "películas" se buscaban como texto
  porque `media_query` no podía listar por tipo y año.

La revisión del código encontró tres defectos más, que habrían rechazado
propuestas correctas:

- La validación de propuestas solo aceptaba el primer `releaseRef` y el primer
  `mediaRef` devueltos, así que proponer el segundo release o la película de
  2017 fallaba.
- Las rutas se comparaban como texto literal. `inspect_format` devuelve
  `media:…` y el listado devolvía la ruta tal como se pidió.
- `manage_files list` no aceptaba `media:…` y, fuera de Docker, tampoco las
  rutas `/data/…` que devuelve Jellyfin.

## 2. Modelo: intención y grounding

La intención de la petición decide el catálogo, y la fase queda como etiqueta de
progreso. Una acción de propuesta solo aparece con fase `propose`, para la
intención a la que sirve y con grounding verificado.

| Intención | Catálogo (máx. 4 + `present_choices`) | Propuesta posible |
|---|---|---|
| `delete` | `media_query`, `library_ops(list)`, `operations` | `library_ops(propose_delete)` con rutas listadas |
| `convert` | `media_query`, `library_ops(list)`, `media_format(analyze)`, `operations` | `media_format(propose)` sobre un archivo analizado |
| `inspect` | el mismo que `convert` | ninguna |
| `download` | `catalog(search, details, releases)`, `media_query`, `operations` | `catalog(propose_download)` con un release devuelto |
| `queue`, `status`, `owner_only` | `server_info`, `media_query`, `downloads`, `operations` | ninguna |
| `library`, `server` | `server_info`, `media_query`, `operations`; sin `downloads` desde el experimento 7 (READ-14) | ninguna |
| `maintenance` | `maintenance`, `server_info`, `library_ops(list)` | ninguna |
| `other` o sin intención | tabla por fase del §2.3 del spec de PR04, que fija G07 | ninguna |

Recorridos:

- **Almacenamiento:** resolver la entidad (`media_query search`), enumerar sus
  archivos (`library_ops list`), elegir las rutas exactas y `propose_delete`.
- **Formatos:** resolver el archivo (búsqueda y listado), `media_format analyze`
  y `propose` sobre la ruta analizada.
- **Descarga:** `catalog search`, `releases` y `propose_download`.

### 2.1 Transiciones (`agent/workflow.ts`)

- **Solo con propuesta y grounding.** Una búsqueda (`other`) que encuentra
  releases queda en `select`; la petición de descarga posterior pasa a
  `propose`.
- **Monitor sin bucles.** Tras `proposal_created`, `monitor` no ofrece
  propuestas. Vuelve a `propose` en dos casos:
  - una nueva petición del usuario con un objetivo observado que ningún plan
    propuso;
  - dentro del mismo turno, una observación nueva y no propuesta (por ejemplo,
    un segundo archivo analizado).

  Los objetivos de cada plan se guardan en `proposalTargets`. Un plan anterior
  a ese campo cuenta como si cubriera todo el grounding de ese momento.
- **Lecturas reanudables.** Una lectura pasa a `orient` sin consumir
  referencias. Si no nombra un tema, conserva los de la petición que
  interrumpe, de modo que "vale, descárgala" la reanuda. Una lectura sobre otro
  título reinicia como cualquier tema nuevo.
- **Sin retrocesos.** Un refinamiento nunca retrocede de fase. Un tema nuevo
  borra las referencias, como antes.

### 2.2 Referencias

- `WorkflowReferences` guarda conjuntos observados y acotados, del más antiguo
  al más reciente:

  | Conjunto | Límite |
  |---|---|
  | `mediaRefs` | 16 |
  | `releaseRefs` | 32 |
  | `paths` | 40 |
  | `inspectedPaths` | 16 |

  `mediaRef` y `releaseRef` se mantienen como foco.
- Solo cuentan los resultados completos. Un error, un `partial` o una fuente
  incompleta no aportan grounding.
- Listados y análisis se acumulan hasta el TTL o hasta un tema nuevo. Un
  archivo listado pero no analizado nunca se puede convertir.
- Las rutas se comparan por su clave canónica (`canonicalPathKey`).
  - `media:tv/x`, `tv/x`, `/data/tv/x` y `tv\x` son el mismo archivo.
  - `downloads/…` es otra raíz.
  - Una forma que no se puede mapear solo coincide consigo misma.

### 2.3 Validación antes del dispatch

`validateProposalGrounding` comprueba cuatro cosas:
- el release está entre los observados o seleccionados por el owner;
- el `mediaRef`, si se envía, está entre los observados;
- cada ruta de borrado está entre las listadas;
- la ruta de una conversión está entre las analizadas.

El rechazo le dice al modelo qué lectura le falta. El servidor MCP vuelve a
verificar referencias, rutas y alcance, y el owner aprueba cada plan en la app.

### 2.4 Pasos que completa el runtime (desde el experimento 7)

Los seis primeros experimentos muestran que un modelo de 7 a 9B imita el esquema
y la historia más de lo que sigue el prompt. Repite el nombre de argumento de
otra acción, pregunta antes de proponer o lista las opciones en texto. Estos
mecanismos llevan esa disciplina a los datos y al runtime.

Ninguno aprueba, ejecuta ni elige una mutación:
- el modelo sigue eligiendo el objetivo y los argumentos;
- el grounding valida cada propuesta, y solo se ha vuelto más estricto;
- el owner aprueba cada plan en la app;
- las guardas de producción no cambian: 6 inferencias, 8 llamadas y 120 s.

| Mecanismo | Qué hace | Origen |
|---|---|---|
| `path` por `paths` | `library_ops(propose_delete)` con `path` se despacha como `paths: [path]` antes de validar. El grounding comprueba la ruta igual que antes. | STORAGE-02, exp. 6 |
| Referencias con forma | Un `mediaRef` o `releaseRef` sin la forma `mref_` o `rref_` no llega al servidor. El resultado falla con `ERR_REF_INVALID` y dice qué se pasó y qué lectura da la referencia correcta. No consume la única reparación de esquema. | SEARCH-10 y ADV-02, exp. 5 |
| Título normalizado | Una búsqueda vacía cuya consulta envuelve el título en una frase de tipo, como "película del colibrí azul", se repite una vez con el título solo. La búsqueda automática en la biblioteca usa ese título. La primera llamada va siempre como la escribió el modelo. | READ-13, exp. 5 y 6 |
| Fuente caída | Un resultado parcial o un `ERR_UPSTREAM_UNAVAILABLE` dice que no se repita la llamada en el turno. La primera repetición idéntica no se despacha: recibe el mismo resultado con una nota de "ya contestado". La segunda se despacha, y la guarda de bucles la detiene. | SEARCH-10, exp. 6 |
| Referencia no verificada | Una `mref_` o `rref_` del mensaje que no está entre las verificadas de la conversación viaja con una nota: no puede usarse ni consultarse. No cambia referencias, fase ni grounding. | ADV-02, exp. 6 |
| Tarjetas de homónimos | Un turno de descarga que termina en texto tras una búsqueda con títulos iguales de distinto año o tipo recibe las tarjetas, con las `mediaRef` que devolvió el servidor, salvo que el owner ya haya desambiguado. Las tarjetas que emite el modelo sin referencia se completan con la `mediaRef` devuelta que coincide. | SEARCH-06 y 07, exp. 5 y 6 |
| Acción pendiente | Un turno de descarga, borrado o conversión que termina en texto en la fase `propose`, con el objetivo resuelto en ese turno y sin intento de propuesta, recibe una inferencia más. Su nota nombra la acción y recuerda que el owner aprueba en la app. Pide proponer solo si un objetivo cumple lo pedido, o decir en una frase que ninguno lo hace. | DOWNLOAD-01/02/05/06/07/09/10, STORAGE-01/05, exp. 6 |

**Cuándo el objetivo está resuelto para la acción pendiente.**
- Descarga: una lectura de releases completa en el turno, con un release no
  rechazado y con `releaseRef`.
  - Si la petición nombra un idioma de audio, la lectura debe llevarlo y no
    puede ir con `strictLanguage: false`. Así DOWNLOAD-03 no acaba proponiendo
    otro idioma.
  - Si nombra una resolución, el release debe tenerla.
  - La petición se lee del mensaje del turno y del resumen de la intención. Un
    seguimiento del mismo tema, como "sí, descárgala", amplía ese resumen en
    vez de sustituirlo. Así, un idioma dicho en el primer mensaje cuenta tras
    elegir una tarjeta o tras confirmar.
  - Un release de un homónimo que el owner no eligió no resuelve nada, tampoco
    en el turno siguiente a las tarjetas.
- Borrado: un listado completo en el turno.
- Conversión: un análisis completo en el turno.

**Cuándo no hay acción pendiente.**
- El mensaje del turno pide otra cosa, como "muéstrame las versiones".
- El turno ya intentó proponer, aunque se rechazara.
- Ya hubo una en el turno, o no queda presupuesto de inferencias.

Si la inferencia añadida vuelve vacía, la respuesta es el texto descartado.

**Grounding más estricto.**
- Un release marcado `rejected` no aporta `releaseRef`. Cuando todos están
  rechazados, como en DOWNLOAD-03, el turno no llega a `propose`.
- Elegir una tarjeta de título (`select_candidate`) borra las referencias
  derivadas, es decir, releases y rutas, aunque sea la `mediaRef` en foco.

**Lectura sin release aceptable.** Si todos los releases leídos están
rechazados, la línea "Next" dice que ninguno cumple lo pedido. Pide decirlo, sin
buscar de nuevo sin la restricción del usuario ni proponer otro release
(DOWNLOAD-03).

**Qué grupo recibe tarjetas.** Solo el de los títulos iguales a la consulta,
con el año entre paréntesis separado como hace el router. La forma normalizada
del título solo cuenta cuando el resultado es el del reintento.

**Estado de una descarga aprobada.** La nota de un `media_download` en
`succeeded` dice que el release solo se envió al descargador. Eso no significa
que esté en la biblioteca: salvo que la cola o la biblioteca lo muestren, se dice
que aún no está disponible (DOWNLOAD-08 y 09).

## 3. Lecturas del servidor MCP

| Herramienta | Cambio |
|---|---|
| `download_queue` (nueva) | Lee Sonarr, Radarr y qBittorrent con una petición acotada por fuente y paginación propia de cada una. `null` significa desconocido; una fuente caída queda `unavailable`, nunca vacía. No suma colas. `downloads.status` y `downloads.list_queue` se enrutan aquí, y `download_status` y `cancel_downloads` quedan bloqueados para el agente. |
| `jellyfin_search` | Filtro `year` aplicado antes de paginar, `page` ≥ 1, `pageSize` ≤ 50 y total real. `media_query(action:"list")` lista por tipo y año sin título. |
| `manage_files list` | Acepta las mismas formas de ruta que `inspect_format` (`media:…`, `downloads:…` y rutas de contenedor como `/data/…`). Devuelve cada entrada, ordenada, con su ruta canónica exacta. El sandbox sigue decidiendo la contención. |
| `qbitApi` | Propaga la señal de cancelación. |
| `server_status` | Desde el experimento 7, el disco lleva `name: "media library"` y el resultado un `diskNote`: cualquier otro disco, de copias o externo, es desconocido (READ-07). |
| `manage_files list`, tamaños | Desde el experimento 7, en unidades legibles: "4 KB", no "0.0MB". Las carpetas no llevan tamaño (STORAGE-05). |
| `propose_cleanup` | Desde el experimento 7 devuelve `freedNow: "0 B"` junto a los avisos: la cuarentena no libera espacio hasta una purga aprobada (STORAGE-05). |

## 4. Clasificación de intención

`classifyIntent` evalúa en este orden:

1. `owner_only`: aprobar, restaurar, purgar o vaciar la cuarentena.
2. `status`: un plan, o qué fue de una descarga aprobada ("¿se descargó?",
   "¿ya puedo verla?").
3. `queue`: preguntas sobre descargas en curso, salvo una orden de descarga.
4. `convert`.
5. `maintenance`.
6. `delete`.
7. `inspect`: verbos de análisis, codecs o pistas. La palabra "subtítulos" sola
   no basta.
8. `download`: verbos en imperativo. "Tengo descargados" no cuenta.
9. `other`: búsquedas.
10. `server`: sesiones, espacio, salud o historial.
11. `library`: posesión, recuentos, listados, años o episodios numerados.

Un mensaje sin intención conserva la anterior. Una búsqueda sin tema ("busca
otra versión") refina la petición en curso.

`agent/intent-corpus.test.ts` fija la intención esperada de los 68 mensajes de
usuario del corpus sellado. Un mensaje nuevo o reformulado falla hasta que se
declare la suya.

## 5. Prompt

El prompt se construye con el mismo catálogo que valida el dispatch:
- cada intención tiene una línea "Next" que solo nombra acciones expuestas;
- una regla nueva pide decir que una operación sin herramienta no está
  soportada, y no simularla;
- el techo de 1400 tokens se comprueba en todas las combinaciones de fase,
  intención y grounding;
- desde el experimento 7, la regla de mutaciones pide proponer en el mismo turno
  cuando el objetivo está resuelto, sin pedir confirmación en el chat;
  `present_choices` admite una frase de acompañamiento, y la línea "Next" de
  descarga pide el release que cumple todo lo pedido.

## 6. Evals

- **Corpus `pr05-p11-corpus-v3`.** READ-06 exige leer `download_queue`, y esa
  lectura cuenta como primer evento útil en READ. El resto del corpus no cambia;
  los mensajes son los mismos.
- **qBittorrent sintético.** Respeta `sort`, `reverse`, `offset` y `limit` como
  la WebUI API. Sin eso, la página 2 de la cola repetía la 1 en el laboratorio.
- **Evidencia anterior.** Los experimentos 1 y 2 usaron el corpus v2 y código
  anterior, así que no sirven para este candidato.

## 7. Verificación local

| Comando | Resultado |
|---|---|
| `npm run typecheck` (build de todos los workspaces) | OK |
| chat-core, `vitest run` (incluye G07 y las pruebas nuevas) | 445/445 |
| mcp-server, `vitest run` | 359/359 |
| `npm run test:eval-harness` | 43/43 |
| `npm test` (todos los workspaces) | 1044/1044: chat-core 445, core 226, mcp-server 359, mediabox-cli 14 |
| `npm run ci:verify-evidence` | FAIL, esperado: evidencia `local-lab` e incompatible con los umbrales |

Los experimentos G10 3 y 4 midieron este código y sus correcciones (§9).

Con los pasos que completa el runtime (§2.4), antes del experimento 7:

| Comando | Resultado |
|---|---|
| `npm run ci:build` y `npm run ci:typecheck` | OK |
| chat-core, `vitest run` | 627/627 |
| mcp-server, `vitest run` | 376/376 |
| `npm run test:agent-replay` (incluye G07) | 422/422 |
| `npm run test:eval-harness` | 67/67 |
| `npm run ci:policy` (G00) y `npm run ci:test` (G01) | OK, sin tests omitidos |

## 8. Límites y siguiente paso

- **G10 no alcanza todavía la calidad exigida.** Con `qwen3.5:9b` y los pasos
  del runtime, el experimento 7 deja SEARCH en 7/10 en una de las tres pasadas
  (§9). Después hace falta evidencia de un controlador confiable (§7.2 del
  handoff de QA).
- **Carrera de STORAGE-09.** El arnés cancela la conversión cuando ya terminó,
  y el oráculo lo cuenta como infracción de alcance (§9).
- **Carpetas grandes.** La compactación muestra al modelo cinco entradas por
  listado y el listado no pagina. El grounding cubre 40 archivos, pero el
  modelo solo ve cinco.
- **Clasificador léxico**, en español e inglés. Un error de clasificación solo
  cambia qué lecturas se ofrecen; nunca desbloquea una propuesta sin grounding.
- **Montajes personalizados.** `canonicalPathKey` conoce los montajes por
  defecto del servidor; un montaje personalizado solo coincide con su forma
  literal.
- **Oráculos sin tocar.** Los que rechazan negativas correctas (READ-07,
  ADV-02/04/07) siguen igual.
- **Texto descartado visible un instante.** La UI web muestra los tokens del
  texto que descarta la acción pendiente hasta que `done` lo sustituye. Quitarlo
  exige un evento de reinicio en contracts y en la UI. Telegram usa solo
  `done.fullText`.
- **Notas fuera de la estimación de presupuesto.** La nota de la acción
  pendiente, igual que la del reintento vacío, se añade después de
  `prepareContext`. El prompt más largo de los experimentos usó 3771 de los 6656
  tokens de entrada.
- **Lecturas extra sin plazo propio.** El reintento con el título normalizado y
  la búsqueda en la biblioteca no se acotan con el tiempo restante del turno.
  Con servicios lentos, un solo dispatch puede pasar de los 120 s.
- **Normalización léxica.** "El Show de Truman" se reintenta como "Truman". Solo
  ocurre tras una búsqueda vacía, y la nota dice qué consulta se usó.
- **Idioma de la lectura de releases.** La acción pendiente exige que la
  lectura lleve un idioma cuando la petición nombra uno, pero no comprueba que
  sea el mismo. Una lectura en latino para una petición en japonés contaría.
  La nota sigue pidiendo proponer solo lo que cumple lo pedido.
- **Traza de fallos del servicio.** Un `ERR_UPSTREAM_UNAVAILABLE` que llega en un
  sobre MCP se traza como `ERR_TOOL_FAILURE`; la repetición y la nota lo
  reconocen por el código del sobre.

## 9. Experimentos 3 a 7

El detalle está en los §4.3, §4.4, §4.6, §4.8 y §4.9 de [PR05-QA-HANDOFF.es.md](PR05-QA-HANDOFF.es.md).

| Experimento | Candidato | Éxitos por pasada | STORAGE | DOWNLOAD | Primer evento útil, p95 |
|---|---|---|---|---|---|
| 2, diseño anterior | `81c05f6` | 27, 29, 28 | 0/10 | 7–8/10 | infinito |
| 3, este diseño | `7956db7` | 24, 26, 27 | 3–4/10 | 1–2/10 | 1,1–1,2 s |
| 4, con correcciones | `25849f4` | 38, 37, 36 | 4–5/10 | 6–7/10 | 1,0–1,1 s |
| 5, corpus v4 y correcciones de producto | `b041854` | 46, 46, 43 | 7–9/10 | 7–9/10 | 1,1 s |
| 6, `qwen3.5:9b` con corpus v5 | `1624dd8` | 44, 41, 43 | 7/10 | 3/10 | 1,9 s |
| 7, pasos que completa el runtime (§2.4) | `5e16093` | 55, 54, 57 | 9/10 | 9–10/10 | 1,9–2,0 s |

El experimento 3 destapó defectos del propio cambio, corregidos en `25849f4`:
- la línea "Next" de descarga pedía el año, y el modelo lo inventaba;
- el formato de argumentos de un modelo pequeño chocaba con la validación:
  `null` en parámetros opcionales, mayúsculas en enums y tamaños de página fuera
  de rango. Ahora se normaliza contra el esquema publicado antes de validar, y
  las propiedades desconocidas y los tipos erróneos siguen siendo estrictos;
- los esquemas no mostraban los tipos del catálogo, los límites de página ni
  los perfiles de conversión;
- `manage_files list` no aceptaba la ruta de un archivo, que es como Jellyfin
  informa de una película;
- las sesiones activas se confundían con el historial, y las peticiones
  reservadas al owner recibían tarjetas.

El experimento 4 registra 3 infracciones de alcance por pasada, todas de
STORAGE-09. Las causa una carrera del arnés, no el agente: el trabajo aprobado
termina antes de la cancelación programada.

El experimento 5 no tiene infracciones: el corpus v4 corrige esa carrera y las
averías que nunca se aplicaban (§4.5 del handoff de QA).

El experimento 6 cambia el modelo a `qwen3.5:9b`. Recorre bien el flujo de este
diseño hasta el objetivo exacto, pero pregunta antes de proponer y lista las
opciones en texto en vez de usar `present_choices`. Por eso DOWNLOAD cae a 3/10
(§4.8 del handoff de QA).

El experimento 7 mide los pasos que completa el runtime (§2.4) con el mismo
modelo, corpus y perfil. Con ellos pasan en las tres pasadas los nueve
escenarios en los que el modelo preguntaba antes de proponer, las tarjetas de
SEARCH-06/07, READ-07, READ-13 y ADV-02. Queda SEARCH en 7/10 en la pasada 2.
Siguen fallando tres casos:
- `paths` enviado como texto JSON (STORAGE-02);
- la nota de fuente incompleta, que el modelo no transmite (READ-10, SEARCH-10);
- la redacción de READ-04 (§4.9 del handoff de QA).
