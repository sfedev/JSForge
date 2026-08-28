/** Pruebas de la diferencia por subsecuencia comun mas larga. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { collapseContext, diffLines } from '../src/renderer/core/diff.js';

function render(original: string, modified: string): string[] {
  return diffLines(original, modified).lines.map(
    (line) => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`,
  );
}

test('dos textos identicos no producen cambios', () => {
  const summary = diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(summary.added, 0);
  assert.equal(summary.removed, 0);
  assert.equal(summary.lines.length, 3);
  assert.ok(summary.lines.every((line) => line.kind === 'equal'));
});

test('detecta una linea insertada en medio', () => {
  assert.deepEqual(render('a\nc', 'a\nb\nc'), [' a', '+b', ' c']);
});

test('detecta una linea eliminada', () => {
  assert.deepEqual(render('a\nb\nc', 'a\nc'), [' a', '-b', ' c']);
});

test('una linea modificada aparece como eliminacion mas adicion', () => {
  const summary = diffLines('const a = 1;', 'const a = 2;');
  assert.equal(summary.removed, 1);
  assert.equal(summary.added, 1);
});

test('conserva la numeracion de linea de cada lado', () => {
  const summary = diffLines('a\nb\nc', 'a\nx\nb\nc');
  const added = summary.lines.find((line) => line.kind === 'added');
  assert.equal(added?.originalLine, null);
  assert.equal(added?.modifiedLine, 2);

  const last = summary.lines.at(-1);
  assert.equal(last?.originalLine, 3);
  assert.equal(last?.modifiedLine, 4);
});

test('encuentra la subsecuencia comun mas larga y no el primer emparejamiento', () => {
  // Un algoritmo ingenuo marcaria todo como reemplazado; la LCS conserva
  // las tres lineas comunes.
  const summary = diffLines('x\na\nb\nc\ny', 'a\nb\nc');
  assert.equal(summary.added, 0);
  assert.equal(summary.removed, 2);
});

test('funciona con un texto vacio en cualquiera de los lados', () => {
  assert.equal(diffLines('', 'a\nb').added, 2);
  assert.equal(diffLines('a\nb', '').removed, 2);
});

test('collapseContext deja solo los bloques cambiados y su contexto', () => {
  const original = Array.from({ length: 40 }, (_, index) => `linea ${index}`).join('\n');
  const modified = original.replace('linea 20', 'linea veinte');
  const summary = diffLines(original, modified);
  const collapsed = collapseContext(summary, 2);

  assert.ok(collapsed.length < summary.lines.length, 'debe recortar');
  assert.ok(collapsed.some((line) => line.text === '⋯'), 'debe marcar los tramos omitidos');
  assert.ok(collapsed.some((line) => line.kind === 'added' && line.text === 'linea veinte'));
});

test('degrada a bloque unico cuando el texto es enorme', () => {
  // 2500 x 2500 supera el limite de celdas de la tabla exacta.
  const a = Array.from({ length: 2500 }, (_, index) => `a${index}`).join('\n');
  const b = Array.from({ length: 2500 }, (_, index) => `b${index}`).join('\n');
  const summary = diffLines(a, b);
  assert.equal(summary.approximate, true);
  assert.equal(summary.added, 2500);
  assert.equal(summary.removed, 2500);
});
