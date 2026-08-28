/**
 * Pruebas del parser de `git status --porcelain=v2`.
 *
 * Los casos vienen de salidas reales: rutas con espacios, renombrados,
 * conflictos y repositorio sin upstream.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseBranches,
  parseLog,
  parseStatusV2,
  stateFromCode,
  LOG_FIELD_SEPARATOR,
  LOG_RECORD_SEPARATOR,
} from '../src/main/services/git/porcelain-parser.js';

const NUL = '\0';

function records(...entries: string[]): string {
  return entries.join(NUL) + NUL;
}

test('stateFromCode traduce los codigos de git', () => {
  assert.equal(stateFromCode('M'), 'modified');
  assert.equal(stateFromCode('A'), 'added');
  assert.equal(stateFromCode('D'), 'deleted');
  assert.equal(stateFromCode('.'), 'unmodified');
  assert.equal(stateFromCode('?'), 'unmodified');
});

test('lee la cabecera de rama con adelanto y retraso', () => {
  const status = parseStatusV2(
    records(
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +3 -2',
    ),
  );
  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 3);
  assert.equal(status.behind, 2);
  assert.equal(status.detached, false);
});

test('detecta HEAD separada', () => {
  const status = parseStatusV2(records('# branch.head (detached)'));
  assert.equal(status.detached, true);
  assert.equal(status.branch, undefined);
});

test('separa el estado del indice del estado del arbol de trabajo', () => {
  // MM = modificado en el indice y tambien en el arbol de trabajo.
  const status = parseStatusV2(
    records('1 MM N... 100644 100644 100644 aaa bbb src/app.ts'),
  );
  assert.equal(status.staged.length, 1);
  assert.equal(status.unstaged.length, 1);
  assert.equal(status.staged[0]?.path, 'src/app.ts');
  assert.equal(status.staged[0]?.index, 'modified');
  assert.equal(status.unstaged[0]?.worktree, 'modified');
});

test('un archivo solo preparado no aparece como sin preparar', () => {
  const status = parseStatusV2(records('1 M. N... 100644 100644 100644 aaa bbb src/a.ts'));
  assert.equal(status.staged.length, 1);
  assert.equal(status.unstaged.length, 0);
});

test('conserva las rutas con espacios', () => {
  const status = parseStatusV2(
    records('1 .M N... 100644 100644 100644 aaa bbb src/mi carpeta/mi archivo.ts'),
  );
  assert.equal(status.unstaged[0]?.path, 'src/mi carpeta/mi archivo.ts');
});

test('lee el renombrado con su ruta original del registro siguiente', () => {
  const status = parseStatusV2(
    records('2 R. N... 100644 100644 100644 aaa bbb R100 src/nuevo.ts', 'src/viejo.ts'),
  );
  assert.equal(status.staged.length, 1);
  assert.equal(status.staged[0]?.path, 'src/nuevo.ts');
  assert.equal(status.staged[0]?.originalPath, 'src/viejo.ts');
  assert.equal(status.staged[0]?.index, 'renamed');
});

test('clasifica los conflictos aparte y no como preparados', () => {
  const status = parseStatusV2(
    records('u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflicto.ts'),
  );
  assert.equal(status.conflicted.length, 1);
  assert.equal(status.staged.length, 0);
  assert.equal(status.unstaged.length, 0);
  assert.equal(status.conflicted[0]?.conflicted, true);
});

test('recoge los archivos sin seguimiento e ignora los ignorados', () => {
  const status = parseStatusV2(records('? nuevo.ts', '! dist/bundle.js'));
  assert.equal(status.untracked.length, 1);
  assert.equal(status.untracked[0]?.path, 'nuevo.ts');
});

test('parseBranches marca la rama actual y descarta HEAD remota', () => {
  const raw = [
    'main\torigin/main\t*',
    'feature/x\t\t',
    'origin/main\t\t',
    'origin/HEAD\t\t',
  ].join('\n');
  const branches = parseBranches(raw);
  assert.equal(branches.length, 3);
  assert.equal(branches[0]?.current, true);
  assert.equal(branches[0]?.upstream, 'origin/main');
  assert.equal(branches[1]?.current, false);
});

test('parseLog separa los campos por caracteres de control', () => {
  const entry = [
    'a'.repeat(40),
    'aaaaaaa',
    'Sergio Rayo',
    'sergio@ejemplo.dev',
    '1700000000',
    'feat: algo',
    'cuerpo del mensaje',
    'HEAD -> main, origin/main',
  ].join(LOG_FIELD_SEPARATOR);

  const entries = parseLog(`${entry}${LOG_RECORD_SEPARATOR}`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.shortHash, 'aaaaaaa');
  assert.equal(entries[0]?.subject, 'feat: algo');
  assert.equal(entries[0]?.date, 1700000000000);
  assert.deepEqual(entries[0]?.refs, ['HEAD -> main', 'origin/main']);
});

test('parseLog acepta un cuerpo con saltos de linea', () => {
  const entry = [
    'b'.repeat(40),
    'bbbbbbb',
    'Autor',
    'a@b.dev',
    '1700000001',
    'fix: algo',
    'linea uno\nlinea dos',
    '',
  ].join(LOG_FIELD_SEPARATOR);
  const entries = parseLog(`${entry}${LOG_RECORD_SEPARATOR}`);
  assert.equal(entries[0]?.body, 'linea uno\nlinea dos');
  assert.deepEqual(entries[0]?.refs, []);
});
