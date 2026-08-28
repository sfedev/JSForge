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

Estado de referencia: **119 pruebas, 0 fallos.** Si tu cambio deja alguna en
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
- **Debilitar o borrar una prueba de guardia.**
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
- Evaluar configuración de un proyecto ajeno (`eval`, `new Function`, importar
  `vite.config.ts`). Se lee por análisis textual.
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
