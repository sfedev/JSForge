/**
 * Pruebas del motor de depuracion: codec WebSocket, descubrimiento de
 * destinos, traduccion de rutas y deteccion de fugas de memoria.
 *
 * Todo lo que se prueba aqui es puro. El cliente CDP se apoya en estas
 * piezas, de modo que un fallo de mascara o de longitud extendida se detecta
 * sin levantar un inspector de verdad.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  FrameDecoder,
  FrameDecoderError,
  MessageAssembler,
  OPCODE,
  acceptValue,
  encodeClose,
  encodeFrame,
  encodeText,
  handshakeFailure,
  parseHandshakeResponse,
} from '../src/main/debugger/ws-frame.js';
import {
  debuggerPath,
  isLoopbackHost,
  parseTargetList,
} from '../src/main/debugger/cdp-client.js';
import {
  absoluteToScriptUrl,
  frameLabel,
  isInternalUrl,
  scriptUrlToAbsolute,
  scriptUrlToWorkspaceRelative,
  workspaceRelativeToScriptUrl,
} from '../src/main/debugger/source-map.js';
import { heapSlopeMbPerMinute, isLeakSuspected } from '../src/main/debugger/heap-trend.js';
import { describeRemoteObject, readScopeChain } from '../src/main/debugger/debug-session.js';
import type { HeapSample } from '../src/shared/contracts.js';

/* -------------------------------------------------------------------------- */
/*  Handshake                                                                  */
/* -------------------------------------------------------------------------- */

test('acceptValue aplica el GUID del protocolo (vector del RFC 6455)', () => {
  // Par clave/respuesta del ejemplo normativo del RFC.
  assert.equal(acceptValue('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('parseHandshakeResponse espera a tener todas las cabeceras', () => {
  assert.equal(parseHandshakeResponse('HTTP/1.1 101 Switching Protocols\r\nUpgrade: web'), null);
});

test('parseHandshakeResponse normaliza los nombres de cabecera', () => {
  const response = parseHandshakeResponse(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: abc\r\n\r\n',
  );
  assert.ok(response !== null);
  assert.equal(response.status, 101);
  assert.equal(response.headers.get('upgrade'), 'websocket');
  assert.equal(response.headers.get('sec-websocket-accept'), 'abc');
});

test('handshakeFailure acepta una respuesta correcta y rechaza las demas', () => {
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const good = parseHandshakeResponse(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptValue(key)}\r\n\r\n`,
  );
  assert.ok(good !== null);
  assert.equal(handshakeFailure(good, key), null);

  // Un puerto ocupado por un servidor HTTP normal responde 200, no 101.
  const notUpgraded = parseHandshakeResponse('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n');
  assert.ok(notUpgraded !== null);
  assert.match(handshakeFailure(notUpgraded, key) ?? '', /101/);

  // Clave que no corresponde: posible intermediario.
  const wrongKey = parseHandshakeResponse(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: otra\r\n\r\n',
  );
  assert.ok(wrongKey !== null);
  assert.match(handshakeFailure(wrongKey, key) ?? '', /Sec-WebSocket-Accept/);
});

/* -------------------------------------------------------------------------- */
/*  Tramas                                                                     */
/* -------------------------------------------------------------------------- */

test('encodeFrame enmascara siempre lo que envia el cliente', () => {
  const frame = encodeFrame(OPCODE.TEXT, Buffer.from('hola'));
  // Bit de mascara en el segundo octeto.
  assert.equal((frame[1] ?? 0) & 0x80, 0x80);
  // 2 de cabecera + 4 de clave de mascara + 4 de carga.
  assert.equal(frame.byteLength, 10);
  // La carga no viaja en claro.
  assert.notEqual(frame.subarray(6).toString('utf8'), 'hola');
});

test('una trama enmascarada se decodifica a su texto original', () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(encodeText('mensaje con acentos: ñá'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.payload.toString('utf8'), 'mensaje con acentos: ñá');
  assert.equal(frames[0]?.fin, true);
});

test('las longitudes de 16 y 64 bits se codifican y releen igual', () => {
  for (const size of [125, 126, 65535, 65536]) {
    const payload = Buffer.alloc(size, 0x41);
    const frames = new FrameDecoder().push(encodeFrame(OPCODE.BINARY, payload));
    assert.equal(frames.length, 1, `fallo con ${size} bytes`);
    assert.equal(frames[0]?.payload.byteLength, size);
  }
});

test('el decodificador espera a que la trama este entera', () => {
  const decoder = new FrameDecoder();
  const frame = encodeText('el inspector parte las respuestas grandes');

  // Se entrega byte a byte: hasta el ultimo no debe salir nada.
  for (let index = 0; index < frame.byteLength - 1; index += 1) {
    assert.deepEqual(decoder.push(frame.subarray(index, index + 1)), []);
  }
  const frames = decoder.push(frame.subarray(frame.byteLength - 1));
  assert.equal(frames.length, 1);
  assert.equal(decoder.pending, 0);
});

test('varias tramas en un solo fragmento salen todas', () => {
  const chunk = Buffer.concat([encodeText('una'), encodeText('dos'), encodeText('tres')]);
  const frames = new FrameDecoder().push(chunk);
  assert.deepEqual(
    frames.map((frame) => frame.payload.toString('utf8')),
    ['una', 'dos', 'tres'],
  );
});

test('la carga decodificada no comparte memoria con el buffer acumulado', () => {
  const decoder = new FrameDecoder();
  const [first] = decoder.push(encodeText('primero'));
  assert.ok(first !== undefined);
  // Al empujar mas datos, el buffer interno se reasigna; si la carga fuera
  // una vista sobre el, este texto cambiaria a la espalda del llamante.
  decoder.push(encodeText('segundo'));
  assert.equal(first.payload.toString('utf8'), 'primero');
});

test('una longitud de 64 bits fuera de rango se rechaza en vez de reservar memoria', () => {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(1, 2); // 32 bits altos distintos de cero.
  header.writeUInt32BE(0, 6);
  assert.throws(() => new FrameDecoder().push(header), FrameDecoderError);
});

test('encodeClose lleva el codigo de cierre normal', () => {
  const frames = new FrameDecoder().push(encodeClose(1000));
  assert.equal(frames[0]?.opcode, OPCODE.CLOSE);
  assert.equal(frames[0]?.payload.readUInt16BE(0), 1000);
});

/* -------------------------------------------------------------------------- */
/*  Ensamblado de mensajes fragmentados                                        */
/* -------------------------------------------------------------------------- */

test('MessageAssembler une un mensaje partido en continuaciones', () => {
  const assembler = new MessageAssembler();
  assert.equal(
    assembler.accept({ fin: false, opcode: OPCODE.TEXT, payload: Buffer.from('{"id":1,') }),
    null,
  );
  assert.equal(
    assembler.accept({ fin: false, opcode: OPCODE.CONTINUATION, payload: Buffer.from('"result"') }),
    null,
  );
  assert.equal(
    assembler.accept({ fin: true, opcode: OPCODE.CONTINUATION, payload: Buffer.from(':{}}') }),
    '{"id":1,"result":{}}',
  );
});

test('MessageAssembler ignora las tramas de control', () => {
  const assembler = new MessageAssembler();
  assert.equal(
    assembler.accept({ fin: true, opcode: OPCODE.PING, payload: Buffer.alloc(0) }),
    null,
  );
});

/* -------------------------------------------------------------------------- */
/*  Descubrimiento de destinos                                                 */
/* -------------------------------------------------------------------------- */

test('parseTargetList lee la respuesta del inspector', () => {
  const body = JSON.stringify([
    {
      id: 'abc',
      title: 'servidor.js',
      url: 'file:///proyecto/servidor.js',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc-123',
    },
  ]);
  const targets = parseTargetList(body);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.title, 'servidor.js');
  assert.equal(targets[0]?.webSocketDebuggerUrl, 'ws://127.0.0.1:9229/abc-123');
});

test('parseTargetList descarta entradas sin URL de depuracion', () => {
  const body = JSON.stringify([
    { id: 'sin-ws', title: 'otro servicio' },
    { webSocketDebuggerUrl: 'ws://127.0.0.1:9229/ok' },
  ]);
  assert.equal(parseTargetList(body).length, 1);
});

test('parseTargetList tolera un cuerpo que no es del inspector', () => {
  // El puerto puede estar ocupado por cualquier otra cosa.
  assert.deepEqual(parseTargetList('<html>No es JSON</html>'), []);
  assert.deepEqual(parseTargetList('{"error":"no soy una lista"}'), []);
});

test('debuggerPath extrae la ruta del WebSocket', () => {
  assert.equal(debuggerPath('ws://127.0.0.1:9229/f4a1-b2c3'), '/f4a1-b2c3');
  assert.equal(debuggerPath('ws://127.0.0.1:9229'), '/');
});

test('solo se admiten inspectores del bucle local', () => {
  for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  // El inspector de Node no autentica: abrirlo a la red es ejecucion remota.
  for (const host of ['10.0.0.5', 'example.com', '0.0.0.0', '127.0.0.1.evil.com']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

/* -------------------------------------------------------------------------- */
/*  Traduccion de rutas                                                        */
/* -------------------------------------------------------------------------- */

test('isInternalUrl reconoce los modulos internos de Node', () => {
  assert.equal(isInternalUrl('node:internal/modules/cjs/loader'), true);
  assert.equal(isInternalUrl('internal/process/task_queues'), true);
  assert.equal(isInternalUrl('file:///proyecto/src/app.ts'), false);
});

test('una URL file:// ida y vuelta conserva la ruta', () => {
  const absolute = path.resolve('proyecto', 'src', 'app.ts');
  assert.equal(scriptUrlToAbsolute(absoluteToScriptUrl(absolute)), absolute);
});

test('scriptUrlToAbsolute descarta lo que no es un archivo real', () => {
  assert.equal(scriptUrlToAbsolute('node:fs'), null);
  assert.equal(scriptUrlToAbsolute(''), null);
  assert.equal(scriptUrlToAbsolute('<anonymous>'), null);
});

test('scriptUrlToWorkspaceRelative devuelve rutas con separador /', () => {
  const root = path.resolve('proyecto');
  const url = absoluteToScriptUrl(path.join(root, 'src', 'servicios', 'api.ts'));
  assert.equal(scriptUrlToWorkspaceRelative(root, url), 'src/servicios/api.ts');
});

test('un hermano con prefijo comun no se confunde con el workspace', () => {
  // `startsWith` sobre cadenas daria un falso positivo aqui.
  const root = path.resolve('proyecto');
  const url = absoluteToScriptUrl(path.resolve('proyecto-viejo', 'src', 'app.ts'));
  assert.equal(scriptUrlToWorkspaceRelative(root, url), null);
});

test('los scripts de fuera del workspace quedan sin ruta relativa', () => {
  const root = path.resolve('proyecto');
  assert.equal(scriptUrlToWorkspaceRelative(root, 'node:internal/bootstrap'), null);
  assert.equal(
    scriptUrlToWorkspaceRelative(root, absoluteToScriptUrl(path.resolve('otro', 'x.js'))),
    null,
  );
});

test('workspaceRelativeToScriptUrl produce la URL que espera el motor', () => {
  const root = path.resolve('proyecto');
  const url = workspaceRelativeToScriptUrl(root, 'src/app.ts');
  assert.ok(url.startsWith('file://'));
  assert.equal(scriptUrlToWorkspaceRelative(root, url), 'src/app.ts');
});

test('frameLabel marca los marcos internos en lugar de mostrar la URL cruda', () => {
  assert.equal(frameLabel('file:///x/y.ts', 'src/y.ts'), 'src/y.ts');
  assert.match(frameLabel('node:internal/timers', null), /interno de Node/);
  assert.equal(frameLabel('', null), '(sin origen)');
});

/* -------------------------------------------------------------------------- */
/*  Tendencia de memoria                                                       */
/* -------------------------------------------------------------------------- */

/** Serie sintetica: `values` en MB, una muestra cada 2 s. */
function series(values: readonly number[]): HeapSample[] {
  const base = 1_700_000_000_000;
  return values.map((usedHeapMb, index) => ({
    sessionId: 's',
    time: base + index * 2000,
    usedHeapMb,
    totalHeapMb: usedHeapMb + 10,
  }));
}

test('heapSlopeMbPerMinute mide el crecimiento en MB por minuto', () => {
  // 1 MB cada 2 s = 30 MB/min.
  const slope = heapSlopeMbPerMinute(series([10, 11, 12, 13, 14, 15]));
  assert.ok(Math.abs(slope - 30) < 0.5, `pendiente inesperada: ${slope}`);
});

test('una serie plana no tiene pendiente', () => {
  assert.equal(heapSlopeMbPerMinute(series([40, 40, 40, 40])), 0);
});

test('heapSlopeMbPerMinute necesita al menos dos muestras', () => {
  assert.equal(heapSlopeMbPerMinute([]), 0);
  assert.equal(heapSlopeMbPerMinute(series([12])), 0);
});

test('los dientes de sierra de un proceso sano no se toman por una fuga', () => {
  // Sube y el recolector lo devuelve al mismo valle: memoria estable.
  const healthy = series([20, 34, 48, 21, 36, 50, 20, 35, 49, 22, 37, 51]);
  assert.equal(isLeakSuspected(healthy), false);
});

test('los valles crecientes si se senalan como posible fuga', () => {
  // El maximo sube, pero sobre todo sube el minimo tras cada recoleccion.
  const leaking = series([20, 30, 26, 38, 34, 46, 42, 54, 50, 62, 58, 70]);
  assert.equal(isLeakSuspected(leaking), true);
});

test('un pico aislado no basta para avisar de una fuga', () => {
  const spike = series([20, 21, 20, 22, 90, 21, 20, 22, 21, 20, 21, 22]);
  assert.equal(isLeakSuspected(spike), false);
});

test('con pocas muestras nunca se avisa de una fuga', () => {
  assert.equal(isLeakSuspected(series([10, 30, 60])), false);
});

/* -------------------------------------------------------------------------- */
/*  Conversion de valores del motor                                            */
/* -------------------------------------------------------------------------- */

test('describeRemoteObject prefiere la descripcion que calcula el motor', () => {
  assert.equal(
    describeRemoteObject({ type: 'object', className: 'Array', description: 'Array(3)' }),
    'Array(3)',
  );
});

test('describeRemoteObject entrecomilla las cadenas para distinguir 1 de "1"', () => {
  assert.equal(describeRemoteObject({ type: 'string', value: '1' }), '"1"');
  assert.equal(describeRemoteObject({ type: 'number', value: 1 }), '1');
});

test('describeRemoteObject resuelve null, undefined y los no serializables', () => {
  assert.equal(describeRemoteObject({ type: 'object', subtype: 'null' }), 'null');
  assert.equal(describeRemoteObject({ type: 'undefined' }), 'undefined');
  assert.equal(
    describeRemoteObject({ type: 'number', unserializableValue: 'Infinity' }),
    'Infinity',
  );
});

test('readScopeChain descarta el ambito global', () => {
  const chain = readScopeChain([
    { type: 'local', object: { objectId: '1' } },
    { type: 'closure', name: 'handler', object: { objectId: '2' } },
    // Miles de propiedades que nadie inspecciona.
    { type: 'global', object: { objectId: '3' } },
  ]);
  assert.deepEqual(
    chain.map((scope) => scope.type),
    ['local', 'closure'],
  );
  assert.equal(chain[1]?.name, 'handler');
  assert.equal(chain[1]?.objectId, '2');
});

test('readScopeChain tolera una cadena ausente o malformada', () => {
  assert.deepEqual(readScopeChain(undefined), []);
  assert.deepEqual(readScopeChain([null, 'texto']), []);
});
