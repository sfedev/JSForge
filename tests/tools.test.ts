/**
 * Pruebas de las herramientas integradas: parser `.http`, deteccion de
 * endpoints, YAML de docker-compose, esquema Prisma y comparacion de
 * versiones del actualizador.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectEndpoints,
  interpolate,
  parseHttpFile,
} from '../src/main/services/http/http-file-parser.js';
import {
  interpretCompose,
  kindFromImage,
  parseEnvironment,
  parsePorts,
  parseYaml,
} from '../src/main/services/docker/compose-parser.js';
import { parsePrismaSchema } from '../src/main/services/db/schema-inspector.js';
import { isNewerVersion } from '../src/main/services/updater/version.js';
import { parsePosixTime } from '../src/main/services/metrics/cpu-time.js';
import { parseEnvFile, isSecretKey, maskValue } from '../src/main/services/process/env-service.js';
import { detectPort, parseLogLine } from '../src/main/services/process/log-parser.js';

/* -------------------------------------------------------------------------- */
/*  Cliente HTTP                                                               */
/* -------------------------------------------------------------------------- */

const HTTP_SAMPLE = [
  '@baseUrl = http://localhost:4000',
  '@token = abc123',
  '',
  '### Listar usuarios',
  'GET {{baseUrl}}/api/users',
  'Authorization: Bearer {{token}}',
  '',
  '### Crear usuario',
  'POST {{baseUrl}}/api/users',
  'Content-Type: application/json',
  '',
  '{',
  '  "nombre": "Sergio"',
  '}',
  '',
].join('\n');

test('interpolate resuelve variables y respeta las desconocidas', () => {
  const variables = new Map([['host', 'localhost']]);
  assert.equal(interpolate('http://{{host}}/{{falta}}', variables), 'http://localhost/{{falta}}');
});

test('parseHttpFile lee nombre, metodo, URL, cabeceras y cuerpo', () => {
  const requests = parseHttpFile(HTTP_SAMPLE);
  assert.equal(requests.length, 2);

  assert.equal(requests[0]?.name, 'Listar usuarios');
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.url, 'http://localhost:4000/api/users');
  assert.equal(requests[0]?.headers['Authorization'], 'Bearer abc123');
  assert.equal(requests[0]?.body, undefined);

  assert.equal(requests[1]?.method, 'POST');
  assert.ok(requests[1]?.body?.includes('"nombre": "Sergio"'));
});

test('parseHttpFile ignora comentarios y lineas sueltas', () => {
  const requests = parseHttpFile('# comentario\n// otro\nGET http://localhost/x\n');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'http://localhost/x');
});

test('detectEndpoints reconoce rutas de Express', () => {
  const source = [
    "const router = express.Router();",
    "router.get('/usuarios', listar);",
    "app.post('/usuarios/:id', actualizar);",
  ].join('\n');
  const found = detectEndpoints('src/rutas.ts', source);
  assert.equal(found.length, 2);
  assert.equal(found[0]?.method, 'GET');
  assert.equal(found[0]?.route, '/usuarios');
  assert.equal(found[1]?.framework, 'express');
});

test('detectEndpoints compone la ruta de un controlador NestJS', () => {
  const source = [
    "@Controller('usuarios')",
    'export class UsuariosController {',
    "  @Get(':id')",
    '  buscar() {}',
    '  @Post()',
    '  crear() {}',
    '}',
  ].join('\n');
  const found = detectEndpoints('src/usuarios.controller.ts', source);
  assert.deepEqual(
    found.map((entry) => `${entry.method} ${entry.route}`),
    ['GET /usuarios/:id', 'POST /usuarios'],
  );
});

test('detectEndpoints deduce la ruta de un route.ts de Next', () => {
  const source = 'export async function GET() {}\nexport async function POST() {}';
  const found = detectEndpoints('app/api/(admin)/items/[id]/route.ts', source);
  assert.equal(found.length, 2);
  assert.equal(found[0]?.route, '/api/items/:id');
  assert.equal(found[0]?.framework, 'next');
});

/* -------------------------------------------------------------------------- */
/*  docker-compose                                                             */
/* -------------------------------------------------------------------------- */

const COMPOSE_SAMPLE = [
  '# base de datos del proyecto',
  "version: '3.9'",
  'services:',
  '  db:',
  '    image: postgres:16-alpine',
  '    ports:',
  '      - "5432:5432"',
  '    environment:',
  '      POSTGRES_PASSWORD: secreto',
  '      POSTGRES_DB: app',
  '    volumes:',
  '      - db-data:/var/lib/postgresql/data',
  '  cache:',
  '    image: redis:7',
  '    ports: [6379]',
  '    environment:',
  '      - REDIS_ARGS=--save 60 1',
  'volumes:',
  '  db-data:',
].join('\n');

test('parseYaml entiende mapas anidados, listas y comentarios', () => {
  const document = parseYaml(COMPOSE_SAMPLE) as Record<string, unknown>;
  assert.equal(document['version'], '3.9');
  const services = document['services'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(services), ['db', 'cache']);
});

test('interpretCompose extrae servicios, puertos y entorno', () => {
  const view = interpretCompose('docker-compose.yml', COMPOSE_SAMPLE);
  assert.equal(view.services.length, 2);

  const db = view.services[0];
  assert.equal(db?.name, 'db');
  assert.equal(db?.kind, 'postgres');
  assert.deepEqual(db?.ports, [{ host: 5432, container: 5432 }]);
  assert.equal(db?.environment['POSTGRES_DB'], 'app');
  assert.deepEqual(db?.volumes, ['db-data:/var/lib/postgresql/data']);

  const cache = view.services[1];
  assert.equal(cache?.kind, 'redis');
  assert.deepEqual(cache?.ports, [{ host: 6379, container: 6379 }]);
  assert.equal(cache?.environment['REDIS_ARGS'], '--save 60 1');
});

test('parsePorts admite las formas con IP y la extendida', () => {
  assert.deepEqual(parsePorts(['127.0.0.1:8080:80']), [{ host: 8080, container: 80 }]);
  assert.deepEqual(parsePorts(['3000:3000/tcp']), [{ host: 3000, container: 3000 }]);
  assert.deepEqual(parsePorts([{ published: 5433, target: 5432 }]), [{ host: 5433, container: 5432 }]);
});

test('parseEnvironment acepta mapa y lista', () => {
  assert.deepEqual(parseEnvironment({ A: 'uno' }), { A: 'uno' });
  assert.deepEqual(parseEnvironment(['B=dos', 'C']), { B: 'dos', C: '' });
});

test('kindFromImage clasifica las imagenes habituales', () => {
  assert.equal(kindFromImage('postgres:16'), 'postgres');
  assert.equal(kindFromImage('mongo:7'), 'mongo');
  assert.equal(kindFromImage('mariadb:11'), 'mysql');
  assert.equal(kindFromImage('nginx:alpine'), 'other');
  assert.equal(kindFromImage(undefined), 'other');
});

/* -------------------------------------------------------------------------- */
/*  Prisma                                                                     */
/* -------------------------------------------------------------------------- */

const PRISMA_SAMPLE = [
  'datasource db {',
  '  provider = "postgresql"',
  '  url      = env("DATABASE_URL")',
  '}',
  '',
  'enum Rol {',
  '  ADMIN',
  '  USUARIO',
  '}',
  '',
  'model Usuario {',
  '  id        Int      @id @default(autoincrement())',
  '  email     String   @unique',
  '  nombre    String?',
  '  rol       Rol      @default(USUARIO)',
  '  posts     Post[]',
  '}',
  '',
  'model Post {',
  '  id       Int    @id @default(autoincrement())',
  '  autor    Usuario @relation(fields: [autorId], references: [id])',
  '  autorId  Int',
  '}',
].join('\n');

test('parsePrismaSchema lee proveedor, modelos, enumerados y relaciones', () => {
  const schema = parsePrismaSchema('prisma/schema.prisma', PRISMA_SAMPLE);
  assert.equal(schema.provider, 'postgresql');
  assert.equal(schema.models.length, 2);
  assert.equal(schema.enums.length, 1);
  assert.deepEqual(schema.enums[0]?.values, ['ADMIN', 'USUARIO']);

  const usuario = schema.models[0];
  assert.equal(usuario?.name, 'Usuario');
  const id = usuario?.columns.find((column) => column.name === 'id');
  assert.equal(id?.primary, true);
  assert.equal(id?.defaultValue, 'autoincrement()');

  const email = usuario?.columns.find((column) => column.name === 'email');
  assert.equal(email?.unique, true);
  assert.equal(email?.nullable, false);

  const nombre = usuario?.columns.find((column) => column.name === 'nombre');
  assert.equal(nombre?.nullable, true);

  const posts = usuario?.columns.find((column) => column.name === 'posts');
  assert.equal(posts?.relation, 'Post');
});

/* -------------------------------------------------------------------------- */
/*  Entorno y registros                                                        */
/* -------------------------------------------------------------------------- */

test('parseEnvFile admite export, comillas y comentarios al final', () => {
  const parsed = parseEnvFile(
    [
      '# comentario',
      'export API_URL=http://localhost:3000 # sobra',
      'TOKEN="ab\\ncd"',
      "NOMBRE='Sergio Rayo'",
      'VACIO=',
      'no-valido',
    ].join('\n'),
  );
  assert.equal(parsed.get('API_URL'), 'http://localhost:3000');
  assert.equal(parsed.get('TOKEN'), 'ab\ncd');
  assert.equal(parsed.get('NOMBRE'), 'Sergio Rayo');
  assert.equal(parsed.get('VACIO'), '');
  assert.equal(parsed.has('no-valido'), false);
});

test('isSecretKey reconoce los nombres sensibles habituales', () => {
  for (const key of ['API_KEY', 'db_password', 'JWT_SECRET', 'SENTRY_DSN', 'DATABASE_URL']) {
    assert.equal(isSecretKey(key), true, `${key} deberia considerarse secreto`);
  }
  assert.equal(isSecretKey('NODE_ENV'), false);
  assert.equal(isSecretKey('PUERTO', ['PUERTO']), true, 'las claves declaradas mandan');
});

test('maskValue conserva los extremos solo si el valor es largo', () => {
  assert.equal(maskValue('abc'), '•••');
  assert.ok(maskValue('supersecreto123').startsWith('su'));
  assert.ok(maskValue('supersecreto123').endsWith('23'));
  assert.equal(maskValue(''), '');
});

test('parseLogLine entiende el JSON de pino', () => {
  const record = parseLogLine(
    '{"level":50,"time":1700000000000,"msg":"fallo la consulta","reqId":"a1"}',
    { processId: 'p', stream: 'stdout', format: 'auto', seq: 1, resolveFrame: () => null },
  );
  assert.equal(record.level, 'error');
  assert.equal(record.message, 'fallo la consulta');
  assert.equal(record.fields?.['reqId'], 'a1');
  assert.equal(record.time, 1700000000000);
});

test('parseLogLine entiende una linea de Morgan', () => {
  const record = parseLogLine('GET /api/users 200 12.4 ms', {
    processId: 'p',
    stream: 'stdout',
    format: 'auto',
    seq: 1,
    resolveFrame: () => null,
  });
  assert.equal(record.level, 'info');
  assert.equal(record.fields?.['status'], '200');

  const error = parseLogLine('POST /api/users 500 3.1 ms', {
    processId: 'p',
    stream: 'stdout',
    format: 'auto',
    seq: 2,
    resolveFrame: () => null,
  });
  assert.equal(error.level, 'error');
});

test('parseLogLine resuelve los marcos de pila del workspace', () => {
  const record = parseLogLine('    at handler (src/api/users.ts:42:11)', {
    processId: 'p',
    stream: 'stderr',
    format: 'plain',
    seq: 1,
    resolveFrame: (candidate) => (candidate.startsWith('src/') ? candidate : null),
  });
  assert.equal(record.frames?.[0]?.path, 'src/api/users.ts');
  assert.equal(record.frames?.[0]?.line, 42);
  assert.equal(record.frames?.[0]?.inWorkspace, true);
});

test('detectPort encuentra el puerto en los arranques habituales', () => {
  assert.equal(detectPort('  ➜  Local:   http://localhost:5173/'), 5173);
  assert.equal(detectPort('Server listening on port 3000'), 3000);
  assert.equal(detectPort('Application is running on: http://[::1]:4000'), 4000);
  assert.equal(detectPort('sin puerto aqui'), null);
});

/* -------------------------------------------------------------------------- */
/*  Actualizador y metricas                                                    */
/* -------------------------------------------------------------------------- */

test('isNewerVersion compara por componentes, no por texto', () => {
  assert.equal(isNewerVersion('0.2.0', '0.1.9'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true, '10 es mayor que 9');
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('0.9.0', '1.0.0'), false);
  assert.equal(isNewerVersion('v1.2.3-beta.1', '1.2.2'), true);
});

test('parsePosixTime convierte el formato de ps a milisegundos', () => {
  assert.equal(parsePosixTime('00:00:10'), 10_000);
  assert.equal(parsePosixTime('01:02:03'), (3600 + 123) * 1000);
  assert.equal(parsePosixTime('2-00:00:00'), 2 * 24 * 3600 * 1000);
});
