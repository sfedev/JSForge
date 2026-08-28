/**
 * Arranque de desarrollo: compila en modo watch y lanza Electron.
 *
 * Se compila una vez de forma sincrona antes de arrancar Electron para que
 * la primera carga nunca encuentre `dist/` a medias; despues el watcher
 * recompila en segundo plano.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function run(command, args, options = {}) {
  return spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
}

function once(child) {
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on('error', reject);
  });
}

await once(run(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), '--dev']));

const watcher = run(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), '--watch']);

let electronBinary;
try {
  electronBinary = require('electron');
} catch {
  console.error('[dev] Electron no esta instalado. Ejecuta `npm install` primero.');
  watcher.kill();
  process.exit(1);
}

const electron = run(electronBinary, [ROOT], {
  env: { ...process.env, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' },
});

const stop = () => {
  watcher.kill();
  electron.kill();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
electron.on('exit', (code) => {
  watcher.kill();
  process.exit(code ?? 0);
});
