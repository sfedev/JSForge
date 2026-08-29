/**
 * Pruebas de Forge Vault: validacion de valores, comparacion entre archivos
 * de entorno y reescritura conservando comentarios.
 *
 * El almacen cifrado no se prueba aqui porque depende de `safeStorage`, que
 * necesita el proceso de Electron arrancado. Lo que si se cubre es todo lo
 * demas, que es donde vive la logica.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeEnvironment,
  applyEnvEdits,
  formatFor,
  needsQuotes,
  serializeValue,
  validateValue,
  type EnvFileSnapshot,
} from '../src/main/services/vault/env-validate.js';
import { parseEnvFile } from '../src/main/services/process/env-service.js';

/* -------------------------------------------------------------------------- */
/*  Deteccion del formato                                                      */
/* -------------------------------------------------------------------------- */

test('formatFor deduce el formato del nombre de la variable', () => {
  assert.equal(formatFor('PORT'), 'port');
  assert.equal(formatFor('SERVER_PORT'), 'port');
  assert.equal(formatFor('DATABASE_URL'), 'url');
  assert.equal(formatFor('SENTRY_DSN'), 'url');
  assert.equal(formatFor('ADMIN_EMAIL'), 'email');
  assert.equal(formatFor('DEBUG'), 'boolean');
  assert.equal(formatFor('REQUEST_TIMEOUT_MS'), 'number');
  assert.equal(formatFor('JWT_SECRET'), 'secret');
  assert.equal(formatFor('APP_NAME'), 'text');
});

/* -------------------------------------------------------------------------- */
/*  Validacion                                                                 */
/* -------------------------------------------------------------------------- */

test('un puerto valido pasa y uno absurdo no', () => {
  assert.equal(validateValue('PORT', '3000'), null);
  assert.match(validateValue('PORT', 'abc') ?? '', /puerto valido/);
  assert.match(validateValue('PORT', '70000') ?? '', /puerto valido/);
  assert.match(validateValue('PORT', '-1') ?? '', /puerto valido/);
});

test('un puerto privilegiado se avisa sin rechazarlo', () => {
  assert.match(validateValue('PORT', '80') ?? '', /privilegios elevados/);
});

test('las cadenas de conexion cuentan como URL, no solo http', () => {
  // `postgres://` y `redis://` son lo habitual en un DATABASE_URL.
  assert.equal(validateValue('DATABASE_URL', 'postgres://usuario:clave@localhost:5432/db'), null);
  assert.equal(validateValue('REDIS_URL', 'redis://localhost:6379'), null);
  assert.equal(validateValue('API_URL', 'https://api.ejemplo.dev'), null);
  assert.match(validateValue('API_URL', 'api.ejemplo.dev') ?? '', /falta el esquema/);
});

test('los booleanos admiten las formas habituales', () => {
  for (const value of ['true', 'FALSE', '1', '0', 'yes', 'no', 'on', 'off']) {
    assert.equal(validateValue('DEBUG', value), null, value);
  }
  assert.match(validateValue('DEBUG', 'quiza') ?? '', /booleano/);
});

test('Base64 se comprueba por alfabeto y longitud', () => {
  assert.equal(validateValue('SIGNING_KEY_BASE64', 'aGVsbG8gbXVuZG8h'), null);
  assert.match(validateValue('SIGNING_KEY_BASE64', 'no-es-base64!') ?? '', /Base64/);
  // Longitud que no es multiplo de 4.
  assert.match(validateValue('KEY_BASE64', 'abcde') ?? '', /Base64/);
});

test('un secreto muy corto se senala como marcador sin sustituir', () => {
  assert.match(validateValue('JWT_SECRET', 'x') ?? '', /marcador sin sustituir/);
  assert.equal(validateValue('JWT_SECRET', 'un-secreto-suficientemente-largo'), null);
});

test('un valor vacio no se valida por formato: tiene su propio aviso', () => {
  assert.equal(validateValue('PORT', ''), null);
  assert.equal(validateValue('DATABASE_URL', ''), null);
});

test('un nombre sin regla no impone ningun formato', () => {
  assert.equal(validateValue('APP_NAME', 'lo que sea'), null);
});

/* -------------------------------------------------------------------------- */
/*  Comparacion entre archivos                                                 */
/* -------------------------------------------------------------------------- */

function snapshot(path: string, pairs: Readonly<Record<string, string>>): EnvFileSnapshot {
  return { path, variables: new Map(Object.entries(pairs)) };
}

test('una clave del ejemplo que falta en el .env es un error', () => {
  // Es el fallo mas comun al clonar un proyecto.
  const issues = analyzeEnvironment(
    [snapshot('.env', { PORT: '3000' })],
    snapshot('.env.example', { PORT: '', DATABASE_URL: '' }),
  );
  const missing = issues.find((issue) => issue.kind === 'missing');
  assert.equal(missing?.key, 'DATABASE_URL');
  assert.equal(missing?.severity, 'error');
});

test('una clave del .env que no esta documentada se senala como informativa', () => {
  const issues = analyzeEnvironment(
    [snapshot('.env', { PORT: '3000', INTERNO: 'x' })],
    snapshot('.env.example', { PORT: '' }),
  );
  const extra = issues.find((issue) => issue.kind === 'undocumented');
  assert.equal(extra?.key, 'INTERNO');
  assert.equal(extra?.severity, 'info');
});

test('una clave definida en cualquier .env cuenta como presente', () => {
  // El proyecto puede repartir la configuracion en varios archivos.
  const issues = analyzeEnvironment(
    [snapshot('.env', { PORT: '3000' }), snapshot('.env.local', { DATABASE_URL: 'postgres://x/y' })],
    snapshot('.env.example', { PORT: '', DATABASE_URL: '' }),
  );
  assert.equal(
    issues.filter((issue) => issue.kind === 'missing').length,
    0,
  );
});

test('los valores vacios y los marcadores se avisan', () => {
  const issues = analyzeEnvironment(
    [
      snapshot('.env', {
        VACIA: '',
        CON_MARCADOR: 'changeme',
        OTRO_MARCADOR: '<tu-clave-aqui>',
        TERCERO: 'your-api-key',
      }),
    ],
    null,
  );
  assert.equal(issues.filter((issue) => issue.kind === 'empty').length, 1);
  assert.equal(issues.filter((issue) => issue.kind === 'placeholder').length, 3);
});

test('un formato invalido se avisa con su mensaje', () => {
  const issues = analyzeEnvironment([snapshot('.env', { PORT: 'no-es-un-puerto' })], null);
  const issue = issues.find((entry) => entry.kind === 'invalid-format');
  assert.equal(issue?.key, 'PORT');
  assert.match(issue?.message ?? '', /puerto valido/);
});

test('un entorno correcto no produce ningun aviso', () => {
  const issues = analyzeEnvironment(
    [snapshot('.env', { PORT: '3000', DATABASE_URL: 'postgres://localhost/db' })],
    snapshot('.env.example', { PORT: '', DATABASE_URL: '' }),
  );
  // Las claves del ejemplo estan vacias a proposito, y el ejemplo no se
  // valida a si mismo por formato.
  assert.deepEqual(
    issues.filter((issue) => issue.severity === 'error'),
    [],
  );
});

/* -------------------------------------------------------------------------- */
/*  Serializacion                                                              */
/* -------------------------------------------------------------------------- */

test('needsQuotes reconoce lo que no sobrevive sin comillas', () => {
  assert.equal(needsQuotes('simple'), false);
  assert.equal(needsQuotes('con espacio'), true);
  assert.equal(needsQuotes('con#almohadilla'), true);
  assert.equal(needsQuotes(' con-margen'), true);
  assert.equal(needsQuotes(''), true);
});

test('serializeValue escapa lo que hay que escapar', () => {
  assert.equal(serializeValue('simple'), 'simple');
  assert.equal(serializeValue('con espacio'), '"con espacio"');
  assert.equal(serializeValue('dice "hola"'), '"dice \\"hola\\""');
  assert.equal(serializeValue('linea1\nlinea2'), '"linea1\\nlinea2"');
});

test('lo escrito se relee igual', () => {
  // La ida y vuelta es lo que importa: si `serializeValue` y `parseEnvFile`
  // no coinciden, guardar corrompe el valor en silencio.
  for (const value of [
    'simple',
    'con espacio',
    'dice "hola"',
    'con#almohadilla',
    'postgres://u:p@host:5432/db?ssl=true',
    'linea1\nlinea2',
  ]) {
    const written = `CLAVE=${serializeValue(value)}\n`;
    assert.equal(parseEnvFile(written).get('CLAVE'), value, `fallo con: ${value}`);
  }
});

/* -------------------------------------------------------------------------- */
/*  Reescritura conservando el archivo                                         */
/* -------------------------------------------------------------------------- */

const ENV_SOURCE = [
  '# Configuracion del servidor',
  'PORT=3000',
  '',
  '# Base de datos principal',
  '# Formato: postgres://usuario:clave@host:puerto/base',
  'DATABASE_URL=postgres://localhost/dev',
  '',
  'export LEGACY_FLAG=true',
  '',
].join('\n');

test('editar un valor conserva comentarios, orden y lineas en blanco', () => {
  // Los comentarios son la unica documentacion de un .env.
  const next = applyEnvEdits(ENV_SOURCE, new Map([['PORT', '4000']]));
  assert.match(next, /# Configuracion del servidor/);
  assert.match(next, /# Base de datos principal/);
  assert.match(next, /# Formato: postgres/);
  assert.match(next, /^PORT=4000$/m);
  assert.doesNotMatch(next, /PORT=3000/);
  // El orden no cambia.
  assert.ok(next.indexOf('PORT=') < next.indexOf('DATABASE_URL='));
});

test('eliminar una variable quita su linea y deja el resto intacto', () => {
  const next = applyEnvEdits(ENV_SOURCE, new Map([['DATABASE_URL', null]]));
  assert.doesNotMatch(next, /DATABASE_URL=/);
  assert.match(next, /PORT=3000/);
  // El comentario que la documentaba se conserva: puede seguir sirviendo.
  assert.match(next, /# Base de datos principal/);
});

test('una variable nueva se anade al final', () => {
  const next = applyEnvEdits(ENV_SOURCE, new Map([['NUEVA', 'valor']]));
  assert.match(next, /NUEVA=valor/);
  assert.ok(next.indexOf('NUEVA=') > next.indexOf('LEGACY_FLAG'));
});

test('el prefijo export se conserva al editar', () => {
  // Si el archivo se carga con `source`, quitarlo lo romperia.
  const next = applyEnvEdits(ENV_SOURCE, new Map([['LEGACY_FLAG', 'false']]));
  assert.match(next, /^export LEGACY_FLAG=false$/m);
});

test('el archivo termina siempre en salto de linea', () => {
  assert.ok(applyEnvEdits('PORT=3000', new Map([['PORT', '4000']])).endsWith('\n'));
  assert.ok(applyEnvEdits('', new Map([['A', 'b']])).endsWith('\n'));
});

test('varios cambios a la vez se aplican en una sola pasada', () => {
  const next = applyEnvEdits(
    ENV_SOURCE,
    new Map([
      ['PORT', '8080'],
      ['DATABASE_URL', null],
      ['NUEVA', 'x'],
    ]),
  );
  assert.match(next, /PORT=8080/);
  assert.doesNotMatch(next, /DATABASE_URL=/);
  assert.match(next, /NUEVA=x/);
});

test('un valor con espacios se guarda entrecomillado y se relee bien', () => {
  const next = applyEnvEdits(ENV_SOURCE, new Map([['PORT', 'con espacio']]));
  assert.match(next, /PORT="con espacio"/);
  assert.equal(parseEnvFile(next).get('PORT'), 'con espacio');
});

test('editar un archivo vacio produce un archivo valido', () => {
  const next = applyEnvEdits('', new Map([['A', '1'], ['B', '2']]));
  const parsed = parseEnvFile(next);
  assert.equal(parsed.get('A'), '1');
  assert.equal(parsed.get('B'), '2');
});

test('las lineas que no son asignaciones se dejan tal cual', () => {
  const source = ['# comentario', 'esto no es una asignacion', 'A=1'].join('\n');
  const next = applyEnvEdits(source, new Map([['A', '2']]));
  assert.match(next, /esto no es una asignacion/);
  assert.match(next, /A=2/);
});
