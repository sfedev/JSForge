/**
 * Ejecutor de pruebas.
 *
 * Los modulos de `src/` importan con extension `.js` (lo que exige TypeScript
 * en modo ESM), y el desmontado de tipos de Node no reescribe esa extension.
 * Por eso las pruebas se compilan antes con esbuild —el mismo empaquetador
 * que usa la aplicacion— y se ejecutan con el runner nativo de Node.
 */

import { build } from 'esbuild';
import { readdir, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const OUT_DIR = path.join(ROOT, 'dist', 'tests');

async function collect(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collect(full)));
    } else if (entry.name.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

const entryPoints = await collect(TESTS_DIR);
if (entryPoints.length === 0) {
  console.log('[test] no se encontro ninguna prueba.');
  process.exit(0);
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

await build({
  entryPoints,
  outdir: OUT_DIR,
  outbase: TESTS_DIR,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24.18',
  sourcemap: 'inline',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  // `electron` solo aparece en modulos que las pruebas no ejercitan; se deja
  // como externo para no arrastrar el binario al bundle de test.
  external: ['electron'],
});

// Se pasan los archivos uno a uno: `node --test <dir>` intenta cargar el
// directorio como si fuera un modulo.
const compiled = entryPoints.map((entry) =>
  path.join(OUT_DIR, path.relative(TESTS_DIR, entry).replace(/\.ts$/, '.mjs')),
);

const child = spawn(process.execPath, ['--test', ...compiled], {
  cwd: ROOT,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
