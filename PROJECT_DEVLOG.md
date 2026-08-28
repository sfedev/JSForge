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
| Pruebas | **119, todas en verde** |
| Código | ~29 000 líneas de TypeScript en `src/` |
| Canales IPC | 89 |
| Commits | 22 |

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

---

## Trabajo pendiente

Sin verificar en ejecución real, por requerir credenciales o servicios:

- **Streaming de IA** — necesita claves API de Anthropic u OpenAI.
- **Control de Docker** — necesita el demonio en marcha.
- **Actualizador** — solo funciona con la app empaquetada y firmada.

Decisiones abiertas:

- `node-pty` sigue sin compilar **a propósito**: la terminal arranca en modo
  degradado (shell por tuberías, sin TTY) y lo avisa en su pestaña. Es lo que
  sostiene la promesa de builds reproducibles sin `node-gyp`.
- Ubicación del cliente del ORM en la variante por capas (ver ADR-001).
