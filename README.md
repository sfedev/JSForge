# ForgeJS IDE

Entorno de desarrollo de escritorio para el ecosistema Fullstack
JavaScript/TypeScript, impulsado por el motor **DotForge**.

No es un fork de Code-OSS ni de Theia: el shell está escrito desde cero en
HTML5/CSS3 sobre Electron y Monaco. Eso es lo que permite un arranque
instantáneo, un consumo de memoria bajo y builds reproducibles sin pasadas de
compilación C++ en la máquina del usuario.

---

## Qué trae

| Área | Qué hace |
| --- | --- |
| **Motor DotForge** | `dotforge.config.json` como fuente de verdad de tareas, pipelines, entornos y servicios. Si el proyecto no tiene manifiesto, se infiere uno desde `package.json` y funciona igual. |
| **Scaffolding** | 12 arquitecturas listas (React, Next, Vue, Angular, SvelteKit, Express hexagonal, NestJS, Fastify, Next fullstack, Turborepo, Nx), por asistente visual o por CLI `--json`. |
| **IntelliSense** | Cliente LSP propio sobre stdio con framing `Content-Length`: TypeScript, HTML, CSS, JSON, Volar y Tailwind. Autocompletado, hover, ir a definición, referencias, renombrado, acciones de código, pistas en línea y tokens semánticos. |
| **Pipelines** | Selector de inicio multiproceso con un canal de salida por proceso, puerto detectado, hipervínculo a `localhost` y estado en vivo. |
| **Registros** | Parser de Pino, Bunyan, Winston, Morgan y DotForge CLI, con trazas de pila clicables y freno de refresco configurable. |
| **Forge AI** | Anthropic, OpenAI y Ollama sobre HTTP puro, con claves cifradas por el sistema operativo, contexto RAG del proyecto y edición en línea con vista previa de diferencias. |
| **Git** | Parser propio de `git status --porcelain=v2`, preparado por archivo, enmiendas, ramas y visor lado a lado. |
| **Terminal** | xterm.js sobre PTY, con degradación tolerante si `node-pty` no está instalado y sugerencias con los scripts reales del proyecto. |
| **HTTP y datos** | Cliente `.http`/`.rest`, lente "Probar endpoint" sobre Express/NestJS/Fastify/Next, control de `docker-compose` e inspector de esquemas Prisma, TypeORM y Drizzle. |
| **Métricas** | CPU y memoria por proceso de Node, sin dependencias nativas. |
| **Actualizaciones** | `electron-updater` o cliente propio contra un feed JSON, con verificación SHA-256 y visor de notas de versión. |

---

## Puesta en marcha

```bash
npm install
npm run dev
```

`npm run dev` compila en modo watch y abre Electron. Para una compilación de
producción:

```bash
npm run build
npm start
```

### Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Compila en watch y arranca Electron. |
| `npm run build` | Compila los cuatro bundles con esbuild. |
| `npm run typecheck` | `tsc --noEmit` en modo estricto. |
| `npm test` | Compila las pruebas con esbuild y las ejecuta con el runner de Node. |
| `npm run package` | Empaqueta sin instalador (`electron-builder --dir`). |
| `npm run dist` | Genera los instaladores. |
| `npm run forge` | CLI del generador de arquitecturas. |

---

## Generador por línea de comandos

El asistente visual y la CLI comparten el mismo motor, así que producen
exactamente lo mismo ante la misma entrada.

```bash
node dist/cli/forge.mjs list
```

```bash
node dist/cli/forge.mjs new express-hexagonal --dir ./mi-api --name "Mi API" --pm pnpm
```

```bash
node dist/cli/forge.mjs new react-vite --dir ./web --json '{"styling":"tailwind","docker":false}' --dry-run
```

`--dry-run` calcula el plan completo de archivos sin escribir nada.

---

## Arquitectura

```
src/
  shared/          contratos IPC y tipos DotForge (sin electron ni node)
  main/
    main.ts        arranque, endurecimiento y apagado ordenado
    preload.ts     puente contextBridge, sin ipcRenderer
    security/      guardián de rutas, CSP y protocolo forge://
    ipc/           registro de canales y bus de eventos
    services/      dotforge, toolchain, procesos, git, lsp, ai, terminal,
                   http, docker, db, métricas, actualizador
  renderer/
    core/          store observable, comandos, atajos, diff
    views/         explorador, búsqueda, git, pipelines, servicios, HTTP,
                   métricas, salida, terminal, problemas, Forge AI
    monaco/        arranque, temas y lenguajes
    lsp/           adaptadores de Monaco sobre LSP
  cli/             generador headless
scripts/           build, dev, test y limpieza con esbuild
tests/             pruebas con el runner nativo de Node
```

### Seguridad

Las garantías no son configurables ni se relajan en desarrollo:

- **Renderer aislado**: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, sin `webview` y sin permisos de navegador.
- **Preload estricto**: expone `window.forge` con funciones concretas. Nunca
  expone `ipcRenderer`, `require` ni `process`; el renderer no puede elegir el
  nombre de un canal.
- **CSP sin escapatorias**: `default-src 'none'`, `script-src 'self'`, sin
  `eval`, sin orígenes remotos. La UI se sirve por `forge://app`, un esquema
  privilegiado propio, para que `'self'` signifique algo real.
- **Guardián de rutas**: toda ruta que llega del renderer pasa por
  `assertInsideWorkspace`, que rechaza rutas absolutas, UNC, `..`, bytes nulos
  y nombres reservados, y resuelve los enlaces simbólicos antes de comparar.
  Un symlink que apunte fuera del workspace queda bloqueado.
- **Secretos**: las claves API se cifran con `safeStorage` (DPAPI, Llavero).
  Si el sistema no puede cifrar, no se guarda nada en claro. Los valores de
  `.env` se enmascaran antes de cruzar el IPC y se redactan de la salida de
  los procesos.
- **Sin ejecución de código ajeno**: `vite.config.ts` y `next.config.js` se
  leen por análisis textual, nunca se evalúan.

### Dependencias nativas

`node-pty` es **opcional a propósito**: exigir `node-gyp` y las Build Tools de
Visual Studio rompería la promesa de builds reproducibles. Se carga con
`require` dinámico y, si no está, la terminal cae a un shell por tuberías
avisando en la interfaz. Lo mismo con `electron-updater` y con los servidores
de lenguaje: su ausencia degrada la funcionalidad, nunca impide arrancar.

Por eso `package.json` aprueba scripts de instalación solo para `electron` y
`esbuild`.

---

## Manifiesto DotForge

```jsonc
{
  "$schema": "https://dotforge.dev/schema/dotforge.config.json",
  "name": "mi-proyecto",
  "packageManager": "pnpm",
  "tasks": {
    "web": { "label": "Interfaz", "script": "dev", "port": 5173, "watch": true },
    "api": {
      "label": "API",
      "command": "nest start --watch",
      "port": 3000,
      "readyPattern": "Nest application successfully started",
      "logFormat": "pino"
    }
  },
  "pipelines": {
    "dev": { "label": "Dev completo", "tasks": ["web", "api"], "parallel": true }
  },
  "environments": {
    "local": { "envFiles": [".env"], "secrets": ["DATABASE_URL"] }
  },
  "services": [
    { "name": "db", "kind": "postgres", "composeFile": "docker-compose.yml", "composeService": "db" }
  ]
}
```

El parser es tolerante: admite formas abreviadas (`"dev": "next dev"`,
`"dev": ["web", "api"]`), comentarios y comas sobrantes, y convierte las claves
desconocidas en avisos en lugar de fallar.

---

## Atajos

| Atajo | Acción |
| --- | --- |
| `Ctrl+Shift+P` | Paleta de comandos |
| `Ctrl+P` | Ir al archivo |
| `Ctrl+B` / `Ctrl+J` | Alternar barra lateral / panel |
| `Ctrl+I` | Forge AI en línea sobre la selección |
| `Ctrl+Shift+I` | Alternar el panel de Forge AI |
| `F5` / `Shift+F5` | Ejecutar / detener el pipeline principal |
| `` Ctrl+` `` | Terminal |
| `Ctrl+K Ctrl+O` | Abrir carpeta |
| `Ctrl+K Ctrl+T` | Cambiar de tema |

---

## Licencia

MIT.
