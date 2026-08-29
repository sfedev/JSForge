# AGENTS.md — Manual de agentes autónomos

Reglas y límites para modificar **ForgeJS IDE** sin supervisión humana en cada
paso. Si algo aquí choca con lo que parece razonable en el momento, gana esto:
cada regla existe porque un fallo concreto la hizo necesaria.

> Convenciones y comandos: [`CLAUDE.md`](CLAUDE.md).
> Historial y decisiones: [`PROJECT_DEVLOG.md`](PROJECT_DEVLOG.md).

---

## Protocolo de validación

**Ninguna tarea está terminada hasta que estos dos pasan.** No basta con que
compile: la mayoría de los fallos de este proyecto han sido de tiempo de
ejecución, invisibles al compilador.

```bash
npm run typecheck
```

```bash
npm test
```

Estado de referencia: **329 pruebas, 0 fallos.** Si tu cambio deja alguna en
rojo, o el número baja sin que hayas borrado pruebas a propósito, el trabajo
no está hecho.

### Cuándo hace falta más

| Si tocas… | Añade |
| --- | --- |
| `src/main/**` | `npm run build` y arrancar la app para comprobar que no hay canal IPC huérfano ni error en consola. |
| `src/renderer/views/**` | Arrancar y ejercitar la vista. Un botón que no hace nada compila perfectamente. |
| `src/shared/contracts.ts` | Verificar los cuatro puntos del contrato (contrato → API → preload → handler). |
| Plantillas del generador | `npm test` cubre las reglas, pero genera un proyecto real y mira el árbol. |
| Dependencias | `npm audit`. El objetivo es **0 vulnerabilidades**; hoy se cumple. |

Verificar el arranque de verdad, no asumirlo:

```bash
npm run build && npm start
```

La app debe abrir, no imprimir errores y **cerrar limpiamente**. Al arrancar
en desarrollo avisa por consola de cualquier canal declarado en `IPC` sin
manejador; esa lista debe estar vacía.

---

## Pruebas de guardia estática

`tests/renderer-apis.test.ts` contiene **seis guardias** que deben permanecer
verdes. No son estilo: cada una corresponde a un fallo real que llegó a la
aplicación en funcionamiento.

| Guardia | Qué prohíbe | Por qué |
| --- | --- | --- |
| 1 | `window.prompt(...)` en el renderer | **Electron no lo implementa.** Lanza `prompt() is not supported`. Rompió crear archivo, renombrar, cambiar de rama y guardar la clave de IA. |
| 2 | `window.confirm(...)` y `window.alert(...)` | Bloquean el hilo del renderer y muestran un cuadro del sistema ajeno al tema. |
| 3 | `navigator.clipboard` fuera de `core/dom.ts` | La promesa se rechaza si falta el permiso; ignorarla dejaba botones de copiar que no hacían nada **ni avisaban**. |
| 4 | `require(`, `process.env/platform/versions`, `from 'node:'` en el renderer | El renderer está aislado por diseño. Todo pasa por `window.forge`. |
| 5 | `workspace.pick()` en el asistente de scaffolding | Ese selector **abre la carpeta como workspace**. Elegir el destino de un proyecto nuevo te cambiaba de proyecto. Usa `pickDirectory()`. |
| 6 | Comandos invocados sin registrar | `runCommand('x')` con `x` inexistente falla en silencio salvo por un aviso. |

### Guardias de arquitectura

`tests/architecture.test.ts` añade **trece guardias** que analizan el árbol de
fuentes. Comprueban invariantes que el compilador no ve y que fallan en
ejecución.

| Guardia | Qué exige |
| --- | --- |
| 1 | `contracts.ts` no importa **nada**: se compila en los tres bundles. |
| 2 | `forge-api.ts` solo importa tipos de `contracts`. |
| 3 | Los módulos analizables no arrastran `electron` **ni transitivamente**. |
| 4 | Todo canal declarado en `IPC` tiene manejador registrado. |
| 5 | Todo canal declarado tiene envoltorio en el preload. |
| 6 | `contextBridge` solo publica el objeto `api`, jamás `ipcRenderer`. |
| 7 | El preload usa `IPC.<CANAL>`, nunca una cadena literal. |
| 8 | El renderer no importa módulos de `main/`. |
| 9 | El renderer no importa `electron` ni `node:*`. |
| 10 | Los manejadores usan `handle()` del registro, no `ipcMain` directamente. |
| 11 | Los servicios etiquetan sus errores de dominio con `.forge`. |
| 12 | El acceso directo a `node:fs` está acotado a una lista conocida. |
| 13 | El guardián de rutas resuelve enlaces simbólicos antes de comparar. |

La guardia 3 tiene una historia concreta: importar el almacén de secretos
desde `env-service` arrastró Electron a un módulo que la suite carga para
ejercitar el análisis de `.env`, y **la suite entera dejó de arrancar** con un
`SyntaxError` de módulo CommonJS que no decía nada del problema real. La
solución fue inyectar la dependencia (`setVaultSecretProvider`), no importarla.

La guardia distingue `import type` (que TypeScript borra y es inocuo) de un
import de valor. Si añades un módulo puro que las pruebas vayan a importar,
apúntalo en `ELECTRON_FREE`.

La guardia 12 es un **trinquete**: añadir un módulo que toque `node:fs`
directamente debe ser una decisión consciente. Lo normal es usar los
ayudantes de `fs-service`, que ya validan la ruta con el guardián.

---

## Reglas de la suite avanzada

### Depuración (`src/main/debugger/`)

- **Nunca aceptes un host que no sea del bucle local.** El inspector de Node
  no autentica: abrirlo a la red es ejecución remota de código. `isLoopbackHost()`
  se verifica dos veces a propósito.
- Toda petición CDP lleva plazo. Un inspector detenido en un `debugger` no
  responde a según qué comandos, y sin plazo la promesa queda colgada.
- Los `objectId` caducan al reanudar. Se limpian en `Debugger.resumed`.

### Contratos (`src/main/services/spec/`)

- El extractor de formas es **textual**. No lo sustituyas por cargar el
  compilador de TypeScript ni por evaluar el módulo.
- Al ampliar el detector de rupturas, mantén la distinción: lo que rompe al
  **consumidor** se marca; lo que solo rompe al productor (añadir una variante
  a una unión), no.
- Normaliza los tipos antes de compararlos o reformatear una unión larga se
  contará como ruptura en cada campo que la use.

### Pruebas (`src/main/services/testing/`)

- El informe se pide a un **archivo**, nunca a stdout.
- Los artefactos van a `node_modules/.forge/`: ya está ignorado por Git y no
  ensucia el estado del repositorio del usuario.
- Al tocar el localizador de bloques, enmascara antes lo que no es código.
  Un `it(` comentado o dentro de una cadena no es una prueba.

### Vault (`src/main/services/vault/`)

- **Si el sistema no puede cifrar, no se guarda nada.** Nunca añadas un
  respaldo en texto plano.
- Cifra primero y borra del archivo después, en ese orden.
- La reescritura conserva comentarios, orden y `export`. Hay pruebas de ida y
  vuelta valor → archivo → valor; no las debilites.

### Plugins (`src/main/services/plugins/`)

- **El manifiesto se lee, jamás se ejecuta.** Ni `eval`, ni `new Function`, ni
  `import()` del archivo, ni un proceso hijo que lo cargue.
- Ampliar lo que un plugin puede hacer significa **añadir un verbo a la unión
  `PluginAction`**, con su validación. Es deliberadamente incómodo: obliga a
  pensar en las implicaciones de cada capacidad.
- Toda acción se ejecuta con los servicios normales del IDE, que ya aplican el
  guardián de rutas y la redacción de secretos.

---

### Sustitutos obligatorios

```ts
// ✗ No
const nombre = window.prompt('Nombre:');
if (!window.confirm('¿Seguro?')) return;
void navigator.clipboard.writeText(texto);

// ✓ Sí
const nombre = await promptDialog({ title: 'Nuevo archivo', label: 'Nombre', validate });
if (!(await confirmDialog({ title: 'Eliminar', message, danger: true }))) return;
const copiado = await copyToClipboard(texto);
```

El escáner ignora las líneas de comentario, así que documentar lo prohibido no
dispara la guardia. **No lo sortees** con concatenación de cadenas ni acceso
dinámico: la guardia protege a los usuarios, no al test.

Si necesitas un tipo de diálogo nuevo, **amplía `core/dialogs.ts`**; no vuelvas
a las llamadas nativas.

---

## Reglas del generador de arquitecturas

`src/main/services/dotforge/generator/` produce proyectos. Un fallo aquí no
rompe el IDE: entrega a alguien un proyecto roto, que es peor porque tarda
más en detectarse.

### La arquitectura es dueña de `src/`

El blueprint aporta la configuración (`package.json`, `tsconfig`, `vite.config`,
Docker) y el ORM. La variante arquitectónica aporta **todo el árbol de
fuentes**. Esa división es lo que permite combinar cualquier patrón con
cualquier framework sin duplicar plantillas.

Al aplicar una arquitectura hay que **retirar antes** los archivos que
sustituye. Si no, quedan huérfanos importando módulos que ya no existen.
Ya hay una prueba que lo verifica; no la debilites.

### Dirección de las dependencias

Cada patrón impone un sentido. Las plantillas generadas deben respetarlo, y
hay pruebas que lo comprueban leyendo el código emitido:

| Patrón | Regla verificada |
| --- | --- |
| **Feature-Sliced** | `shared/` no importa de ninguna capa superior. `entities/` no importa `features/` ni `widgets/`. Orden: `app → processes → pages → widgets → features → entities → shared`. |
| **Atomic Design** | Un átomo no compone moléculas, organismos, plantillas ni páginas. Cada nivel solo usa los inferiores. |
| **Modular DDD (React)** | `modules/<dom>/domain/` no importa React, ni usa `fetch`, ni importa `../infrastructure/`. |
| **Angular Clean Standalone** | Los componentes de `ui/` no inyectan servicios: reciben por `input()` y emiten por `output()`. |
| **Angular DDD** | `features/<dom>/domain/` no importa de `@angular/*`. |
| **Hexagonal** | `domain/` no importa de ninguna otra capa **ni del framework**. `application/` no conoce Express, NestJS ni Fastify. Debe existir `domain/ports/`. |
| **Clean por capas** | El controlador no toca `repositories/`: siempre pasa por el servicio. |

### Al añadir o modificar un patrón

1. Genera un árbol **real**: al menos un archivo por capa, con imports que
   crucen en la dirección correcta. Carpetas vacías no valen.
2. Añade la comprobación de su regla de acoplamiento a
   `tests/architectures.test.ts`.
3. Comprueba que no deja residuos del patrón anterior.
4. Verifica que el manifiesto `dotforge.config.json` generado pasa
   `normalizeConfig` **sin avisos**. Esa prueba ya detectó un pipeline de Nx
   que referenciaba una tarea inexistente.
5. Todo `.json` emitido debe ser JSON válido. Hay prueba para ello.

### Paridad entre asistente y CLI

Comparten motor y **deben producir lo mismo ante la misma entrada**. Los
valores por defecto de las opciones se aplican en `generate()`, no en la
interfaz. Si los aplicas en la UI, la CLI genera de menos: ya pasó, y la CLI
omitía Docker, el ORM y el linter.

---

## Límites de la modificación autónoma

### Puedes hacer sin preguntar

- Corregir fallos con una prueba que los demuestre.
- Añadir pruebas.
- Añadir plantillas, patrones o vistas siguiendo las convenciones existentes.
- Refactorizaciones internas que no cambien contratos ni comportamiento.
- Actualizar documentación para que refleje el estado real.

### Consulta antes

- **Relajar cualquier garantía de seguridad**: tocar `webPreferences`, la CSP,
  la lista de permisos concedidos o el guardián de rutas.
- **Debilitar o borrar una prueba de guardia**, incluidas las trece de
  `tests/architecture.test.ts`.
- **Añadir un verbo a `PluginAction`**: amplía lo que un plugin puede hacer.
- **Cambiar el id de un blueprint** o la forma de `dotforge.config.json`:
  rompe proyectos ya generados.
- **Aprobar scripts de instalación** de dependencias nuevas. Solo `electron` y
  `esbuild` están aprobados, y es deliberado.
- **Saltos de versión mayor** en Electron o en el toolchain.
- **Reescribir historia de Git** ya publicada.

### No hagas nunca

- Introducir `window.prompt`, `alert` o `confirm`.
- Exponer `ipcRenderer`, `require` o `process` al renderer.
- Comparar rutas con `startsWith` en lugar de `assertInsideWorkspace()`.
- Devolver una excepción a través del IPC en vez de `Result.error`.
- Declarar `available: true` en un perfil de terminal sin comprobar que el
  binario existe. La interfaz lo ofrece y el usuario recibe un `File not
  found:` que no dice qué falta.
- Descartar en silencio una acción del usuario porque el recurso murió. Si
  una terminal ya terminó, hay que decirlo: teclear contra un hueco sin
  respuesta es el fallo más desconcertante que puede dar la aplicación.
- Evaluar configuración de un proyecto ajeno (`eval`, `new Function`, importar
  `vite.config.ts`, `.forge/plugin.ts` o `src/shared/*.ts`). Todo se lee por
  análisis textual.
- Aceptar un host que no sea del bucle local en el depurador.
- Guardar un secreto en claro cuando `safeStorage` no esté disponible.
- Registrar, devolver por IPC o incluir en el contexto de IA el valor de una
  clave API o de una variable marcada como secreta.
- Hacer `push` sin que `typecheck` y `npm test` estén en verde.

---

## Cómo informar del trabajo

Di lo que realmente pasó. Si algo quedó a medias, dilo explícitamente y por
qué; no lo omitas del resumen. Si una prueba falla y no sabes arreglarla,
repórtalo con la salida en vez de desactivarla.

Cuando una comprobación descubra un fallo real —ha pasado varias veces—,
menciónalo: es información útil, no un demérito.
