/** Pruebas del parser tolerante y de la normalizacion del manifiesto DotForge. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../src/main/services/dotforge/config-service.js';
import {
  parseJsonTolerant,
  stripJsonComments,
  stripTrailingCommas,
} from '../src/main/services/toolchain/json-tolerant.js';
import { parseBundlerConfig } from '../src/main/services/toolchain/project-parsers.js';
import { parseDeclaredManager, scriptCommand } from '../src/main/services/toolchain/package-manager.js';

/* -------------------------------------------------------------------------- */
/*  JSON tolerante                                                             */
/* -------------------------------------------------------------------------- */

test('stripJsonComments respeta los comentarios dentro de cadenas', () => {
  const source = '{"url": "https://ejemplo.dev/a//b", "x": 1 /* nota */}';
  const out = stripJsonComments(source);
  assert.ok(out.includes('https://ejemplo.dev/a//b'), 'la URL no debe mutilarse');
  assert.equal(JSON.parse(out).x, 1);
});

test('stripJsonComments conserva las posiciones de linea', () => {
  const source = '{\n  // comentario\n  "a": 1\n}';
  const out = stripJsonComments(source);
  assert.equal(out.split('\n').length, source.split('\n').length);
});

test('stripTrailingCommas no toca las comas dentro de cadenas', () => {
  const source = '{"a": "uno, dos", "b": [1, 2,], }';
  const parsed = JSON.parse(stripTrailingCommas(source));
  assert.equal(parsed.a, 'uno, dos');
  assert.deepEqual(parsed.b, [1, 2]);
});

test('parseJsonTolerant acepta BOM, comentarios y comas sobrantes', () => {
  const source = `${String.fromCharCode(0xfeff)}{\n  // config\n  "strict": true,\n}`;
  const result = parseJsonTolerant<{ strict: boolean }>(source);
  assert.equal(result.value?.strict, true);
  assert.equal(result.warnings.length, 3);
});

test('parseJsonTolerant informa del error sin lanzar', () => {
  const result = parseJsonTolerant('{"a": }');
  assert.equal(result.value, null);
  assert.ok(result.error !== undefined);
  assert.ok(result.error.line >= 1);
});

/* -------------------------------------------------------------------------- */
/*  Manifiesto DotForge                                                        */
/* -------------------------------------------------------------------------- */

test('normalizeConfig acepta la forma abreviada de tarea', () => {
  const { config } = normalizeConfig({ name: 'demo', tasks: { dev: 'next dev' } }, 'fallback');
  assert.equal(config.tasks?.['dev']?.command, 'next dev');
});

test('normalizeConfig acepta la forma abreviada de pipeline', () => {
  const { config } = normalizeConfig(
    { name: 'demo', tasks: { web: 'next dev', api: 'nest start' }, pipelines: { dev: ['web', 'api'] } },
    'fallback',
  );
  assert.deepEqual(config.pipelines?.['dev']?.tasks, ['web', 'api']);
  assert.equal(config.pipelines?.['dev']?.parallel, true);
});

test('normalizeConfig avisa de tareas inexistentes referenciadas por un pipeline', () => {
  const { warnings } = normalizeConfig(
    { name: 'demo', pipelines: { dev: { tasks: ['fantasma'] } } },
    'fallback',
  );
  assert.ok(warnings.some((warning) => warning.includes('fantasma')));
});

test('normalizeConfig descarta tareas invalidas sin abortar el resto', () => {
  const { config, warnings } = normalizeConfig(
    { name: 'demo', tasks: { rota: { label: 'sin comando' }, buena: 'vite' } },
    'fallback',
  );
  assert.equal(config.tasks?.['rota'], undefined);
  assert.equal(config.tasks?.['buena']?.command, 'vite');
  assert.ok(warnings.some((warning) => warning.includes('rota')));
});

test('normalizeConfig avisa de claves desconocidas y usa el nombre de respaldo', () => {
  const { config, warnings } = normalizeConfig({ inventada: 1 }, 'mi-proyecto');
  assert.equal(config.name, 'mi-proyecto');
  assert.ok(warnings.some((warning) => warning.includes('inventada')));
});

test('normalizeConfig rechaza puertos fuera de rango', () => {
  const { config } = normalizeConfig(
    { name: 'demo', tasks: { dev: { command: 'vite', port: 99999 } } },
    'fallback',
  );
  assert.equal(config.tasks?.['dev']?.port, undefined);
});

/* -------------------------------------------------------------------------- */
/*  Toolchain                                                                  */
/* -------------------------------------------------------------------------- */

test('parseDeclaredManager entiende el formato de Corepack', () => {
  assert.equal(parseDeclaredManager('pnpm@9.1.0'), 'pnpm');
  assert.equal(parseDeclaredManager('yarn@4.0.0+sha224.abc'), 'yarn');
  assert.equal(parseDeclaredManager('deno@1.0.0'), null);
  assert.equal(parseDeclaredManager(undefined), null);
});

test('scriptCommand usa "run" en todos los gestores', () => {
  assert.deepEqual(scriptCommand('npm', 'build'), { command: 'npm', args: ['run', 'build'] });
  assert.deepEqual(scriptCommand('bun', 'build'), { command: 'bun', args: ['run', 'build'] });
});

test('parseBundlerConfig extrae puerto y plugins sin ejecutar el archivo', () => {
  const source = [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    "import path from './rutas';",
    'export default defineConfig({',
    '  plugins: [react()],',
    "  base: '/app/',",
    '  server: { port: 5180 },',
    '});',
  ].join('\n');
  const hints = parseBundlerConfig('vite.config.ts', source);
  assert.equal(hints.port, 5180);
  assert.equal(hints.base, '/app/');
  assert.deepEqual(hints.plugins, ['@vitejs/plugin-react']);
});
