**Evaluación de producto y plan de crecimiento de Mediabox**

Revisión: 8 de septiembre de 2026. Código local: `8c6a976`, versión `2.2.0-beta.3`. Propuesta de trabajo, no compromiso de fechas ni predicción de estrellas.

Actualización de enfoque: 9 de septiembre de 2026. El instalador monta y configura los servicios; el agente integrado en la app administra descargas desde indexadores, biblioteca, almacenamiento y formatos mediante MCP. La evolución propuesta prioriza inferencia local y privacidad. Conectar instalaciones existentes queda como una extensión de adopción, sin desplazar ese objetivo.

Mi valoración: hay un producto útil y una base técnica con bastante trabajo de dominio. Su oportunidad es entregar un stack listo y un agente privado para administrarlo diariamente. Para crecer necesita una entrada más fácil, operaciones confiables y una demostración clara del resultado. La inferencia local es una capacidad propuesta, todavía no implementada en este checkout.

La revisión incluyó código de los ocho paquetes, configuración Docker, CI/releases, documentación, landing y alternativas actuales. Se ejecutaron tres comprobaciones aisladas de código con operaciones de red y archivos sustituidas. No se instalaron dependencias, no se levantó el stack y no se ejecutó la suite completa: este checkout no contiene `node_modules`. No se verificaron rendimiento, consumo de recursos ni compatibilidad práctica de los instaladores. Los hallazgos no constituyen una auditoría exhaustiva de seguridad.

**1. Qué producto hay detrás de la premisa**

El valor tangible está en resolver la coordinación entre Jellyfin, Sonarr, Radarr, Prowlarr y los descargadores. El motor crea configuración, arranca servicios, espera disponibilidad, extrae claves, configura clientes y bibliotecas, sincroniza aplicaciones y reinicia componentes con las credenciales descubiertas. Esto existe en [orchestrate.ts](../packages/core/src/orchestrate.ts).

Además hay operaciones de dominio: resolver títulos e identificadores, inspeccionar colas, importar contenido, organizar archivos, corregir subtítulos y consultar estados entre servicios. Desktop, CLI y MCP ofrecen distintas entradas a ese trabajo.

La propuesta que probaría con usuarios es: **“Monta tu servidor multimedia y adminístralo desde una sola app.”** Cuando se haya implementado y comprobado la inferencia local, añadiría: **“Con un agente privado que corre en tu equipo.”** El instalador entrega configuración y servicios disponibles; el agente se ocupa de las operaciones posteriores.

Mantendría MCP en el nombre técnico, los topics y las integraciones. En la primera pantalla explicaría el beneficio sin exigir que el visitante conozca el protocolo. Unificaría la marca principal como Mediabox y usaría Desktop, CLI y MCP para distinguir componentes; hoy conviven Mediabox MCP, Mediabox OS y create-mediabox.

El público central es quien quiere un servidor multimedia propio y una forma cómoda de administrarlo. Para evaluar las primeras versiones también invitaría a usuarios experimentados de Jellyfin y Sonarr/Radarr: conocen los problemas y pueden contrastar los resultados del agente. Ese reclutamiento no exige convertir la importación de stacks existentes en el siguiente gran desarrollo.

La tensión actual es importante: el principiante debe entender Docker, rutas, indexadores y claves de modelos; el experto ya tiene esos servicios y necesita conectarlos con poca fricción. Dos recorridos explícitos permiten atenderlos mejor.

**2. Fortalezas que conservaría**

- La automatización llega hasta configurar servicios por API. La abstracción `Deployer` y el motor compartido permiten mejorar CLI y escritorio desde una base común.
- Hay conocimiento del dominio multimedia: episodios, releases, idiomas, identificadores, colas, importaciones y formatos. Es una inversión acumulativa útil.
- Existe una interfaz de producto: wizard, progreso, dashboard, chat, tarjetas de selección, logs y ajustes. El sidecar empaquetado reduce requisitos para quien usa el instalador Desktop.
- Ya hay distribución y presentación: instaladores públicos, imágenes Docker, documentación bilingüe y una [landing con capturas y descargas](https://createmediabox.dev/).
- Hay medidas y pruebas de robustez: restricción de rutas y URLs, orígenes permitidos, bind local, comparación constante de claves y tokens de confirmación. Su cobertura y aplicación necesitan completarse.
- La licencia MIT facilita probar, integrar y contribuir.

**3. La competencia y el espacio disponible**

Las descripciones siguientes proceden de los repositorios oficiales consultados; las implicaciones son mi interpretación.

| Alternativa | Qué resuelve | Implicación para Mediabox |
|---|---|---|
| [YAMS](https://github.com/rogsme/yams) | Instalación y gestión de un stack multimedia, con opciones de VPN y backups. | La instalación sencilla necesita demostrar una ventaja concreta. |
| [Saltbox](https://github.com/saltyorg/Saltbox) | Despliegue con Ansible, orientado a Ubuntu, sin GUI propia. | Hay espacio para una experiencia visual accesible. |
| [Deployrr](https://github.com/SimpleHomelab/Deployrr) | Despliegue y mantenimiento de aplicaciones de homelab. | La especialización multimedia puede aportar más que ampliar el catálogo de servicios. |
| [Seerr](https://github.com/seerr-team/seerr) | Descubrimiento y solicitudes multimedia, con permisos y soporte móvil. | Conviene convivir con las herramientas de solicitudes que el usuario ya utiliza. |
| [MCPArr](https://github.com/ondrejmirtes/mcparr) | Control Sonarr/Radarr mediante MCP, diagnóstico y modo de lectura. | El protocolo y el chat ya tienen competencia directa. |
| [arrstack-mcp](https://github.com/CT4nk3r/arrstack-mcp) | Conexión MCP a varios servicios multimedia configurables. | La adopción de servicios existentes es una expectativa competitiva. |

La diferenciación propuesta es la calidad de la experiencia completa: **conectar → detectar el problema → mostrar evidencia → proponer el cambio → aprobar → comprobar el resultado**. Diagnosticar con IA tampoco es exclusivo; debe funcionar de manera reproducible para convertirse en una razón de recomendación.

**4. Bloqueos concretos que corregiría antes de ampliar la difusión**

| Prioridad | Evidencia local | Impacto | Criterio de cierre |
|---|---|---|---|
| P0 | [auth.ts](../packages/mcp-server/src/auth.ts), líneas 20–40 y 76–80; [index.ts](../packages/mcp-server/src/index.ts), líneas 42–68. | El proveedor concede código OAuth sin autenticar al propietario. El token resultante pasa el middleware compartido de MCP y administración. | Autenticación real del propietario, consentimiento y separación de permisos; pruebas HTTP completas de rechazo y autorización. |
| P0 | [library.ts](../packages/mcp-server/src/tools/library.ts), líneas 131–174. | El preview muestra un episodio, pero la ejecución calcula su directorio padre y lo borra recursivamente. La ruta de Jellyfin tampoco pasa por la validación de rutas de esta rama. | Preview y ejecución comparten el mismo conjunto exacto de archivos; borrar un episodio conserva sus vecinos; validar también las rutas recibidas de servicios. |
| P0 | [downloads.ts](../packages/mcp-server/src/tools/downloads.ts), líneas 422–431. | Si fallan Sonarr y Radarr, la limpieza considera huérfanos todos los torrents y pide borrar también sus archivos. | Ante información incompleta no borrar; identificar propiedad/categorías, paginar y mostrar un plan exacto antes de ejecutar. |
| P1 | [confirm-tokens.ts](../packages/mcp-server/src/helpers/confirm-tokens.ts) y [engine.ts](../packages/chat-core/src/engine.ts), líneas 111–142. | Los tokens acreditan una vista previa y sus argumentos; no acreditan aprobación humana. El modelo recibe el token y puede usarlo en la siguiente iteración. | Operación pendiente vinculada al usuario y sesión, aprobada mediante un canal que el modelo no pueda autoautorizar. |
| P1 | [ci.yml](../.github/workflows/ci.yml), línea 32. | CI ejecuta tests de core; las suites existentes de servidor, chat y CLI no bloquean PR. | Ejecutar esas suites y compilar UI en PR; añadir recorridos completos de los flujos críticos. |
| P1 | [docker-compose.ts](../packages/core/src/generators/docker-compose.ts), líneas 96–122. | El contenedor MCP generado omite las variables del proveedor de IA, aunque su chat las necesita. Las variables se pasan al bot. | Probar la configuración generada y el chat en cada superficie soportada; documentar capacidades diferentes donde corresponda. |
| P1 | [history.ts](../packages/chat-core/src/history.ts), conversión de schemas, y [virtual-tools.ts](../packages/chat-core/src/virtual-tools.ts), `present_choices`. | El conversor Gemini transforma arrays no numéricos en arrays de strings, aunque las tarjetas esperan objetos. | Conversión recursiva y prueba de selección completa por proveedor. |

Tres resultados se comprobaron ejecutando lógica del repositorio de forma aislada:

- OAuth: se emitió un código, se intercambió por un access token y el middleware lo aceptó sin suministrar credenciales del propietario. Se retiró en memoria el import de tipos de Express; no se probó el router HTTP real.
- Borrado: con un episodio ficticio `/data/tv/TestShow/Season 01/Episode 01.mkv`, el handler solicitó eliminar recursivamente `/data/tv/TestShow/Season 01`. `fs.rm` estaba sustituido y no borró archivos.
- Limpieza: con ambas APIs arr simuladas como no disponibles y dos torrents ficticios, el handler solicitó eliminar ambos con `deleteFiles: true`. No se llamó a servicios reales.

Las pruebas aisladas de handlers sustituyeron los schemas y todas sus dependencias de archivos/red. Confirman esas ramas de ejecución; no sustituyen pruebas de integración del producto completo.

Al ampliar CI, aislar primero los fixtures de filesystem. La prueba de `sandbox-wiring.test.ts` que acepta un token recién emitido usa `/data/anime/The Show` y no sustituye `fs`: no debe depender de rutas potencialmente reales.

**5. Carencias de producto y distribución**

El recorrido “ya tengo estos servicios” sigue siendo una oportunidad posterior. Las URLs se pueden configurar manualmente, pero el arranque Desktop prioriza completar su wizard y conectar el sidecar local. Cuando se aborde, ofrecería selección de servicios, URL/clave por servicio, comprobación de conectividad y registro únicamente de las capacidades disponibles. Primero priorizaría el agente privado sobre el stack que monta Mediabox.

El README dirige al usuario Desktop hacia `git clone`, npm, Rust y Bun. Ya existen [releases con instaladores](https://github.com/JuanCMPDev/mediabox-mcp/releases); pondría los enlaces de descarga al principio y movería la compilación al recorrido de contribución. Las releases consultadas indican que los binarios beta no están firmados: firma y notarización merecen prioridad cuando se quiera captar usuarios de escritorio menos técnicos.

La landing muestra `2.2.0-beta.0`, mientras el checkout y la release consultada son `2.2.0-beta.3`. No verifiqué el dist-tag actual de npm. Hace falta una fuente de versión común para landing, documentación, npm, imágenes e instaladores, y comprobaciones de los enlaces. Los workflows actuales publican Desktop y Docker por separado; las betas también reciben el tag Docker `latest`. Separaría claramente los canales estable y beta.

La pantalla inicial del chat necesita tres acciones que den valor inmediatamente. Por ejemplo: comprobar conexiones, inspeccionar el estado de una obra y revisar una descarga bloqueada. El diagnóstico básico debería estar disponible sin proveedor de IA; el modelo puede ayudar a interpretar y operar sobre resultados estructurados.

Hay una semilla especialmente valiosa en `get_library_state`, dentro de [library.ts](../packages/mcp-server/src/tools/library.ts), líneas 261–305. Consulta Jellyfin, arr y su cola. Hoy cruza títulos con coincidencias parciales, silencia errores y no aparece en el router virtual del chat propio. Lo convertiría en una consulta con identidades consistentes, evidencia por servicio y estados distintos para “ausente”, “no se pudo consultar” e “inconsistente”.

Las operaciones coordinadas deben informar éxitos parciales. Actualmente algunas capturan errores de servicios y luego afirman que todo terminó correctamente. Los trabajos e historial están en memoria: para mantenimiento fiable conviene persistir operaciones y resultados, detectar interrupciones y ofrecer reintentos seguros.

La exportación Desktop guarda estado/configuración; no constituye una restauración integral de volúmenes y bases de datos. La actualización desde ajustes opera sobre imágenes Docker. Documentaría esos alcances y probaría una restauración real antes de prometer recuperación completa.

No encontré CONTRIBUTING.md ni SECURITY.md en la raíz, plantillas de issues/PR o un roadmap público en este checkout. Un camino corto para reproducir bugs, una política de reporte privado y tareas pequeñas con aceptación clara reducirían la dependencia del mantenedor.

**6. Plan por etapas**

Supuesto: un mantenedor principal. Ventana orientativa de ocho a diez semanas, ampliable según dedicación. Los criterios de salida mandan sobre el calendario. Las mejoras de documentación pueden avanzar junto a las correcciones técnicas.

| Etapa | Entregables | Condición para avanzar |
|---|---|---|
| Semanas 1–2: confianza | Corregir los tres P0; completar las barreras de aprobación; ejecutar suites relevantes en CI; cubrir el resultado de borrados y errores de servicio. | Ninguna operación destructiva del alcance probado amplía la selección ni actúa con evidencia incompleta. Autenticación verificada por HTTP. |
| Semanas 2–3: probar inferencia local | Adaptador de inferencia local, modelo/runtime concretos, consulta real de biblioteca y retorno de herramientas. Mejoras del README en paralelo. | El agente completa consultas de lectura sin enviar conversaciones ni resultados a proveedores externos de IA. |
| Semanas 3–5: agente fiable | Contexto configurable, herramientas claras, referencias de selección, resultados tipados, aprobaciones y trabajos verificables; ajustes de IA en la app. | Pruebas repetibles de búsqueda, selección, descarga y planificación de almacenamiento con datos controlados. |
| Semanas 5–7: experiencia completa | Flujo de descarga a biblioteca, diagnóstico de importación y plan de optimización; modelo recomendado según hardware medido. Distribución y versiones coherentes. | Escenarios con fallos y nombres ambiguos producen conclusiones correctas o incertidumbre explícita; el usuario instala y obtiene un primer resultado sin ayuda del autor. |
| Semanas 7–8: demostración y comunidad | Demo con datos de prueba, video de 60–90 segundos, tutorial completo, CONTRIBUTING, plantillas y roadmap corto. | Al menos tres casos reales documentados y material suficiente para que otro usuario reproduzca el resultado. |
| Semanas 8–10: lanzamiento y aprendizaje | Publicaciones adaptadas a cada comunidad, solicitudes a directorios, correcciones rápidas y seguimiento del embudo. | El soporte sigue siendo manejable y las nuevas instalaciones llegan a un primer resultado útil. |

La función protagonista de la demo sería: “Este episodio terminó de descargarse, pero no aparece en Jellyfin”. Mediabox muestra en qué servicio se detuvo el recorrido, qué evidencia lo explica y qué acción propone; tras una aprobación explícita, vuelve a consultar y muestra el resultado. Esta es una capacidad objetivo; el código actual contiene piezas, pero el flujo fiable completo aún debe construirse.

Pospondría nuevos servicios multimedia, una nueva app móvil, un marketplace de plugins y más proveedores de IA hasta cerrar ese recorrido. Cada plataforma añade una matriz de compatibilidad y soporte. También conservaría las integraciones de solicitudes existentes cuando cubran bien la necesidad.

**7. Cómo convertir ese trabajo en descubrimiento y estrellas**

La primera pantalla del README debería contener: una frase de resultado, video/captura, tres casos concretos y las entradas “Descargar Desktop” e “Instalar en servidor”. Cuando esté validado, mostrar también cómo activar el agente local. “Conectar mis servicios” puede añadirse después. Seguir con requisitos, plataformas probadas, explicación de permisos y guía técnica.

La landing ya existe. Reutilizaría sus capturas y sustituiría el énfasis en cantidad de herramientas por problemas resueltos. Una demo sin claves ni instalación permitiría comprobar la experiencia antes de comprometer tiempo. Debe estar rotulada como demo y usar fixtures explícitos.

Primero captaría diez a veinte usuarios objetivo para pruebas acompañadas. Observaría dónde se detienen, sin resolverles inmediatamente cada paso: esas pausas son evidencia para mejorar el onboarding. El objetivo inicial es conseguir uso y testimonios verificables.

Con el recorrido estable, prepararía un lanzamiento específico para comunidades Jellyfin/arr/homelab y otro para desarrolladores MCP. Cada publicación enseñaría un problema y su resolución, e indicaría lo que todavía está en beta. Revisar las reglas vigentes de cada espacio antes de publicar. Un tutorial replicable permite que creadores externos lo expliquen por su cuenta.

Revisaría publicación o presencia en el [MCP Registry oficial](https://modelcontextprotocol.io/registry/quickstart), [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md) y medios como [selfh.st](https://selfh.st/about/). Cada canal tiene requisitos propios. [Awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted-data/blob/master/CONTRIBUTING.md) exige antigüedad y excluye ciertas herramientas de despliegue; evaluaría encaje y elegibilidad antes de proponer una entrada.

Publicaría guías permanentes a partir de incidencias reales: importación fallida, permisos, rutas incompatibles o conexión de servicios. Una mejora visible y comprobable justifica volver a anunciar el proyecto. La petición de estrella puede aparecer después de enseñar el resultado o al final del tutorial.

**8. Qué medir y cómo decidir**

No hay una cifra de estrellas que pueda garantizarse. Mediría este recorrido: visita cualificada → intento de instalación/conexión → primer resultado útil → uso a siete días → recomendación o contribución. La estrella es una señal de interés; no demuestra que el producto se use.

Metas propuestas para el piloto, no métricas actuales:

- Veinte instalaciones o conexiones externas documentadas.
- Al menos 80% alcanza un primer resultado útil sin ayuda del autor, dentro del segmento y plataforma declarados como soportados.
- Medir por separado instalación del stack, descarga/carga del modelo y primera tarea del agente. Con servicios y modelo ya disponibles, proponer una mediana inferior a dos minutos para completar la consulta inicial. Es un objetivo a validar, no rendimiento medido.
- Diez usuarios que vuelven a usarlo en la semana siguiente y tres casos suficientemente claros para publicar con permiso.
- Registrar minutos de soporte por instalación, defectos repetidos y acciones cuyo resultado no se pudo verificar.

Durante el piloto basta un registro acordado con los participantes. Si se añade telemetría al producto, debe ser opcional y excluir nombres de bibliotecas, contenido de conversaciones, rutas y secretos. Las descargas npm y pulls Docker no deben contarse como usuarios únicos.

Si hay visitas pero pocos intentos, revisar propuesta y llamada a la acción. Si hay intentos pero poca activación, priorizar instalación/conexión. Si hay activación pero nadie vuelve, revisar utilidad recurrente. Si el soporte crece más rápido que el uso, mejorar diagnóstico y recuperación antes de ampliar la campaña.

El primer bloque de trabajo que elegiría es: corregir OAuth y ambos borrados, conectar las suites existentes a CI, demostrar una consulta de biblioteca con inferencia local y mejorar el README con los instaladores y capturas disponibles. Después ampliaría las operaciones del agente y validaría perfiles de hardware/modelo.

**9. Inferencia local: cambios necesarios y relación con MCP**

El protocolo MCP y el proveedor de inferencia son capas distintas. El agente de Mediabox recibe las propuestas de llamadas del modelo y utiliza su cliente MCP para ejecutarlas. La [arquitectura oficial de MCP](https://modelcontextprotocol.io/docs/learn/architecture) deja la elección del modelo y la gestión del contexto a la aplicación anfitriona. Adoptar Gemma o Qwen no exige cambiar el protocolo de transporte.

El checkout ya usa Streamable HTTP y el lockfile resuelve `@modelcontextprotocol/sdk` a `1.29.0`; el rango `^1.12.1` del manifiesto no es la versión exacta resuelta. No se verificó si `1.29.0` es la versión más reciente. Actualizar el SDK por mantenimiento requiere sus propias pruebas y no sustituye la integración local.

| Componente | Responsabilidad propuesta | Cambio |
|---|---|---|
| Instalador/core | Preparar contenedores, rutas, credenciales y conexiones. | Mantener su responsabilidad acotada; configuración del agente separada del éxito del despliegue multimedia. |
| App y chat-core | Conversación, selección de herramientas, contexto, permisos y seguimiento. | Añadir proveedor local, presupuestos por modelo y manejo fiable de resultados/aprobaciones. |
| Runtime de inferencia | Cargar pesos y generar texto/llamadas de herramientas. | Integrar inicialmente un runtime existente y una combinación de modelo comprobada. |
| MCP y operaciones | Consultar y modificar servicios y archivos. | Conservar transporte; mejorar contratos, validación, planes y verificación de efectos. |

Esta separación es de responsabilidades. El agente puede seguir ejecutándose en el proceso local que ya acompaña a la app; no obliga a reestructurar todo el monorepo. Las operaciones sobre archivos y FFmpeg deben ejecutarse donde estén disponibles los volúmenes multimedia, también cuando el modelo esté en otro equipo de la red del usuario.

La primera integración que propondría es Ollama mediante un adaptador de API compatible con Chat Completions. Su [documentación](https://docs.ollama.com/api/openai-compatibility) describe herramientas, streaming y listado de modelos. [LM Studio](https://lmstudio.ai/docs/developer/openai-compat/tools) sería un segundo destino del adaptador, validando sus diferencias. Compartir formato de API no garantiza idéntico comportamiento de todas las opciones.

En el código, [openrouter.ts](../packages/chat-core/src/providers/openrouter.ts) fija la URL de OpenRouter. Se puede extraer su lógica común y añadir un proveedor local con endpoint, modelo y autenticación configurables. Además deben extenderse `StreamProvider`, `resolveProvider`, contratos, generadores de configuración, variables del sidecar y ajustes de la app. El proveedor `google` actual usa Gemini; no ejecuta Gemma localmente.

No bastaría con cambiar la URL: el adaptador debe comprobar llamadas de herramientas con argumentos fragmentados, rechazar JSON inválido y finalizar correctamente cada llamada. Los perfiles deben declarar las opciones de contexto y razonamiento que realmente admite cada runtime; las funciones específicas pueden requerir un adaptador nativo.

Las familias Qwen y Gemma son candidatas. La ficha oficial de [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B) documenta uso de herramientas y un agente con MCP; Google documenta [function calling con Gemma 4](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4). Esto acredita capacidades documentadas, no rendimiento ni compatibilidad probada con Mediabox. Elegir la variante concreta exige medir modelo, cuantización, runtime, plantilla/parser, contexto y hardware en conjunto.

Cambios del agente con especial impacto en inferencia local:

- Sustituir el límite global de 200.000 tokens de `history.ts` por un presupuesto ligado al contexto configurado, contando prompt y herramientas y reservando salida. Aplicar el recorte al contexto realmente enviado en cada iteración.
- Evitar cortar JSON a mitad de una respuesta. `mcp-client.ts` extrae texto y lo trunca; conservar estado, datos compactos y paginación. Usar `isError` y resultados tipados en lugar de buscar la cadena `"error"`.
- Ofrecer pocas herramientas pertinentes por fase, con parámetros claros. Una búsqueda puede devolver `mediaRef` y una selección `releaseRef`, manteniendo TVDB/TMDB/GUID/indexerId dentro de la aplicación.
- Implementar reglas estables en código: ordenación por preferencias, cálculo de almacenamiento, perfiles de FFmpeg y validación de elecciones. El modelo interpreta la petición y explica las opciones.
- Detener la ejecución cuando falte aprobación, detectar repeticiones y verificar cambios. Un timeout de espera no debe confundirse con la cancelación del trabajo.
- Evaluar lectura, desambiguación, búsqueda en indexadores, descarga, espacio, optimización, fallos de servicios y denegación de cambios. Registrar éxito, latencia, llamadas incorrectas y memoria con el stack multimedia funcionando.

La promesa de privacidad propuesta es: **en modo local, Mediabox mantiene conversaciones y resultados de herramientas dentro del equipo o red privada configurados por el usuario**. Debe comprobarse mediante pruebas de tráfico y ausencia de fallback automático a la nube. Ollama permite desactivar sus funciones cloud con `OLLAMA_NO_CLOUD=1`, según su [FAQ](https://docs.ollama.com/faq).

Descargar pesos, consultar metadatos/indexadores y obtener contenido siguen pudiendo requerir Internet. Telegram añade su propio canal externo. Estos flujos necesitan una descripción distinta de la privacidad de inferencia; no se debe anunciar el producto entero como offline.

Está pendiente concretar el hardware objetivo y la ubicación de la inferencia. Para un prototipo se puede conectar un runtime ya instalado; después, la app puede ofrecer detección de recursos, descarga con progreso y gestión del modelo. Si comparte GPU/RAM con transcodificación, medir la concurrencia antes de fijar un perfil recomendado. No se ha descargado ni ejecutado ningún modelo durante esta revisión.
