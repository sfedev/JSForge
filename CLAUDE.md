# CLAUDE.md — Guía rápida para agentes

Referencia operativa de **ForgeJS IDE**: IDE de escritorio para el ecosistema
Fullstack JavaScript/TypeScript, sobre Electron + Monaco con shell propio en
HTML5/CSS3. No es un fork de Code-OSS ni de Theia.

> Complementos: [`AGENTS.md`](AGENTS.md) (reglas de guardia y límites para
> cambios autónomos) y [`PROJECT_DEVLOG.md`](PROJECT_DEVLOG.md) (historial y
> decisiones de arquitectura).

---

## Comandos frecuentes

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Compila en watch y arranca Electron. Es el bucle de trabajo normal. |
| `npm run build` | Compila los cuatro bundles con esbuild (main, preload, renderer, CLI) más los workers de Monaco. |
| `npm run build:watch` | Solo recompilación incremental, sin abrir Electron. |
| `npm start` | Ejecuta `electron .` sobre lo ya compilado en `dist/`. |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.json` en modo estricto. **Obligatorio antes de dar nada por terminado.** |
| `npm test` | Compila `tests/` con esbuild y ejecuta el runner nativo de Node. |
| `npm run clean` | Borra `dist/`, `release/` y cachés. |
| `npm run package` | `electron-builder --dir`, sin instalador. Deja `release/win-unpacked/`. |
| `npm run dist` | Genera el instalador NSIS y el ZIP en `release/`. |

El empaquetado va con `npmRebuild: false`. `electron-builder` recompila por
defecto las dependencias nativas, y eso arrastraba `node-pty` a `node-gyp`,
que es justo lo que este proyecto no exige: el módulo es opcional y degrada
solo. Sin esa opción, `npm run package` falla al empaquetar aunque la
aplicación funcione perfectamente en desarrollo.

No hay ESLint ni Prettier configurados **sobre este repositorio**: el control
de calidad es `typecheck` + la suite de pruebas. (Sí se generan para los
proyectos que crea el scaffolding; son cosas distintas.)

### CLI de DotForge

El generador de arquitecturas es el mismo motor que usa el asistente visual,
y produce exactamente lo mismo ante la misma entrada.

```bash
node dist/cli/forge.mjs list
```

```bash
node dist/cli/forge.mjs new express --dir ./mi-api --name "Mi API" --pm pnpm
```

```bash
node dist/cli/forge.mjs new react-vite --dir ./web --json '{"architecture":"feature-sliced"}' --dry-run
```

`--dry-run` calcula el plan completo de archivos sin escribir nada.
`forge generate` lee la petición completa por stdin.

---

## Estructura del proyecto

```
src/
  shared/            contratos IPC y tipos DotForge
    contracts.ts     89 canales IPC, Result<T> y todos los DTO
    forge-api.ts     interfaz exacta de window.forge
  main/              proceso principal (Node completo)
    main.ts          arranque, endurecimiento, apagado ordenado
    preload.ts       puente contextBridge  ← NO es src/preload/
    window.ts        BrowserWindow con las garantías de aislamiento
    security/        workspace-guard, CSP, protocolo forge://
    ipc/             registry (Result<T>), event-bus, handlers/
    debugger/        cliente CDP propio: ws-frame · cdp-client
                     debug-session · source-map · heap-trend
    services/        ai · db · docker · dotforge · format · git · http
                     lsp · metrics · plugins · process · spec · terminal
                     testing · toolchain · updater · vault
  renderer/          proceso aislado (sin Node)
    index.ts         arranque y montaje del shell
    shell.ts         rejilla y puntos de montaje
    core/            store · commands · keybindings · dialogs · diff
                     dom · icons · toasts · event-bridge
    views/           26 modulos: explorador, git, pipelines, terminal,
                     HTTP, métricas, problemas, depuración, contratos,
                     pruebas, entorno, Forge AI, asistente…
    monaco/          arranque, temas y lenguajes
    editor/          breakpoints (margen) y code lens de pruebas
    lsp/             adaptadores de Monaco sobre LSP
    static/          index.html y hojas de estilo
  cli/forge.ts       generador headless
scripts/             build · dev · test · clean (esbuild)
tests/               suite con el runner nativo de Node
```

**Dos correcciones frecuentes al leer el árbol:**

- El preload vive en `src/main/preload.ts`, no en `src/preload/`. Pertenece al
  proceso principal aunque se ejecute en un contexto restringido.
- `core/` es `src/renderer/core/`. No hay un `core/` en la raíz.

---

## Suite de herramientas avanzadas

Cinco módulos que comparten una misma disciplina: **nada se ejecuta que no
haya que ejecutar**, y todo lo analizable vive en funciones puras probadas
sin tocar disco.

| Módulo | Entrada | Vista |
| --- | --- | --- |
| **Depurador CDP** | Inspector de Node (`--inspect`) | `debug` (barra lateral y panel) |
| **Contratos y API** | `openapi.json` / `.yaml`, `src/shared/*.ts` | `spec` |
| **Pruebas** | Vitest · Jest · Playwright · runner de Node | `testing` + code lens |
| **Forge Vault** | `.env*` y `safeStorage` | `vault` |
| **Plugins** | `.forge/plugin.ts` | Preferencias |

### Depurador: solo el bucle local

El cliente WebSocket es propio (`ws-frame.ts` + `cdp-client.ts`) porque `ws`
arrastra binarios opcionales y el `WebSocket` global de Node no deja fijar
cabeceras ni inspeccionar el handshake.

**`isLoopbackHost()` no es negociable.** El inspector de Node no autentica:
quien puede hablar con él ejecuta código arbitrario en ese proceso. Se
verifica en el constructor del cliente y otra vez al abrir sesión.

Los puntos de interrupción los posee el **renderer**, no la sesión: se marcan
sin estar depurando y se empujan al motor en cuanto hay uno.

### Contratos: el auditor responde a otra pregunta

`spec.audit` no dice «qué ha cambiado» —eso ya lo dice el diff— sino **«esto
va a dejar de compilar en otra capa»**. Distingue lo que rompe al consumidor
(quitar un campo, añadir uno obligatorio, quitar una variante de unión) de lo
que es compatible (añadir un campo opcional, añadir una variante).

El extractor de formas es **textual**. Evaluar `src/shared/*.ts` sería
ejecutar código del proyecto en el proceso principal.

### Pruebas: el informe va a un archivo

Los runners mezclan avisos, trazas y barras de progreso con el JSON. Se pide
siempre con `--outputFile` a `node_modules/.forge/`, ya ignorado por Git en
cualquier proyecto de JavaScript.

Un archivo que **no se pudo cargar** cuenta como fallo, no como cero pruebas:
un error de importación parecería un éxito silencioso.

### Vault: cifrar o no guardar

Igual que las claves de IA. Si `safeStorage` no está disponible **no se
escribe nada**: dejarlo en claro sería peor, el usuario creería que está
protegido.

Al promover una variable se cifra primero y se borra del archivo después. Al
revés, un fallo al guardar dejaría el valor perdido.

La escritura conserva **comentarios, orden y `export`**: en un `.env` los
comentarios son la única documentación de cada clave.

### Plugins: el manifiesto se lee, nunca se ejecuta

`.forge/plugin.ts` es un manifiesto **declarativo**. Se analiza con
`object-literal.ts`, que acepta datos y rechaza —con la línea exacta— todo lo
que exigiría evaluar: variables, llamadas, interpolaciones.

Las acciones son verbos cerrados (`shell`, `command`, `write`, `open`) que el
IDE ya sabe hacer y ejecuta con sus servicios de siempre, con las mismas
restricciones. **Un plugin no puede hacer nada que el usuario no pudiera
hacer desde la interfaz.**

La contrapartida es explícita: no admite lógica arbitraria. Para eso está un
script de npm, que el plugin puede invocar con `task: 'shell'`.

---

## Guía de estilo y convenciones

### TypeScript

Modo estricto real, no nominal. En `tsconfig.json` están activos
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`,
`noUnusedParameters`, `useUnknownInCatchVariables` y
`noFallthroughCasesInSwitch`. El código nuevo debe compilar sin relajarlos.

- Nada de `any`. En los límites no tipados, `unknown` y estrechar.
- Los imports internos llevan extensión `.js` (exigencia de TypeScript en modo
  ESM), aunque el archivo fuente sea `.ts`.
- Campos privados de clase con `#`, no con `private`.
- Comentarios en español, explicando **por qué**, no qué.

### Contratos IPC

`src/shared/contracts.ts` es la **única fuente de verdad**. No importa nada de
`electron` ni de `node:*`, porque se compila en los tres bundles.

Para añadir una operación hay que tocar cuatro sitios, en este orden:

1. `contracts.ts` — el canal en `IPC` y sus tipos.
2. `forge-api.ts` — el método en la interfaz de `window.forge`.
3. `main/preload.ts` — el envoltorio, con el canal **literal**.
4. `main/ipc/handlers/` — el manejador, registrado con `handle()`.

Reglas que el registro impone y no hay que sortear:

- Todo manejador devuelve `Result<T>`. **Ninguna excepción cruza el IPC**: se
  convierte en `Result.error` con su código semántico.
- Los errores de dominio se etiquetan con `.forge` para conservar el código
  (`E_CONFLICT`, `E_BINARY`, `E_OUTSIDE_WORKSPACE`…).
- Un canal declarado en `IPC` sin manejador se avisa por consola al arrancar
  en desarrollo.

### Diálogos: prohibición absoluta de llamadas bloqueantes

**Electron no implementa `window.prompt()`.** Llamarlo lanza
`prompt() is not supported` y rompe la acción en tiempo de ejecución, no al
compilar. `window.confirm()` y `window.alert()` sí funcionan, pero bloquean el
hilo del renderer y muestran un cuadro del sistema ajeno al tema.

Usa siempre `src/renderer/core/dialogs.ts`:

| En lugar de | Usa |
| --- | --- |
| `window.prompt(...)` | `await promptDialog({ title, label, validate })` |
| `window.confirm(...)` | `await confirmDialog({ title, message, danger })` |
| Un prompt que lista opciones | `await selectDialog({ title, items })` — filtrable |

Los tres son asíncronos, resuelven `null`/`false` al cancelar, cierran con
`Escape`, confirman con `Enter` y devuelven el foco a donde estaba.
`promptDialog` admite `validate` para dar el error dentro del propio modal.

Una prueba de guardia bloquea la reintroducción de las tres llamadas.

### Portapapeles

`navigator.clipboard` rechaza la promesa si el permiso está denegado o el
documento no tiene foco. Usa `copyToClipboard()` de `core/dom.ts`, que
devuelve `boolean`, para poder avisar en lugar de fallar en silencio.

### Seguridad en Electron

Garantías no negociables, verificadas por pruebas o por revisión:

- **Renderer aislado**: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, sin `webview`. El renderer **no** puede usar `require`,
  `process` ni `node:*`; hay una prueba de guardia que lo comprueba.
- **Preload estricto**: expone solo funciones concretas. Nunca `ipcRenderer`.
  El renderer no puede elegir el nombre de un canal.
- **CSP**: `default-src 'none'`, `script-src 'self'`, sin `eval` ni orígenes
  remotos. La UI se sirve por `forge://app`, un esquema privilegiado propio,
  para que `'self'` tenga un origen real.
- **Permisos del navegador**: todos denegados salvo
  `clipboard-sanitized-write`, que los botones de copiar necesitan.
- **Guardián de rutas**: toda ruta del renderer pasa por
  `assertInsideWorkspace()`, que rechaza rutas absolutas, UNC, `..`, bytes
  nulos y nombres reservados de Windows, y **resuelve los enlaces simbólicos
  antes de comparar**. Nunca compares rutas con `startsWith` sobre cadenas.
- **Secretos**: las claves API se cifran con `safeStorage`. Si el sistema no
  puede cifrar, **no se guarda nada en claro**. Los valores `.env` se
  enmascaran antes de cruzar el IPC y se redactan de la salida de procesos.
- **Nunca ejecutar código ajeno**: `vite.config.ts` y `next.config.js` se leen
  por análisis textual, jamás se evalúan.

### Dependencias nativas

`node-pty`, `electron-updater` y los servidores de lenguaje son **opcionales a
propósito**. Se cargan con `require` dinámico dentro de `try`/`catch` y
degradan con aviso visible. Exigir `node-gyp` rompería la promesa de builds
reproducibles. Solo `electron` y `esbuild` tienen scripts de instalación
aprobados en `package.json`.

### Mensajes de Git

Conventional Commits, en español, con cuerpo que explique el porqué:

```
feat(scaffold): patron de arquitectura elegible por tecnologia
fix(ui): sustituye los dialogos del navegador
chore(deps): sube Electron a 44
docs: create CLAUDE.md
```

Ámbitos en uso: `base`, `core`, `shared`, `fs`, `dotforge`, `git`, `lsp`,
`ai`, `terminal`, `tools`, `scaffold`, `cli`, `ui`, `deps`, `docs`.

Un commit atómico por unidad de cambio. Si el mensaje no describe todo lo que
lleva el commit, el commit está mal partido.

---

## Estado actual

| | |
| --- | --- |
| Electron | 44 (Node 24, Chromium 152) |
| esbuild | 0.28 · electron-builder 26 · TypeScript 5.7 |
| `npm audit` | 0 vulnerabilidades |
| Pruebas | 329, todas en verde |
| Canales IPC | 128 |
| Blueprints | 11, con patrón de arquitectura elegible |
| Servidores LSP | 6 (TypeScript, HTML, CSS, JSON, Volar, Tailwind) |
| Proveedores de IA | 3 (Anthropic, OpenAI, Ollama) |
| Ejecutores de pruebas | 4 (Vitest, Jest, Playwright, runner de Node) |
| Objetivos de generación OpenAPI | 4 (tipos, cliente, hooks React, composables Vue) |
