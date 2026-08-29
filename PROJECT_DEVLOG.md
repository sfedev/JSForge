# PROJECT_DEVLOG.md — Registro técnico

Historial de construcción y decisiones de arquitectura de **ForgeJS IDE**.
Se escribe para el que llegue después: por qué está hecho así, qué se
descartó y qué falló por el camino.

> Convenciones: [`CLAUDE.md`](CLAUDE.md) · Reglas de agentes: [`AGENTS.md`](AGENTS.md)

---

## Estado

| | |
| --- | --- |
| Versión | 0.1.0 |
| Electron | 44 (Node 24.18, Chromium 152) |
| Toolchain | esbuild 0.28 · electron-builder 26 · TypeScript 5.7 |
| `npm audit` | **0 vulnerabilidades** |
| Pruebas | **329, todas en verde** |
| Código | ~40 000 líneas de TypeScript en `src/` |
| Canales IPC | 128 |
| Commits | 27 |

---

## Hitos completados

### Núcleo y seguridad

Proceso principal con instancia única, apagado ordenado y endurecimiento de
sesión. El renderer corre con `contextIsolation`, `sandbox` y sin
`nodeIntegration`, y se sirve por un esquema privilegiado propio `forge://app`
en lugar de `file://`, para que `'self'` en la CSP tenga un origen real.

El guardián de rutas (`assertInsideWorkspace`) valida toda ruta que llega del
renderer: rechaza absolutas, UNC, `..`, bytes nulos y nombres reservados de
Windows, y **resuelve los enlaces simbólicos antes de comparar**. Diez pruebas
lo cubren, incluida la fuga por symlink que apunta fuera del workspace.

### Motor DotForge

Parser tolerante del manifiesto: acepta formas abreviadas (`"dev": "next dev"`,
`"dev": ["web", "api"]`), comentarios y comas sobrantes, y convierte las claves
desconocidas en avisos en lugar de fallar. Cuando no hay manifiesto, se infiere
uno desde `package.json`, así que el gestor de pipelines funciona desde el
primer segundo sin obligar a crear archivos.

### IntelliSense multi-lenguaje

Cliente LSP propio sobre stdio con framing `Content-Length`. El decodificador
mide **bytes UTF-8, no caracteres**: medirlos en caracteres parte cualquier
mensaje con acentos o emoji. Ocho pruebas cubren el reensamblado byte a byte,
varios mensajes en un fragmento y cuerpos malformados que no desincronizan el
flujo.

Seis servidores (TypeScript, HTML, CSS, JSON, Volar, Tailwind) y once
proveedores de Monaco. Todos opcionales: si falta el binario, el servidor se
marca `unavailable` y el editor sigue funcionando.

### Control de fuentes

Parser propio de `git status --porcelain=v2` con separador NUL, el único
formato estable ante rutas con espacios. Separa índice y árbol de trabajo,
resuelve la ruta original de los renombrados y aísla los conflictos.

### Forge AI

Anthropic, OpenAI y Ollama sobre `fetch` y lectura de SSE, sin SDK. Claves
cifradas con `safeStorage`; si el sistema no puede cifrar, **no se guarda nada
en claro**. Contexto RAG con proyecto, dependencias, pipelines, diagnósticos y
selección, con presupuesto de caracteres y exclusión de `.env` y credenciales.

Edición en línea (`Ctrl+I`) con diferencia LCS por líneas mostrada **antes** de
tocar el documento, y aplicada como una sola operación deshacible.

### Generador con variantes arquitectónicas

11 blueprints, cada uno con **patrón de arquitectura elegible**:

| Tecnología | Patrones |
| --- | --- |
| React / Next | Feature-Sliced · Atomic Design · Modular DDD · Estándar |
| Angular | Clean Standalone · DDD Enterprise |
| Express / NestJS / Fastify | Hexagonal · Clean por capas |

Cada variante genera un árbol real —al menos un archivo por capa, con
importaciones en la dirección que el patrón exige— en vez de carpetas vacías.

**21 pruebas verifican las reglas de acoplamiento, no la existencia de
carpetas**: que `shared` no importe de capas superiores en FSD, que un átomo no
componga moléculas, que el dominio hexagonal no conozca el framework, que el
controlador por capas no salte al repositorio y que cambiar de patrón no deje
huérfanos del otro.

El asistente visual y la CLI comparten motor y producen lo mismo ante la misma
entrada.

### Migración a Electron 44

Electron 33 acumulaba 33 avisos de seguridad. Tres describían **exactamente**
la arquitectura de este IDE:

- `GHSA-v3j7-r9gq-3gjw` — un protocolo propio con `supportFetchAPI` y sin
  `corsEnabled` permite lecturas entre orígenes. Era la configuración literal
  del esquema `forge://`.
- `GHSA-h7rp-cf8h-j98x` y `GHSA-ff2p-hmqr-hxm4` — bypass del aislamiento de
  contexto y `contextBridge` respetando setters del prototipo. Todo el modelo
  del preload descansa sobre esas dos garantías.

Tras subir a Electron 44, esbuild 0.28 y electron-builder 26, `npm audit`
quedó en **0**. Las 12 vulnerabilidades restantes eran la cadena de
`electron-builder`, que solo corre al empaquetar.

### Sistema de diálogos asíncronos

`core/dialogs.ts` sustituye por completo las llamadas nativas del navegador:
`promptDialog` con validación en vivo y modo secreto, `confirmDialog` no
bloqueante y `selectDialog` filtrable. `Escape` cancela, `Enter` confirma y el
foco vuelve a donde estaba. El cierre de documentos con cambios sin guardar y
la resolución de conflictos de escritura pasaron a ser asíncronos.

### Motor de actualizaciones

`electron-updater` cuando está disponible, o cliente propio contra un feed JSON
(GitHub Releases, S3 o registro DotForge). Descarga en segundo plano sin
bloquear el renderer y **verificación SHA-256 antes de conservar el paquete**:
si la suma no cuadra, el binario se descarta. Aviso discreto en la barra de
estado, visor de notas de versión y opción de actualizar al salir o reiniciar
ya.

---

## Decisiones de arquitectura (ADR)

### ADR-001 — Separación entre abstracción de repositorio y cliente de persistencia

**Contexto.** Los blueprints de servidor ofrecen dos patrones (hexagonal y por
capas) y cuatro opciones de acceso a datos (Prisma, TypeORM, Drizzle, ninguno).
Combinarlos en las plantillas daría ocho variantes por framework.

**Decisión.** El ORM es **ortogonal al patrón de arquitectura**. La variante
arquitectónica es dueña de `src/` y define la abstracción de repositorio; el
cliente de persistencia se genera aparte, siempre en
`src/infrastructure/persistence/`, y lo escribe `ormFiles()` después de aplicar
la arquitectura.

- En **hexagonal**, el puerto vive en `domain/ports/item-repository.ts` y el
  adaptador en memoria en `infrastructure/persistence/`. El cliente del ORM cae
  al lado, como una implementación más del mismo puerto.
- En **por capas**, la abstracción es la clase `repositories/item.repository.ts`
  y el cliente del ORM queda igualmente en `infrastructure/persistence/`.

**Consecuencias.** Se generan 2 patrones × 4 ORM sin duplicar plantillas, y
cambiar de base de datos no toca el dominio ni los casos de uso.

*Compromiso conocido:* en la variante **por capas** conviven
`src/repositories/` y `src/infrastructure/persistence/`. Es coherente —el
cliente del ORM es infraestructura en ambos patrones— pero puede sorprender.
Se documenta en el README del proyecto generado. Si molesta en la práctica, la
alternativa es mover el cliente dentro de `repositories/` solo en esa variante.

### ADR-002 — Diálogos asíncronos propios en lugar de las llamadas nativas

**Contexto.** El IDE usaba `window.prompt()` en seis sitios y
`window.confirm()` en cuatro. **Electron no implementa `prompt()`**: lanza
`prompt() is not supported`. El fallo no lo detecta el compilador ni el
typecheck; solo aparece al pulsar el botón en la aplicación en marcha. Estaban
rotos crear archivo, renombrar, cambiar de rama, crear rama, guardar la clave
de IA y la edición en línea.

`confirm()` y `alert()` sí funcionan, pero bloquean el hilo del renderer y
abren un cuadro del sistema que ignora el tema del IDE.

**Alternativas descartadas.** Usar `dialog.showMessageBox` del proceso
principal por IPC: funciona, pero un cuadro modal del sistema para pedir un
nombre de archivo interrumpe más de lo que ayuda y no permite validación en
vivo.

**Decisión.** Un sistema propio en `src/renderer/core/dialogs.ts`, renderizado
en el DOM del shell:

- `promptDialog` — entrada con validación contextual **antes** de confirmar
  (nombres de archivo y de rama), modo secreto para claves API y modo
  multilínea.
- `confirmDialog` — confirmación no bloqueante, con variante destructiva.
- `selectDialog` — selector filtrable; sustituye a los prompts que listaban
  opciones en el mensaje y obligaban a teclear el nombre exacto.

Todos asíncronos, con `Escape` para cancelar, `Enter` para confirmar y
devolución del foco.

**Consecuencias.** `closeDocument()` pasó a ser asíncrono para poder preguntar
de verdad. Cambiar de rama mejoró: ya no hay que teclear el nombre exacto.
Se añadieron **guardias estáticas** que impiden reintroducir las tres llamadas;
sin ellas, el fallo volvería sin que nadie lo notara hasta usar la app.

---

### ADR-003 — Cliente WebSocket propio para el depurador CDP

**Contexto.** Depurar un proceso Node exige hablar el Chrome DevTools
Protocol sobre WebSocket con el inspector que expone `--inspect`.

**Alternativas descartadas.**

- `ws`, la librería estándar: arrastra dependencias nativas opcionales
  (`bufferutil`, `utf-8-validate`). Aunque son opcionales, npm intenta
  compilarlas y la promesa de builds sin `node-gyp` se vuelve frágil.
- El `WebSocket` global de Node 24: es estable, pero **no deja fijar
  cabeceras en la petición ni inspeccionar la respuesta del handshake**. Sin
  eso, conectarse a un puerto que no es un inspector da un error genérico en
  lugar de «el servidor respondió 200 en lugar de 101».

**Decisión.** Un codec RFC 6455 propio (`ws-frame.ts`) sobre `node:net`. El
codec es **puro**: entra `Buffer`, sale `Buffer`. Toda la lógica delicada
—máscaras, longitudes extendidas de 16 y 64 bits, fragmentación, respuesta a
los `ping`— queda cubierta por pruebas sin abrir un socket.

**Consecuencias.** Unas 300 líneas propias a cambio de cero dependencias y de
mensajes de error que dicen qué pasó. El codec destapó un fallo sutil durante
su propio desarrollo: `subarray` comparte memoria con el buffer acumulado, de
modo que una carga decodificada cambiaba a la espalda del llamante en cuanto
llegaba el siguiente fragmento. Hay una prueba que lo fija.

**Restricción de seguridad.** Solo se admiten destinos del bucle local. El
inspector de Node **no autentica**: quien puede hablar con él ejecuta código
arbitrario en ese proceso. Se verifica en el constructor del cliente y otra
vez al abrir sesión, a propósito.

---

### ADR-004 — El auditor de contratos responde a «qué se rompe», no a «qué cambió»

**Contexto.** Un cambio en `src/shared/contracts.ts` puede romper el tipado en
el main, en el preload y en el renderer a la vez. El diff dice qué líneas
cambiaron; no dice cuáles de esos cambios importan.

**Decisión.** Comparar la superficie exportada del módulo en el editor con la
de `HEAD`, y clasificar cada diferencia **desde el punto de vista del
consumidor**:

| Rompe | No rompe |
| --- | --- |
| Quitar un export o un campo | Añadir un campo **opcional** |
| Añadir un campo **obligatorio** | Volver opcional uno obligatorio |
| Volver obligatorio uno opcional | Añadir una variante a una unión |
| Cambiar el tipo de un campo | Reformatear |
| Quitar una variante de una unión | |

Añadir una variante a una unión rompe la exhaustividad del **productor**, no
la del consumidor, y marcarlo generaría ruido en cada ampliación legítima.

**Extracción textual, no semántica.** El extractor de formas lee
`export interface`, `export type` y `export const` por análisis de texto. Se
descartó cargar el compilador de TypeScript (unos 8 MB y medio segundo en un
proceso cuyo arranque instantáneo es un requisito) y se descartó evaluar el
módulo, que significaría ejecutar código del proyecto en el proceso principal.

**Consecuencia no obvia.** Los tipos se **normalizan** antes de compararse. Sin
eso, reformatear una unión larga a varias líneas se contaría como cambio de
tipo en cada campo que la use.

---

### ADR-005 — El informe de pruebas se pide a un archivo, nunca a stdout

**Contexto.** Vitest, Jest y Playwright emiten JSON, pero por la salida
estándar lo mezclan con avisos de dependencias, trazas de `console.log` de las
propias pruebas y barras de progreso.

**Alternativa descartada.** Rescatar el objeto JSON del texto buscando la
primera llave de nivel cero. Funciona hasta que una prueba imprime una llave.

**Decisión.** `--outputFile` (o `PLAYWRIGHT_JSON_OUTPUT_NAME`, que es como
Playwright lo hace). El archivo o está completo o no está: no hay estado
intermedio que interpretar mal.

**Ubicación de los artefactos.** `node_modules/.forge/`. Cuelga de
`node_modules` a propósito: **ya está ignorado por Git en cualquier proyecto
de JavaScript**, así que el informe y la cobertura no ensucian el estado del
repositorio del usuario ni obligan a tocar su `.gitignore`.

**Consecuencia.** El runner nativo de Node no sabe emitir el formato jest, así
que se lee su TAP y se convierte. Es un analizador más, pero mantiene la
promesa de que las pruebas se pueden ejecutar sin instalar nada.

**Detalle que costaría depurar.** Un archivo que ni siquiera se pudo cargar no
trae aserciones, pero sí un mensaje. Sin tratarlo como fallo, un error de
importación aparecería como «0 pruebas» y parecería un éxito silencioso.

---

### ADR-006 — Cifrar o no guardar

**Contexto.** Forge Vault guarda credenciales de desarrollo. `safeStorage`
delega en DPAPI, en el Llavero o en el almacén del escritorio, pero en algunos
Linux sin llavero configurado **no está disponible**.

**Alternativa descartada.** Guardar en claro cuando no se puede cifrar, «para
que al menos funcione». Es peor que no guardar: el usuario ve la credencial en
un almacén del IDE y cree que está protegida.

**Decisión.** Si el sistema no puede cifrar, la operación **falla con
`E_NOT_AVAILABLE`** y no se escribe nada. La interfaz lo dice explícitamente.

**Orden de las operaciones al promover.** Se cifra primero y se borra del
archivo después. Al revés, un fallo al guardar dejaría el valor perdido para
siempre.

**Consecuencia.** Los secretos promovidos se inyectan en el entorno de los
procesos que lanza el IDE **y** se añaden al juego de redacción de la salida.
Sin lo segundo, una credencial promovida se imprimiría sin enmascarar en el
panel de salida, que es justo el escenario que el vault pretende evitar.

---

### ADR-007 — El manifiesto de plugin se lee, nunca se ejecuta

**Contexto.** Un motor de extensiones necesita que el proyecto aporte
comportamiento. El requisito excluía el *forking* de procesos.

**Alternativas descartadas.**

- **Evaluar `.forge/plugin.ts` en el proceso principal**, con `vm` o sin él.
  Es donde viven las claves descifradas y el acceso al disco sin
  restricciones. `node:vm` **no es una frontera de seguridad**: contiene
  accidentes, no ataques.
- **Un proceso hijo dedicado.** Excluido por requisito, y además contradice el
  arranque instantáneo.

**Decisión.** El manifiesto es **declarativo**: describe qué aporta el plugin,
no cómo hacerlo. Se analiza con un lector de literales que acepta datos y
rechaza —señalando la línea— todo lo que exigiría evaluar: referencias a
variables, llamadas e interpolaciones de plantilla.

Las acciones son **verbos cerrados** (`shell`, `command`, `write`, `open`) que
el IDE ya sabe hacer, ejecutados por sus servicios de siempre: `shell` por el
gestor de procesos (que redacta secretos y acota el cwd), `write` por
`fs-service` (que valida la ruta con el guardián).

**La propiedad que se obtiene:** un plugin no puede hacer nada que el usuario
no pudiera hacer desde la propia interfaz.

**La contrapartida, explícita.** No admite lógica arbitraria. Un plugin que
necesite calcular algo lo pone en un script de npm y lo invoca con
`task: 'shell'`. Ampliar las capacidades exige **añadir un verbo a la unión
`PluginAction`**, lo cual es deliberadamente incómodo: obliga a razonar sobre
las implicaciones de cada capacidad nueva.

---

### ADR-008 — Inyectar la dependencia del vault en vez de importarla

**Contexto.** Los secretos cifrados deben llegar al entorno de los procesos
que lanza el IDE. Lo natural era importar el almacén desde `env-service`.

**Qué pasó.** El almacén usa `safeStorage`, es decir `electron`. La suite de
pruebas importa `env-service` para ejercitar el análisis de archivos `.env`, y
al añadir ese import **la suite entera dejó de arrancar** con
`SyntaxError: Named export 'app' not found`, un mensaje que no dice nada del
problema real.

**Decisión.** `env-service` expone `setVaultSecretProvider()` y `main.ts`
registra el proveedor durante el arranque. El módulo sigue siendo analizable
sin Electron.

**Consecuencia.** Se añadió `tests/architecture.test.ts` con once guardias,
entre ellas un recorrido **transitivo** que detecta este acoplamiento antes de
que rompa la suite. Distingue `import type` —que TypeScript borra y es
inofensivo— de un import de valor: esa distinción es justamente la que hacía
que el mismo camino a través de `event-bus.ts` fuera inocuo.

Se verificó que la guardia falla de verdad reintroduciendo el import a
propósito.

---

## Bitácora de errores

Fallos reales encontrados y corregidos. Se registran porque cada uno dejó una
prueba o una regla detrás.

| Fallo | Cómo se detectó | Corrección |
| --- | --- | --- |
| `type: module` rompía la carga del main | Al primer arranque | Bundle CJS para main y preload |
| `prompt() is not supported` | Usando la app | Sistema de diálogos propio + 2 guardias |
| Botones de copiar sin efecto **ni aviso** | Auditoría de APIs del renderer | Permitir `clipboard-sanitized-write`; `copyToClipboard()` informa del fallo |
| Elegir carpeta destino cambiaba de workspace | Auditoría del asistente | Canal `dialog/pick-directory` sin efectos secundarios |
| El generador solo existía en la paleta | Reportado: «no permite crear una solución» | Botón en barra de título, bienvenida y explorador |
| La X del panel de IA no cerraba | Reportado | La X cierra; la papelera limpia |
| `Object has been destroyed` al cerrar | Reportado con la traza | `emit()` leía `webContents` fuera del `try`; el bus se desata antes del apagado |
| Pipeline `ci` de Nx con tarea inexistente | Prueba de normalización del manifiesto | Declarar la tarea `typecheck` |
| La CLI ignoraba los valores por defecto | Prueba de extremo a extremo de la CLI | Los defaults se aplican en `generate()` |
| `tailwindcss-language-server` no existía | Inventario de binarios instalados | Es `@tailwindcss/language-server` |
| `@default(autoincrement())` mal parseado | Prueba del esquema Prisma | Lectura con paréntesis balanceados |
| `npm run package` fallaba: `electron-builder` recompilaba `node-pty` con `node-gyp` | Al empaquetar por primera vez | `npmRebuild: false`; el módulo ya degrada solo y el proyecto promete builds sin `node-gyp` |
| `test.describe()` de Playwright no se detectaba | Prueba del localizador de bloques | El guardia contra `mock.test(` rechazaba todo lo cualificado; ahora se acepta si quien cualifica es un global del framework |
| La suite entera dejó de arrancar al cablear el vault | `npm test` | Import de `electron` en un módulo que las pruebas cargan; se invirtió a inyección (ADR-008) |
| Carga de trama CDP alterada tras el siguiente fragmento | Prueba del codec WebSocket | `subarray` comparte memoria con el buffer acumulado; ahora se copia |
| `localeCompare` hacía depender del idioma el orden de símbolos | Prueba de `importedSymbols` | Orden por punto de código |
| El proveedor de code lens no refrescaba | Typecheck | `onDidChange` emite el propio proveedor, no `void` |
| `scopes()` consultaba una API inexistente | Revisión antes del typecheck | La cadena de ámbitos solo viaja con `Debugger.paused`; se captura ahí |

---

## Historial de construcción

Todo el desarrollo ocurrió el **2026-08-28**, en commits atómicos por módulo.

| Commit | Hito |
| --- | --- |
| `4d26339`–`e3d78e8` | Base: repositorio, `package.json`, TypeScript estricto |
| `a634db7` | Contratos IPC compartidos y superficie `window.forge` |
| `cdb8624` | Proceso principal, preload seguro y shell del renderer |
| `9272032` | Sistema de archivos con guardián y explorador |
| `1377ce8` | Motor DotForge, toolchain y gestor de procesos |
| `143abc3` | Git con parser porcelain v2 y visor de diferencias |
| `c5b1606` | LSP multi-lenguaje y adaptadores de Monaco |
| `4a8c165` | Forge AI con streaming, RAG y vista previa |
| `eac3c5c` | Terminal PTY opcional con degradación |
| `56c80a1` | HTTP, Docker, esquemas, métricas y actualizador |
| `2255ed6` | Generador y asistente visual |
| `b829b65` | CLI headless, preferencias y panel de problemas |
| `144c689` | README |
| `385e3c8` | Corrección del paquete de Tailwind LS |
| `1b840e0` | **Electron 44**, esbuild 0.28, electron-builder 26 |
| `95b4a06` | **Sistema de diálogos** y tres fallos de uso |
| `8d2a6f7` | **Variantes arquitectónicas** del generador |
| `b862b29`, `19ea557` | `CLAUDE.md` y `AGENTS.md` |
| `eccaee2` | `PROJECT_DEVLOG.md` |
| `c5f2624` | **Depurador CDP** y puntos de interrupción en Monaco |
| `ff5867f` | **OpenAPI**: visor, generador y auditor de rupturas |
| `1d9feed` | **Pruebas**: code lens, ejecutor y cobertura |
| `14def29` | **Forge Vault** y guardias de arquitectura |
| `aff9abe` | **Motor de plugins** declarativo |

---

## Trabajo pendiente

Sin verificar en ejecución real, por requerir credenciales o servicios:

- **Streaming de IA** — necesita claves API de Anthropic u OpenAI.
- **Control de Docker** — necesita el demonio en marcha.
- **Actualizador** — solo funciona con la app empaquetada y firmada.
- **Sesión de depuración completa** — el codec, el descubrimiento de
  destinos y los analizadores están cubiertos por pruebas, pero conectar
  contra un `node --inspect` real no se ha ejercitado en esta máquina.
- **Ejecutores de pruebas** — los analizadores de informe se prueban con
  muestras reales de cada formato; falta correr Vitest y Playwright de
  verdad sobre un proyecto que los tenga instalados.
- **`safeStorage` del vault** — exige el proceso de Electron arrancado, así
  que las pruebas cubren la validación y la reescritura de `.env`, no el
  cifrado en sí.

Decisiones abiertas:

- `node-pty` sigue sin compilar **a propósito**: la terminal arranca en modo
  degradado (shell por tuberías, sin TTY) y lo avisa en su pestaña. Es lo que
  sostiene la promesa de builds reproducibles sin `node-gyp`.
- Ubicación del cliente del ORM en la variante por capas (ver ADR-001).
