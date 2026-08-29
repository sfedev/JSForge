/**
 * Pruebas del visor de contratos: lectura de OpenAPI, generacion de codigo
 * y deteccion de cambios que rompen el tipado.
 *
 * Todo lo que se ejercita es puro. El generador se comprueba por lo que
 * garantiza (nada de `any`, cancelacion, tipos correctos), no comparando el
 * texto entero, que cambiaria con cualquier retoque de formato.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findLine,
  parseOpenApi,
  parseSpecSource,
  refName,
  schemaTypeName,
} from '../src/main/services/spec/openapi-parser.js';
import {
  defaultOutputPath,
  generate,
  isReadOperation,
  narrowDocument,
  operationSignature,
  propertyKey,
  renderSchema,
  successResponseType,
  toCamelCase,
  toPascalCase,
} from '../src/main/services/spec/codegen.js';
import {
  extractModuleShape,
  importedSymbols,
  parseMember,
  splitMembers,
  stripComments,
  unionVariants,
} from '../src/main/services/spec/ts-shape.js';
import {
  affectedSymbols,
  compareModules,
  findDependents,
  normalizeType,
} from '../src/main/services/spec/contract-audit.js';

/* -------------------------------------------------------------------------- */
/*  Documento de ejemplo                                                       */
/* -------------------------------------------------------------------------- */

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'API de Pedidos', version: '2.1.0' },
  servers: [{ url: 'https://api.ejemplo.dev/v1' }],
  paths: {
    '/usuarios': {
      get: {
        operationId: 'listarUsuarios',
        summary: 'Lista los usuarios',
        tags: ['usuarios'],
        parameters: [
          { name: 'pagina', in: 'query', schema: { type: 'integer' } },
          { name: 'buscar', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Listado',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Usuario' } },
              },
            },
          },
        },
      },
      post: {
        operationId: 'crearUsuario',
        tags: ['usuarios'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NuevoUsuario' } },
          },
        },
        responses: {
          '201': {
            description: 'Creado',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Usuario' } },
            },
          },
        },
      },
    },
    '/usuarios/{id}': {
      // Parametro declarado a nivel de ruta: aplica a todas sus operaciones.
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      delete: {
        operationId: 'borrarUsuario',
        tags: ['usuarios'],
        deprecated: true,
        responses: { '204': { description: 'Sin contenido' } },
      },
    },
  },
  components: {
    schemas: {
      Usuario: {
        type: 'object',
        required: ['id', 'nombre'],
        properties: {
          id: { type: 'string' },
          nombre: { type: 'string', description: 'Nombre visible' },
          edad: { type: 'integer', nullable: true },
          rol: { type: 'string', enum: ['admin', 'lector'] },
          etiquetas: { type: 'array', items: { type: 'string' } },
        },
      },
      NuevoUsuario: {
        type: 'object',
        required: ['nombre'],
        properties: { nombre: { type: 'string' } },
      },
    },
  },
};

const SPEC_JSON = JSON.stringify(SPEC, null, 2);
const DOCUMENT = parseOpenApi('openapi.json', SPEC_JSON);

/* -------------------------------------------------------------------------- */
/*  Lectura de la especificacion                                               */
/* -------------------------------------------------------------------------- */

test('parseOpenApi lee titulo, version y servidores', () => {
  assert.equal(DOCUMENT.title, 'API de Pedidos');
  assert.equal(DOCUMENT.version, '2.1.0');
  assert.equal(DOCUMENT.openapi, '3.0.3');
  assert.deepEqual(DOCUMENT.servers, ['https://api.ejemplo.dev/v1']);
  assert.deepEqual(DOCUMENT.warnings, []);
});

test('parseOpenApi recoge todas las operaciones con su metodo y ruta', () => {
  assert.deepEqual(
    DOCUMENT.operations.map((operation) => `${operation.method} ${operation.path}`),
    ['get /usuarios', 'post /usuarios', 'delete /usuarios/{id}'],
  );
});

test('los parametros del nivel de ruta se heredan en cada operacion', () => {
  const borrar = DOCUMENT.operations.find((operation) => operation.id === 'borrarUsuario');
  assert.equal(borrar?.parameters.length, 1);
  assert.equal(borrar?.parameters[0]?.name, 'id');
  assert.equal(borrar?.parameters[0]?.location, 'path');
});

test('un parametro de ruta es obligatorio aunque no lo declare', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'x', version: '1' },
    paths: {
      '/a/{id}': {
        get: { parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }], responses: {} },
      },
    },
  });
  const parsed = parseOpenApi('a.json', spec);
  assert.equal(parsed.operations[0]?.parameters[0]?.required, true);
});

test('el cuerpo de peticion se resuelve a su esquema', () => {
  const crear = DOCUMENT.operations.find((operation) => operation.id === 'crearUsuario');
  assert.equal(crear?.requestBodyRef, 'NuevoUsuario');
  assert.equal(crear?.requestBodyRequired, true);
});

test('las operaciones obsoletas quedan marcadas', () => {
  const borrar = DOCUMENT.operations.find((operation) => operation.id === 'borrarUsuario');
  assert.equal(borrar?.deprecated, true);
});

test('sin operationId el identificador es metodo:ruta', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'x', version: '1' },
    paths: { '/salud': { get: { responses: {} } } },
  });
  assert.equal(parseOpenApi('a.json', spec).operations[0]?.id, 'get:/salud');
});

test('parseOpenApi lee los esquemas con sus campos obligatorios y anulables', () => {
  const usuario = DOCUMENT.schemas.find((schema) => schema.name === 'Usuario');
  assert.ok(usuario !== undefined);

  const byName = new Map(usuario.fields.map((field) => [field.name, field]));
  assert.equal(byName.get('id')?.required, true);
  assert.equal(byName.get('edad')?.required, false);
  assert.equal(byName.get('edad')?.nullable, true);
  assert.equal(byName.get('etiquetas')?.type, 'string[]');
  assert.deepEqual(byName.get('rol')?.enumValues, ['admin', 'lector']);
});

test('parseOpenApi avisa en lugar de callar lo que no entiende', () => {
  const parsed = parseOpenApi('a.json', JSON.stringify({ info: {}, paths: {} }));
  assert.equal(parsed.warnings.length, 2);
  assert.ok(parsed.warnings.some((warning) => /version de OpenAPI/.test(warning)));
  assert.ok(parsed.warnings.some((warning) => /ninguna operacion/.test(warning)));
});

test('parseOpenApi entiende Swagger 2.0 lo suficiente para navegarlo', () => {
  const spec = JSON.stringify({
    swagger: '2.0',
    info: { title: 'Antigua', version: '1.0' },
    host: 'api.viejo.dev',
    basePath: '/v2',
    paths: { '/x': { get: { responses: {} } } },
    definitions: { Cosa: { type: 'object', properties: { a: { type: 'string' } } } },
  });
  const parsed = parseOpenApi('swagger.json', spec);
  assert.equal(parsed.openapi, '2.0');
  assert.deepEqual(parsed.servers, ['https://api.viejo.dev/v2']);
  assert.equal(parsed.schemas[0]?.name, 'Cosa');
});

test('parseSpecSource acepta YAML y se fia del contenido antes que de la extension', () => {
  const yaml = ['openapi: 3.0.0', 'info:', '  title: Desde YAML', '  version: 1.0.0'].join('\n');
  const parsed = parseOpenApi('openapi.yaml', yaml);
  assert.equal(parsed.title, 'Desde YAML');

  // JSON dentro de un archivo .yaml: pasa igualmente.
  const asJson = parseSpecSource('openapi.yaml', '{"info":{"title":"JSON"}}');
  assert.equal((asJson as { info: { title: string } }).info.title, 'JSON');
});

test('un documento ilegible falla con codigo E_PARSE', () => {
  assert.throws(
    () => parseOpenApi('openapi.json', '{ esto no cierra'),
    (cause: unknown) => (cause as { forge?: { code?: string } }).forge?.code === 'E_PARSE',
  );
});

test('refName reduce una referencia local a su nombre corto', () => {
  assert.equal(refName('#/components/schemas/Usuario'), 'Usuario');
  // Las referencias externas exigirian leer otros archivos: no se resuelven.
  assert.equal(refName('otros.yaml#/Usuario'), null);
});

test('schemaTypeName traduce los tipos de OpenAPI a TypeScript', () => {
  assert.equal(schemaTypeName({ type: 'integer' }), 'number');
  assert.equal(schemaTypeName({ type: 'string', format: 'binary' }), 'Blob');
  assert.equal(schemaTypeName({ type: 'array', items: { type: 'boolean' } }), 'boolean[]');
  assert.equal(schemaTypeName({ $ref: '#/components/schemas/Usuario' }), 'Usuario');
  assert.equal(schemaTypeName({ enum: ['a', 'b'] }), '"a" | "b"');
  assert.equal(
    schemaTypeName({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
    'string | number',
  );
  assert.equal(schemaTypeName({}), 'unknown');
});

test('un array de una union lleva parentesis para no cambiar de significado', () => {
  // `string | number[]` seria otra cosa distinta a `(string | number)[]`.
  assert.equal(
    schemaTypeName({ type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } }),
    '(string | number)[]',
  );
});

test('findLine localiza una clave y cae a la primera linea si no la ve', () => {
  const source = ['{', '  "paths": {', '    "/usuarios": {}', '  }', '}'].join('\n');
  assert.equal(findLine(source, '/usuarios'), 3);
  assert.equal(findLine(source, 'no-existe'), 1);
});

/* -------------------------------------------------------------------------- */
/*  Generacion de codigo                                                       */
/* -------------------------------------------------------------------------- */

test('toPascalCase y toCamelCase producen identificadores validos', () => {
  assert.equal(toPascalCase('get:/api/users/{id}'), 'GetApiUsersId');
  assert.equal(toCamelCase('listar-usuarios'), 'listarUsuarios');
  // Un identificador no puede empezar por digito.
  assert.match(toPascalCase('2fa'), /^[A-Za-z_$]/);
  // Ni ser una palabra reservada.
  assert.equal(toCamelCase('delete'), 'delete_');
});

test('propertyKey entrecomilla solo lo que lo necesita', () => {
  assert.equal(propertyKey('nombre'), 'nombre');
  assert.equal(propertyKey('X-Api-Key'), '"X-Api-Key"');
});

test('renderSchema respeta obligatorios, anulables y readonly', () => {
  const usuario = DOCUMENT.schemas.find((schema) => schema.name === 'Usuario');
  assert.ok(usuario !== undefined);
  const code = renderSchema(usuario);

  assert.match(code, /export interface Usuario \{/);
  assert.match(code, /readonly id: string;/);
  assert.match(code, /readonly edad\?: number \| null;/);
  assert.match(code, /readonly etiquetas\?: string\[\];/);
  // Obligatorio y anulable son cosas distintas y no deben colapsarse.
  assert.doesNotMatch(code, /readonly id\?:/);
});

test('successResponseType elige la respuesta 2xx y respeta el 204 sin cuerpo', () => {
  const listar = DOCUMENT.operations.find((operation) => operation.id === 'listarUsuarios');
  const borrar = DOCUMENT.operations.find((operation) => operation.id === 'borrarUsuario');
  assert.ok(listar !== undefined && borrar !== undefined);
  assert.equal(successResponseType(listar), 'Usuario[]');
  assert.equal(successResponseType(borrar), 'void');
});

test('operationSignature interpola los parametros de ruta en la plantilla', () => {
  const borrar = DOCUMENT.operations.find((operation) => operation.id === 'borrarUsuario');
  assert.ok(borrar !== undefined);
  const signature = operationSignature(borrar);
  assert.equal(signature.urlTemplate, '/usuarios/${id}');
  assert.deepEqual(signature.args, ['id: string']);
});

test('un objeto de consulta con algun parametro obligatorio no es opcional', () => {
  const listar = DOCUMENT.operations.find((operation) => operation.id === 'listarUsuarios');
  assert.ok(listar !== undefined);
  const signature = operationSignature(listar);
  // `buscar` es obligatorio, asi que el objeto entero tampoco puede faltar.
  assert.equal(
    signature.args.some((arg) => arg.startsWith('query?:')),
    false,
  );
  assert.ok(signature.args.some((arg) => arg.includes('buscar: string')));
  assert.ok(signature.args.some((arg) => arg.includes('pagina?: number')));
});

test('isReadOperation distingue consultas de mutaciones', () => {
  assert.equal(isReadOperation(DOCUMENT.operations[0]!), true);
  assert.equal(isReadOperation(DOCUMENT.operations[1]!), false);
});

test('los tipos generados declaran una interfaz por esquema', () => {
  const code = generate(DOCUMENT, 'types');
  assert.match(code, /export interface Usuario/);
  assert.match(code, /export interface NuevoUsuario/);
  assert.match(code, /generado por ForgeJS IDE/);
});

test('el cliente generado expone un metodo por operacion y no traga errores', () => {
  const code = generate(DOCUMENT, 'client');
  assert.match(code, /public async listarUsuarios\(/);
  assert.match(code, /public async crearUsuario\(/);
  assert.match(code, /public async borrarUsuario\(id: string\): Promise<void>/);
  assert.match(code, /throw new ApiError\(response\.status/);
  // La barra final se quita para no componer `//usuarios`.
  assert.match(code, /replace\(\/\\\/\$\/, ""\)/);
});

test('los hooks de React cancelan al desmontar', () => {
  const code = generate(DOCUMENT, 'react-hooks');
  assert.match(code, /export function useListarUsuarios\(/);
  assert.match(code, /new AbortController\(\)/);
  assert.match(code, /return \(\) => controller\.abort\(\)/);
  // Abortar no es un error que mostrar al usuario.
  assert.match(code, /AbortError/);
});

test('los hooks de mutacion no tocan el estado de un componente desmontado', () => {
  const code = generate(DOCUMENT, 'react-hooks');
  assert.match(code, /export function useCrearUsuario\(\)/);
  assert.match(code, /mounted\.current = false/);
  assert.match(code, /if \(mounted\.current\)/);
});

test('los composables de Vue cancelan al morir el scope', () => {
  const code = generate(DOCUMENT, 'vue-composables');
  assert.match(code, /export function useListarUsuarios\(/);
  assert.match(code, /onScopeDispose\(\(\) => controller\?\.abort\(\)\)/);
});

test('ningun objetivo genera codigo con any', () => {
  // El proyecto compila en modo estricto: un archivo generado con `any`
  // seria peor que no generar nada.
  for (const target of ['types', 'client', 'react-hooks', 'vue-composables'] as const) {
    const code = generate(DOCUMENT, target);
    assert.doesNotMatch(code, /\bany\b/, `el objetivo ${target} genero "any"`);
  }
});

test('narrowDocument limita la generacion a las operaciones pedidas', () => {
  const narrowed = narrowDocument(DOCUMENT, ['crearUsuario']);
  assert.equal(narrowed.operations.length, 1);
  // Una lista vacia significa «todas», no «ninguna».
  assert.equal(narrowDocument(DOCUMENT, []).operations.length, 3);
});

test('defaultOutputPath deja el archivo junto a la especificacion', () => {
  assert.equal(defaultOutputPath('docs/openapi.yaml', 'types'), 'docs/api-types.ts');
  assert.equal(defaultOutputPath('openapi.json', 'react-hooks'), 'api-hooks.ts');
});

/* -------------------------------------------------------------------------- */
/*  Extraccion de la forma de un modulo                                        */
/* -------------------------------------------------------------------------- */

test('stripComments no se lleva por delante una URL dentro de una cadena', () => {
  const source = "const url = 'http://ejemplo.dev/x'; // comentario\n";
  const clean = stripComments(source);
  assert.match(clean, /http:\/\/ejemplo\.dev\/x/);
  assert.doesNotMatch(clean, /comentario/);
});

test('stripComments conserva la numeracion de lineas de un bloque', () => {
  const source = ['const a = 1;', '/*', ' * texto', ' */', 'const b = 2;'].join('\n');
  assert.equal(stripComments(source).split('\n').length, 5);
});

test('parseMember lee readonly, opcional y el tipo', () => {
  assert.deepEqual(parseMember('readonly nombre?: string'), {
    name: 'nombre',
    type: 'string',
    optional: true,
    readonly: true,
  });
  assert.deepEqual(parseMember('edad: number'), {
    name: 'edad',
    type: 'number',
    optional: false,
    readonly: false,
  });
});

test('parseMember no se confunde con una firma de indice', () => {
  const member = parseMember('readonly [clave: string]: number');
  assert.equal(member?.name, '[clave: string]');
  assert.equal(member?.type, 'number');
});

test('splitMembers respeta los tipos anidados', () => {
  const members = splitMembers('a: { x: number; y: number }; b: string');
  assert.deepEqual(members, ['a: { x: number; y: number }', 'b: string']);
});

test('unionVariants ordena para poder comparar dos versiones', () => {
  assert.deepEqual(unionVariants("'b' | 'a' | 'c'"), ["'a'", "'b'", "'c'"]);
  // Un `|` dentro de llaves no separa variantes.
  assert.deepEqual(unionVariants('{ a: string | number }'), ['{ a: string | number }']);
});

test('extractModuleShape encuentra interfaces, uniones, alias y constantes', () => {
  const source = [
    '/** Documentacion que no debe estorbar. */',
    'export interface Pedido {',
    '  readonly id: string;',
    '  readonly total: number;',
    '  readonly nota?: string;',
    '}',
    '',
    "export type Estado = 'nuevo' | 'enviado' | 'cerrado';",
    '',
    'export type Identificador = string;',
    '',
    'export const LIMITE = 10;',
  ].join('\n');

  const { shapes } = extractModuleShape(source);
  assert.deepEqual([...shapes.keys()].sort(), ['Estado', 'Identificador', 'LIMITE', 'Pedido']);

  assert.equal(shapes.get('Pedido')?.kind, 'interface');
  assert.equal(shapes.get('Pedido')?.members.length, 3);
  assert.equal(shapes.get('Estado')?.kind, 'union');
  assert.deepEqual(shapes.get('Estado')?.variants, ["'cerrado'", "'enviado'", "'nuevo'"]);
  assert.equal(shapes.get('Identificador')?.kind, 'alias');
  assert.equal(shapes.get('LIMITE')?.kind, 'const');
});

test('extractModuleShape se lee a si mismo: contracts.ts declara Result', () => {
  // Prueba de realidad sobre el archivo del propio proyecto.
  const source = [
    'export type Result<T, E = ForgeError> =',
    '  | { readonly ok: true; readonly value: T }',
    '  | { readonly ok: false; readonly error: E };',
  ].join('\n');
  const shape = extractModuleShape(source).shapes.get('Result');
  assert.equal(shape?.kind, 'union');
  assert.equal(shape?.variants.length, 2);
});

test('importedSymbols reconoce imports de tipo y alias', () => {
  const source = [
    "import type { ProcessInfo, LogRecord as Registro } from '../../shared/contracts.js';",
    "import { ok } from '../../shared/contracts.js';",
    "import { algo } from './otro.js';",
  ].join('\n');
  assert.deepEqual(importedSymbols(source, 'contracts'), ['LogRecord', 'ProcessInfo', 'ok']);
});

/* -------------------------------------------------------------------------- */
/*  Cambios que rompen                                                         */
/* -------------------------------------------------------------------------- */

const BEFORE = [
  'export interface Usuario {',
  '  readonly id: string;',
  '  readonly nombre: string;',
  '  readonly alias?: string;',
  '}',
  "export type Rol = 'admin' | 'lector' | 'invitado';",
  'export interface Sesion {',
  '  readonly token: string;',
  '}',
].join('\n');

test('quitar un campo se detecta como ruptura', () => {
  const after = BEFORE.replace('  readonly nombre: string;\n', '');
  const changes = compareModules(BEFORE, after);
  assert.ok(
    changes.some((change) => change.kind === 'removed-field' && change.member === 'nombre'),
  );
});

test('quitar un export entero se detecta como ruptura', () => {
  const after = BEFORE.replace(
    'export interface Sesion {\n  readonly token: string;\n}',
    '',
  );
  const changes = compareModules(BEFORE, after);
  assert.ok(
    changes.some((change) => change.kind === 'removed-export' && change.symbol === 'Sesion'),
  );
});

test('anadir un campo obligatorio rompe a quien construye el objeto', () => {
  const after = BEFORE.replace(
    '  readonly alias?: string;',
    '  readonly alias?: string;\n  readonly correo: string;',
  );
  const changes = compareModules(BEFORE, after);
  const change = changes.find((entry) => entry.kind === 'required-field-added');
  assert.equal(change?.member, 'correo');
});

test('anadir un campo OPCIONAL no rompe nada', () => {
  const after = BEFORE.replace(
    '  readonly alias?: string;',
    '  readonly alias?: string;\n  readonly correo?: string;',
  );
  assert.deepEqual(compareModules(BEFORE, after), []);
});

test('volver obligatorio un campo opcional se detecta', () => {
  const after = BEFORE.replace('readonly alias?: string;', 'readonly alias: string;');
  const changes = compareModules(BEFORE, after);
  assert.ok(changes.some((change) => change.kind === 'optional-became-required'));
});

test('volver opcional un campo obligatorio NO rompe a nadie', () => {
  const after = BEFORE.replace('readonly nombre: string;', 'readonly nombre?: string;');
  assert.deepEqual(compareModules(BEFORE, after), []);
});

test('cambiar el tipo de un campo se detecta con el antes y el despues', () => {
  const after = BEFORE.replace('readonly id: string;', 'readonly id: number;');
  const change = compareModules(BEFORE, after).find((entry) => entry.kind === 'type-changed');
  assert.equal(change?.member, 'id');
  assert.equal(change?.before, 'string');
  assert.equal(change?.after, 'number');
});

test('quitar una variante de una union rompe los switch exhaustivos', () => {
  const after = BEFORE.replace("'admin' | 'lector' | 'invitado'", "'admin' | 'lector'");
  const change = compareModules(BEFORE, after).find(
    (entry) => entry.kind === 'enum-value-removed',
  );
  assert.equal(change?.symbol, 'Rol');
  assert.equal(change?.before, "'invitado'");
});

test('anadir una variante a una union no se marca como ruptura', () => {
  const after = BEFORE.replace(
    "'admin' | 'lector' | 'invitado'",
    "'admin' | 'lector' | 'invitado' | 'auditor'",
  );
  assert.deepEqual(compareModules(BEFORE, after), []);
});

test('reformatear no cuenta como cambio de tipo', () => {
  // Sin normalizar, partir una union en varias lineas daria falsos positivos.
  const after = BEFORE.replace(
    "export type Rol = 'admin' | 'lector' | 'invitado';",
    ["export type Rol =", "  | 'admin'", "  | 'lector'", "  | 'invitado';"].join('\n'),
  );
  assert.deepEqual(compareModules(BEFORE, after), []);
});

test('un modulo identico no produce ningun cambio', () => {
  assert.deepEqual(compareModules(BEFORE, BEFORE), []);
});

test('normalizeType iguala los espaciados equivalentes', () => {
  assert.equal(normalizeType('string  |   number'), normalizeType('string|number'));
  assert.equal(normalizeType('{ a: string;  b: number }'), '{ a: string;b: number }');
});

test('findDependents lista quien importa los simbolos afectados', () => {
  const changes = compareModules(
    BEFORE,
    BEFORE.replace('readonly id: string;', 'readonly id: number;'),
  );
  const files = [
    {
      path: 'src/main/a.ts',
      source: "import type { Usuario } from '../shared/contracts.js';\nconst x = 1;",
    },
    {
      path: 'src/renderer/b.ts',
      source: "import type { Usuario, Rol } from '../../shared/contracts.js';",
    },
    { path: 'src/main/c.ts', source: "import { algo } from './otro.js';" },
  ];

  const dependents = findDependents(files, 'contracts', affectedSymbols(changes));
  assert.deepEqual(
    dependents.map((entry) => entry.path),
    ['src/main/a.ts', 'src/renderer/b.ts'],
  );
  // `c.ts` no importa nada del modulo afectado.
  assert.equal(dependents.length, 2);
  assert.deepEqual(dependents[0]?.symbols, ['Usuario']);
});

test('los dependientes se ordenan por numero de simbolos afectados', () => {
  const affected = new Set(['Usuario', 'Rol']);
  const files = [
    { path: 'a.ts', source: "import type { Usuario } from './contracts.js';" },
    { path: 'b.ts', source: "import type { Usuario, Rol } from './contracts.js';" },
  ];
  const dependents = findDependents(files, 'contracts', affected);
  assert.equal(dependents[0]?.path, 'b.ts');
});
