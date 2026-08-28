/**
 * Compilacion de ForgeJS IDE con esbuild.
 *
 * Tres bundles independientes:
 *  - `main`    -> dist/main/main.js      (CJS, target del Node de Electron)
 *  - `preload` -> dist/main/preload.js   (CJS, contexto sandboxed)
 *  - `renderer`-> dist/renderer/index.js (ESM, navegador)
 *
 * Monaco se empaqueta desde node_modules dentro del bundle del renderer y
 * sus workers se compilan como entradas separadas, de modo que no hace falta
 * ninguna descarga remota ni `eval` en tiempo de ejecucion.
 *
 * Uso:
 *   node scripts/build.mjs            compilacion de produccion
 *   node scripts/build.mjs --watch    recompilacion incremental
 *   node scripts/build.mjs --dev      sourcemaps y sin minificar
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');

const argv = new Set(process.argv.slice(2));
const WATCH = argv.has('--watch');
const DEV = WATCH || argv.has('--dev');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

/** Node que embarca Electron 33. Evita transpilar de mas. */
const NODE_TARGET = 'node20.18';
/** Chromium que embarca Electron 33. */
const BROWSER_TARGET = 'chrome130';

const define = {
  'process.env.NODE_ENV': JSON.stringify(DEV ? 'development' : 'production'),
  __FORGE_VERSION__: JSON.stringify(pkg.version),
};

const shared = {
  bundle: true,
  sourcemap: DEV ? 'inline' : 'linked',
  minify: !DEV,
  logLevel: 'info',
  legalComments: 'none',
  define,
};

/**
 * Modulos que deben resolverse en tiempo de ejecucion y no empaquetarse.
 * `node-pty` y los servidores de lenguaje son opcionales: si no estan
 * instalados, el codigo que los carga degrada con elegancia.
 */
const MAIN_EXTERNAL = [
  'electron',
  'electron-updater',
  'node-pty',
  'prettier',
  '@biomejs/biome',
];

const mainConfig = {
  ...shared,
  entryPoints: { main: path.join(SRC, 'main', 'main.ts') },
  outdir: path.join(DIST, 'main'),
  platform: 'node',
  format: 'cjs',
  target: NODE_TARGET,
  external: MAIN_EXTERNAL,
  // El main arranca antes que nada: mantenerlo pequeno es lo que da el
  // inicio instantaneo, asi que los servicios pesados se cargan bajo demanda.
  treeShaking: true,
};

const preloadConfig = {
  ...shared,
  entryPoints: { preload: path.join(SRC, 'main', 'preload.ts') },
  outdir: path.join(DIST, 'main'),
  platform: 'node',
  format: 'cjs',
  target: NODE_TARGET,
  external: ['electron'],
};

const rendererConfig = {
  ...shared,
  entryPoints: { index: path.join(SRC, 'renderer', 'index.ts') },
  outdir: path.join(DIST, 'renderer'),
  platform: 'browser',
  format: 'esm',
  target: BROWSER_TARGET,
  splitting: false,
  loader: {
    '.ttf': 'file',
    '.woff2': 'file',
    '.svg': 'text',
  },
  // El renderer esta aislado: no puede tocar Node ni aunque lo intente.
  external: ['electron', 'node:*'],
};

/** Workers de Monaco: cada uno es un bundle IIFE clasico. */
const MONACO_WORKERS = [
  ['editor.worker', 'monaco-editor/esm/vs/editor/editor.worker.js'],
  ['ts.worker', 'monaco-editor/esm/vs/language/typescript/ts.worker.js'],
  ['json.worker', 'monaco-editor/esm/vs/language/json/json.worker.js'],
  ['css.worker', 'monaco-editor/esm/vs/language/css/css.worker.js'],
  ['html.worker', 'monaco-editor/esm/vs/language/html/html.worker.js'],
];

function monacoWorkerConfigs() {
  const configs = [];
  for (const [name, request] of MONACO_WORKERS) {
    const entry = path.join(ROOT, 'node_modules', request);
    if (!existsSync(entry)) {
      continue;
    }
    configs.push({
      ...shared,
      entryPoints: { [name]: entry },
      outdir: path.join(DIST, 'renderer', 'workers'),
      platform: 'browser',
      format: 'iife',
      target: BROWSER_TARGET,
    });
  }
  return configs;
}

/** Copia los recursos estaticos del renderer (HTML, CSS, iconos). */
async function copyStatic() {
  const staticDir = path.join(SRC, 'renderer', 'static');
  const outDir = path.join(DIST, 'renderer');
  await mkdir(outDir, { recursive: true });
  if (existsSync(staticDir)) {
    await cp(staticDir, outDir, { recursive: true });
  }
  // Sello de compilacion util para diagnosticar builds reproducibles.
  await writeFile(
    path.join(DIST, 'build-info.json'),
    `${JSON.stringify(
      { version: pkg.version, mode: DEV ? 'development' : 'production', target: { NODE_TARGET, BROWSER_TARGET } },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function run() {
  const started = Date.now();

  if (!WATCH) {
    await rm(DIST, { recursive: true, force: true });
  }
  await mkdir(DIST, { recursive: true });

  const configs = [mainConfig, preloadConfig, rendererConfig, ...monacoWorkerConfigs()];

  if (WATCH) {
    const contexts = await Promise.all(configs.map((config) => context(config)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    await copyStatic();
    console.log('[build] modo watch activo. Ctrl+C para salir.');
    // Mantiene vivo el proceso.
    await new Promise(() => {});
    return;
  }

  await Promise.all(configs.map((config) => build(config)));
  await copyStatic();
  console.log(`[build] completado en ${Date.now() - started} ms (${DEV ? 'dev' : 'prod'}).`);
}

run().catch((cause) => {
  console.error('[build] fallo la compilacion');
  console.error(cause);
  process.exitCode = 1;
});
