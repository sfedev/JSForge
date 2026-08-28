/**
 * Guardia estatica sobre las APIs del renderer.
 *
 * Electron no implementa `window.prompt()`, y `alert`/`confirm` bloquean el
 * hilo con un cuadro del sistema que ignora el tema del IDE. Esta prueba
 * existe porque los tres se colaron una vez y el fallo solo aparecia al
 * pulsar el boton en la app ya empaquetada.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Se ancla al directorio del proyecto, no a `import.meta.url`: las pruebas
// se ejecutan ya empaquetadas en `dist/tests`, asi que una ruta relativa al
// modulo apuntaria a `dist/src`.
const RENDERER = path.resolve(process.cwd(), 'src', 'renderer');

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Descarta las lineas de comentario.
 *
 * `core/dialogs.ts` documenta en su cabecera justo lo que sustituye, asi que
 * sin esto se delataria a si mismo. Solo interesan las llamadas reales.
 */
function withoutComments(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

const FILES = sourceFiles(RENDERER).map((file) => ({
  path: path.relative(RENDERER, file).split(path.sep).join('/'),
  source: withoutComments(readFileSync(file, 'utf8')),
}));

test('el renderer no usa window.prompt: Electron no lo implementa', () => {
  const offenders = FILES.filter((file) => /\bwindow\.prompt\s*\(/.test(file.source));
  assert.deepEqual(
    offenders.map((file) => file.path),
    [],
    'usa promptDialog() de core/dialogs.ts en su lugar',
  );
});

test('el renderer no usa window.confirm ni window.alert', () => {
  const offenders = FILES.filter((file) =>
    /\bwindow\.(confirm|alert)\s*\(/.test(file.source),
  );
  assert.deepEqual(
    offenders.map((file) => file.path),
    [],
    'usa confirmDialog() de core/dialogs.ts en su lugar',
  );
});

test('el portapapeles pasa por el ayudante que informa del fallo', () => {
  // `navigator.clipboard` rechaza en silencio si el permiso esta denegado.
  const offenders = FILES.filter(
    (file) => file.path !== 'core/dom.ts' && /navigator\.clipboard/.test(file.source),
  );
  assert.deepEqual(
    offenders.map((file) => file.path),
    [],
    'usa copyToClipboard() de core/dom.ts en su lugar',
  );
});

test('el renderer no toca Node ni require', () => {
  const offenders = FILES.filter((file) =>
    /\brequire\s*\(|\bprocess\.(env|platform|versions)\b|from 'node:/.test(file.source),
  );
  assert.deepEqual(
    offenders.map((file) => file.path),
    [],
    'el renderer esta aislado: todo pasa por window.forge',
  );
});

test('elegir carpeta destino no reutiliza el selector que abre workspace', () => {
  const wizard = FILES.find((file) => file.path === 'views/scaffold-wizard.ts');
  assert.ok(wizard !== undefined);
  assert.equal(
    /workspace\.pick\(\)/.test(wizard.source),
    false,
    'workspace.pick() abre la carpeta como workspace; usa pickDirectory()',
  );
  assert.ok(/pickDirectory\(/.test(wizard.source));
});

test('todo comando invocado esta registrado', () => {
  const invoked = new Map<string, string[]>();
  const defined = new Set<string>();

  for (const file of FILES) {
    for (const match of file.source.matchAll(/runCommand\(\s*'([^']+)'/g)) {
      const id = match[1] ?? '';
      const list = invoked.get(id) ?? [];
      list.push(file.path);
      invoked.set(id, list);
    }
    for (const match of file.source.matchAll(/^\s*id:\s*'([^']+)',\s*$/gm)) {
      defined.add(match[1] ?? '');
    }
  }
  // Los comandos de vista se generan a partir de las listas del shell.
  for (const view of ['explorer', 'search', 'git', 'pipelines', 'services', 'http', 'metrics']) {
    defined.add(`sidebar.${view}`);
  }
  for (const view of ['output', 'terminal', 'problems', 'http', 'metrics']) {
    defined.add(`panel.${view}`);
  }

  const missing = [...invoked.keys()].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `comandos invocados sin registrar: ${missing.join(', ')}`);
});
