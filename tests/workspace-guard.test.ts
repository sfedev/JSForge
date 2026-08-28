/**
 * Pruebas del guardian de rutas.
 *
 * Es la frontera de seguridad mas importante del IDE: si esto cede, el
 * renderer puede leer y escribir cualquier archivo de la maquina.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertInsideWorkspace,
  isInside,
  normalizeRelative,
  resolveWorkspaceRoot,
  toRelative,
  WorkspaceGuardError,
} from '../src/main/security/workspace-guard.js';

const root = resolveWorkspaceRoot(mkdtempSync(path.join(tmpdir(), 'forge-guard-')));
mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
writeFileSync(path.join(root, 'src', 'core', 'index.ts'), 'export {};\n');

const outside = resolveWorkspaceRoot(mkdtempSync(path.join(tmpdir(), 'forge-outside-')));
writeFileSync(path.join(outside, 'secreto.txt'), 'no deberia leerse\n');

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('normalizeRelative canoniza separadores y segmentos redundantes', () => {
  assert.equal(normalizeRelative('src\\core\\index.ts'), 'src/core/index.ts');
  assert.equal(normalizeRelative('./src//core/./index.ts'), 'src/core/index.ts');
  assert.equal(normalizeRelative('src/core/../core/index.ts'), 'src/core/index.ts');
  assert.equal(normalizeRelative(''), '');
  assert.equal(normalizeRelative('.'), '');
  assert.equal(normalizeRelative('/'), '');
});

test('normalizeRelative rechaza salidas del workspace', () => {
  for (const candidate of ['..', '../fuera', 'src/../../fuera', '..\\fuera']) {
    assert.throws(
      () => normalizeRelative(candidate),
      (error: unknown) =>
        error instanceof WorkspaceGuardError && error.forge.code === 'E_OUTSIDE_WORKSPACE',
      `deberia rechazar ${candidate}`,
    );
  }
});

test('normalizeRelative rechaza rutas absolutas, UNC y unidades', () => {
  for (const candidate of ['/etc/passwd', 'C:\\Windows\\System32', '\\\\servidor\\share', '//servidor/share']) {
    assert.throws(
      () => normalizeRelative(candidate),
      WorkspaceGuardError,
      `deberia rechazar ${candidate}`,
    );
  }
});

test('normalizeRelative rechaza bytes nulos y nombres reservados', () => {
  assert.throws(() => normalizeRelative(`src/${String.fromCharCode(0)}evil`), WorkspaceGuardError);
  assert.throws(() => normalizeRelative('src/CON'), WorkspaceGuardError);
  assert.throws(() => normalizeRelative('src/lpt1.txt'), WorkspaceGuardError);
});

test('assertInsideWorkspace acepta rutas legitimas y devuelve la forma absoluta', () => {
  const guarded = assertInsideWorkspace(root, 'src/core/index.ts');
  assert.equal(guarded.relative, 'src/core/index.ts');
  assert.equal(guarded.absolute, path.join(root, 'src', 'core', 'index.ts'));
});

test('assertInsideWorkspace exige un workspace abierto', () => {
  assert.throws(
    () => assertInsideWorkspace(null, 'src/index.ts'),
    (error: unknown) => error instanceof WorkspaceGuardError && error.forge.code === 'E_NO_WORKSPACE',
  );
});

test('assertInsideWorkspace admite rutas que aun no existen', () => {
  const guarded = assertInsideWorkspace(root, 'src/nuevo/archivo.ts');
  assert.equal(guarded.relative, 'src/nuevo/archivo.ts');
});

test('un hermano con prefijo comun no se confunde con el workspace', () => {
  // `/tmp/ws` y `/tmp/ws-malicioso` comparten prefijo textual pero no arbol.
  assert.equal(isInside('/tmp/ws', '/tmp/ws-malicioso/archivo'), false);
  assert.equal(isInside('/tmp/ws', '/tmp/ws/archivo'), true);
  assert.equal(isInside('/tmp/ws', '/tmp/ws'), true);
});

test('un enlace simbolico que apunta fuera queda bloqueado', (t) => {
  const linkPath = path.join(root, 'fuga');
  try {
    symlinkSync(outside, linkPath, 'junction');
  } catch {
    // Crear enlaces puede requerir privilegios en Windows sin modo desarrollador.
    t.skip('no se pudieron crear enlaces simbolicos en este sistema');
    return;
  }
  assert.throws(
    () => assertInsideWorkspace(root, 'fuga/secreto.txt'),
    (error: unknown) =>
      error instanceof WorkspaceGuardError && error.forge.code === 'E_OUTSIDE_WORKSPACE',
  );
});

test('toRelative traduce rutas absolutas y descarta las externas', () => {
  assert.equal(toRelative(root, path.join(root, 'src', 'core', 'index.ts')), 'src/core/index.ts');
  assert.equal(toRelative(root, path.join(outside, 'secreto.txt')), null);
  assert.equal(toRelative(null, path.join(root, 'a.ts')), null);
});
