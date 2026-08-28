/**
 * Pruebas del framing `Content-Length`.
 *
 * El caso que rompe las implementaciones ingenuas es medir la longitud en
 * caracteres en vez de en bytes: un mensaje con acentos o emoji se parte.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MessageDecoder,
  encodeMessage,
  parseContentLength,
} from '../src/main/services/lsp/framing.js';

test('encodeMessage cuenta bytes UTF-8, no caracteres', () => {
  const message = { jsonrpc: '2.0', method: 'test', params: { texto: 'añó 🚀' } };
  const encoded = encodeMessage(message);
  const separator = encoded.indexOf('\r\n\r\n');
  const header = encoded.subarray(0, separator).toString('ascii');
  const body = encoded.subarray(separator + 4);

  const declared = parseContentLength(header);
  assert.equal(declared, body.byteLength);
  assert.notEqual(declared, JSON.stringify(message).length, 'la longitud en bytes difiere de la de caracteres');
});

test('parseContentLength ignora mayusculas y otras cabeceras', () => {
  const header = 'Content-Type: application/vscode-jsonrpc\r\ncontent-LENGTH: 42';
  assert.equal(parseContentLength(header), 42);
  assert.equal(parseContentLength('X-Otra: 1'), null);
});

test('decodifica un mensaje completo', () => {
  const decoder = new MessageDecoder();
  const messages = decoder.push(encodeMessage({ id: 1, result: 'ok' }));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.value, { id: 1, result: 'ok' });
  assert.equal(decoder.pending, 0);
});

test('reensambla un mensaje partido en varios fragmentos', () => {
  const decoder = new MessageDecoder();
  const encoded = encodeMessage({ id: 7, result: { texto: 'áéíóú 🚀 partido' } });

  let collected: unknown[] = [];
  // Se entrega byte a byte: el peor caso posible.
  for (let index = 0; index < encoded.byteLength; index += 1) {
    collected = collected.concat(decoder.push(encoded.subarray(index, index + 1)).map((m) => m.value));
  }
  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0], { id: 7, result: { texto: 'áéíóú 🚀 partido' } });
});

test('decodifica varios mensajes que llegan en el mismo fragmento', () => {
  const decoder = new MessageDecoder();
  const chunk = Buffer.concat([
    encodeMessage({ id: 1 }),
    encodeMessage({ id: 2 }),
    encodeMessage({ id: 3 }),
  ]);
  const messages = decoder.push(chunk);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => (m.value as { id: number }).id), [1, 2, 3]);
});

test('conserva el mensaje siguiente cuando el primero llega incompleto', () => {
  const decoder = new MessageDecoder();
  const first = encodeMessage({ id: 1, result: 'primero' });
  const second = encodeMessage({ id: 2, result: 'segundo' });

  const partial = Buffer.concat([first.subarray(0, first.byteLength - 5)]);
  assert.equal(decoder.push(partial).length, 0);

  const rest = Buffer.concat([first.subarray(first.byteLength - 5), second]);
  const messages = decoder.push(rest);
  assert.equal(messages.length, 2);
  assert.deepEqual((messages[1]?.value as { result: string }).result, 'segundo');
});

test('un cuerpo no JSON no desincroniza el flujo', () => {
  const decoder = new MessageDecoder();
  const broken = Buffer.from('Content-Length: 5\r\n\r\nno-js', 'utf8');
  const good = encodeMessage({ id: 9 });

  const messages = decoder.push(Buffer.concat([broken, good]));
  assert.equal(messages.length, 1, 'el mensaje valido posterior debe llegar');
  assert.deepEqual(messages[0]?.value, { id: 9 });
});

test('una cabecera sin Content-Length se descarta sin bloquear', () => {
  const decoder = new MessageDecoder();
  const bogus = Buffer.from('X-Inventada: 1\r\n\r\n', 'utf8');
  const good = encodeMessage({ id: 4 });
  const messages = decoder.push(Buffer.concat([bogus, good]));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.value, { id: 4 });
});
