/**
 * Pruebas del motor de plugins.
 *
 * Lo que se ejercita es el lector de manifiestos, que es la pieza critica:
 * el archivo `.forge/plugin.ts` se LEE, nunca se ejecuta, asi que el
 * analizador es la unica frontera entre lo que el usuario escribe y lo que
 * el IDE acaba haciendo.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findCallArgument,
  parseObjectLiteral,
  LiteralParseError,
} from '../src/main/services/plugins/object-literal.js';
import {
  namespacedCommandId,
  parsePlugin,
} from '../src/main/services/plugins/plugin-parser.js';

/* -------------------------------------------------------------------------- */
/*  Lector de literales                                                        */
/* -------------------------------------------------------------------------- */

test('lee los tipos escalares', () => {
  assert.deepEqual(parseObjectLiteral('{ a: 1, b: "dos", c: true, d: null }'), {
    a: 1,
    b: 'dos',
    c: true,
    d: null,
  });
});

test('admite claves sin comillas, comillas simples y comas finales', () => {
  // Es lo que un desarrollador escribe de verdad en un archivo TypeScript.
  assert.deepEqual(parseObjectLiteral("{ sinComillas: 'valor', 'con': 1, }"), {
    sinComillas: 'valor',
    con: 1,
  });
});

test('admite comentarios de linea y de bloque', () => {
  const source = [
    '{',
    '  // el identificador del plugin',
    "  id: 'x',",
    '  /* varias',
    '     lineas */',
    '  version: 1,',
    '}',
  ].join('\n');
  assert.deepEqual(parseObjectLiteral(source), { id: 'x', version: 1 });
});

test('lee estructuras anidadas', () => {
  const value = parseObjectLiteral("{ a: [1, { b: ['c'] }], d: { e: { f: true } } }");
  assert.deepEqual(value, { a: [1, { b: ['c'] }], d: { e: { f: true } } });
});

test('admite cadenas de plantilla sin interpolacion', () => {
  assert.deepEqual(parseObjectLiteral('{ a: `texto plano` }'), { a: 'texto plano' });
});

test('escapa correctamente dentro de las cadenas', () => {
  assert.deepEqual(parseObjectLiteral("{ a: 'con \\'comilla\\'', b: \"salto\\nlinea\" }"), {
    a: "con 'comilla'",
    b: 'salto\nlinea',
  });
});

test('numeros negativos y decimales', () => {
  assert.deepEqual(parseObjectLiteral('{ a: -1, b: 2.5, c: 1e3 }'), { a: -1, b: 2.5, c: 1000 });
});

test('RECHAZA una referencia a variable: exigiria evaluar', () => {
  // Es la garantia central del modulo.
  assert.throws(
    () => parseObjectLiteral('{ command: miVariable }'),
    (cause: unknown) =>
      cause instanceof LiteralParseError && /exigiria evaluar/.test(cause.message),
  );
});

test('RECHAZA una plantilla con interpolacion', () => {
  assert.throws(
    () => parseObjectLiteral('{ path: `${dir}/x` }'),
    (cause: unknown) => cause instanceof LiteralParseError && /\$\{\}/.test(cause.message),
  );
});

test('RECHAZA una llamada a funcion', () => {
  assert.throws(() => parseObjectLiteral('{ run: hacerAlgo() }'), LiteralParseError);
});

test('el error indica la linea, no solo que fallo', () => {
  const source = ['{', '  a: 1,', '  b: variable,', '}'].join('\n');
  try {
    parseObjectLiteral(source);
    assert.fail('se esperaba un fallo');
  } catch (cause) {
    assert.ok(cause instanceof LiteralParseError);
    assert.equal(cause.line, 3);
  }
});

test('findCallArgument localiza el argumento de la llamada', () => {
  const source = "export default definePlugin({ id: 'x' });";
  const start = findCallArgument(source, 'definePlugin');
  assert.notEqual(start, -1);
  assert.deepEqual(parseObjectLiteral(source, start), { id: 'x' });
  assert.equal(findCallArgument(source, 'noExiste'), -1);
});

/* -------------------------------------------------------------------------- */
/*  Manifiesto completo                                                        */
/* -------------------------------------------------------------------------- */

const MANIFEST = [
  "import { definePlugin } from 'forgejs-ide';",
  '',
  'export default definePlugin({',
  "  id: 'equipo',",
  "  name: 'Herramientas del equipo',",
  "  version: '2.0.0',",
  "  description: 'Comandos internos.',",
  '',
  '  commands: [',
  '    {',
  "      id: 'migrar',",
  "      title: 'Aplicar migraciones',",
  "      category: 'Base de datos',",
  '      run: [',
  "        { task: 'shell', command: 'npm', args: ['run', 'db:migrate'] },",
  "        { task: 'command', id: 'explorer.refresh', args: [] },",
  '      ],',
  '    },',
  '  ],',
  '',
  '  formatters: [',
  "    { languages: ['sql'], command: 'sql-formatter', args: ['--fix', '$FILE'] },",
  "    { languages: ['toml'], command: 'taplo', args: ['format', '-'] },",
  '  ],',
  '',
  '  scaffold: [',
  '    {',
  "      blueprint: 'express',",
  "      afterGenerate: [{ task: 'shell', command: 'npm', args: ['run', 'lint'] }],",
  '    },',
  '  ],',
  '',
  '  onSave: [',
  '    {',
  "      include: ['src/**/*.sql'],",
  "      run: [{ task: 'command', id: 'editor.format', args: [] }],",
  '    },',
  '  ],',
  '});',
].join('\n');

const PARSED = parsePlugin('.forge/plugin.ts', MANIFEST);

test('un manifiesto completo se lee sin errores', () => {
  assert.deepEqual(PARSED.errors, []);
  assert.ok(PARSED.definition !== null);
  assert.equal(PARSED.definition.id, 'equipo');
  assert.equal(PARSED.definition.name, 'Herramientas del equipo');
  assert.equal(PARSED.definition.version, '2.0.0');
  assert.equal(PARSED.definition.path, '.forge/plugin.ts');
});

test('los comandos se prefijan con el id del plugin', () => {
  // Sin prefijo, dos plugins podrian pisarse el mismo id.
  assert.equal(PARSED.definition?.commands[0]?.id, 'equipo.migrar');
  assert.equal(namespacedCommandId('equipo', 'migrar'), 'equipo.migrar');
  // Si ya viene prefijado, no se duplica.
  assert.equal(namespacedCommandId('equipo', 'equipo.migrar'), 'equipo.migrar');
});

test('las acciones conservan su orden', () => {
  const actions = PARSED.definition?.commands[0]?.actions ?? [];
  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.task, 'shell');
  assert.equal(actions[1]?.task, 'command');
});

test('un formateador con $FILE no usa la entrada estandar', () => {
  const [sql, toml] = PARSED.definition?.formatters ?? [];
  assert.equal(sql?.usesStdin, false, 'con $FILE el formateador edita el archivo');
  assert.equal(toml?.usesStdin, true, 'sin $FILE se pasa por stdin');
});

test('un gancho de scaffold sin blueprint aplica a todos', () => {
  const parsed = parsePlugin(
    'p.ts',
    [
      "definePlugin({ id: 'x', name: 'X', scaffold: [",
      "  { afterGenerate: [{ task: 'shell', command: 'echo', args: ['hola'] }] },",
      '] })',
    ].join('\n'),
  );
  assert.equal(parsed.definition?.scaffold[0]?.blueprint, '*');
});

/* -------------------------------------------------------------------------- */
/*  Validacion                                                                 */
/* -------------------------------------------------------------------------- */

test('un archivo sin definePlugin se rechaza con un mensaje util', () => {
  const parsed = parsePlugin('p.ts', 'export const x = 1;');
  assert.equal(parsed.definition, null);
  assert.match(parsed.errors[0] ?? '', /definePlugin/);
});

test('faltan id o name: no hay plugin', () => {
  const parsed = parsePlugin('p.ts', "definePlugin({ name: 'Sin id' })");
  assert.equal(parsed.definition, null);
  assert.ok(parsed.errors.some((error) => /"id"/.test(error)));
});

test('un comando sin acciones se rechaza y se dice cual', () => {
  const parsed = parsePlugin(
    'p.ts',
    "definePlugin({ id: 'x', name: 'X', commands: [{ id: 'a', title: 'A' }] })",
  );
  assert.ok(parsed.errors.some((error) => /commands\[0\].*"run"/.test(error)));
});

test('un comando sin titulo se rechaza: es lo que se ve en la paleta', () => {
  const parsed = parsePlugin(
    'p.ts',
    "definePlugin({ id: 'x', name: 'X', commands: [{ id: 'a', run: [{ task: 'shell', command: 'ls' }] }] })",
  );
  assert.ok(parsed.errors.some((error) => /"title"/.test(error)));
});

test('una tarea desconocida se rechaza en vez de ignorarse', () => {
  const parsed = parsePlugin(
    'p.ts',
    "definePlugin({ id: 'x', name: 'X', commands: [{ id: 'a', title: 'A', run: [{ task: 'eval', code: 'x' }] }] })",
  );
  assert.ok(parsed.errors.some((error) => /"task" debe ser uno de/.test(error)));
});

test('una tarea write con ruta absoluta o con .. se rechaza', () => {
  for (const path of ['/etc/passwd', 'C:/Windows/x', '../fuera.txt']) {
    const parsed = parsePlugin(
      'p.ts',
      `definePlugin({ id: 'x', name: 'X', commands: [{ id: 'a', title: 'A', run: [{ task: 'write', path: '${path}', content: 'x' }] }] })`,
    );
    assert.ok(
      parsed.errors.some((error) => /relativo al workspace/.test(error)),
      `deberia rechazarse: ${path}`,
    );
  }
});

test('dos comandos con el mismo id se detectan', () => {
  const parsed = parsePlugin(
    'p.ts',
    [
      "definePlugin({ id: 'x', name: 'X', commands: [",
      "  { id: 'a', title: 'A', run: [{ task: 'shell', command: 'ls' }] },",
      "  { id: 'a', title: 'Otra A', run: [{ task: 'shell', command: 'ls' }] },",
      '] })',
    ].join('\n'),
  );
  assert.ok(parsed.errors.some((error) => /declarado dos veces/.test(error)));
});

test('los errores se acumulan: se reportan todos de golpe', () => {
  // Fallar en el primero obligaria a repetir el ciclo una vez por error.
  const parsed = parsePlugin(
    'p.ts',
    [
      "definePlugin({ id: 'x', name: 'X', commands: [",
      "  { id: 'a', title: 'A' },",
      "  { id: 'b', title: 'B' },",
      "  { id: 'c', title: 'C' },",
      '] })',
    ].join('\n'),
  );
  assert.equal(parsed.errors.length, 3);
});

test('un plugin que no aporta nada se senala', () => {
  const parsed = parsePlugin('p.ts', "definePlugin({ id: 'x', name: 'X' })");
  assert.ok(parsed.errors.some((error) => /no aporta ningun comando/.test(error)));
});

test('un manifiesto con una referencia a variable falla con la linea', () => {
  const parsed = parsePlugin(
    '.forge/plugin.ts',
    ["definePlugin({", "  id: 'x',", '  name: NOMBRE,', '})'].join('\n'),
  );
  assert.equal(parsed.definition, null);
  assert.match(parsed.errors[0] ?? '', /linea 3/);
});

test('un formateador sin lenguajes o sin comando se rechaza', () => {
  const parsed = parsePlugin(
    'p.ts',
    [
      "definePlugin({ id: 'x', name: 'X', formatters: [",
      "  { command: 'sin-lenguajes' },",
      "  { languages: ['sql'] },",
      '] })',
    ].join('\n'),
  );
  assert.equal(parsed.errors.length, 2);
  assert.ok(parsed.errors.some((error) => /"languages"/.test(error)));
  assert.ok(parsed.errors.some((error) => /"command"/.test(error)));
});

test('un gancho de guardado sin patrones se rechaza', () => {
  const parsed = parsePlugin(
    'p.ts',
    "definePlugin({ id: 'x', name: 'X', onSave: [{ run: [{ task: 'command', id: 'a' }] }] })",
  );
  assert.ok(parsed.errors.some((error) => /"include"/.test(error)));
});

test('una accion suelta (no en lista) tambien se acepta', () => {
  // Es lo natural escribir `run: { task: ... }` cuando solo hay una.
  const parsed = parsePlugin(
    'p.ts',
    "definePlugin({ id: 'x', name: 'X', commands: [{ id: 'a', title: 'A', run: { task: 'shell', command: 'ls' } }] })",
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.definition?.commands[0]?.actions.length, 1);
});
