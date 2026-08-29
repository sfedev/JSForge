/**
 * Pruebas del ejecutor integrado: localizacion de bloques, lectura de los
 * informes de Vitest, Jest, Playwright y TAP, y analisis de cobertura.
 *
 * El localizador de bloques es la pieza delicada: trabaja sobre texto, y un
 * `it(` dentro de un comentario o de una cadena aparecia como prueba
 * ejecutable si no se enmascara antes lo que no es codigo.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blankNonCode,
  flattenBlocks,
  isTestFile,
  isValidQualifier,
  parseTestBlocks,
  readTitle,
} from '../src/main/services/testing/test-parser.js';
import {
  aggregateStatus,
  locateFailure,
  normalizeStatus,
  parseTap,
  parseTestReport,
} from '../src/main/services/testing/result-parser.js';
import {
  buildCoverageReport,
  parseIstanbulCoverage,
  parseLcov,
  percentage,
} from '../src/main/services/testing/coverage.js';
import {
  buildRunnerCommand,
  detectRunners,
  preferredRunner,
} from '../src/main/services/testing/runner-detect.js';

/** Las rutas ya vienen relativas en estas pruebas. */
const identity = (value: string): string => value;

/* -------------------------------------------------------------------------- */
/*  Reconocimiento de archivos                                                 */
/* -------------------------------------------------------------------------- */

test('isTestFile reconoce las convenciones habituales', () => {
  for (const path of [
    'src/a.test.ts',
    'src/a.spec.ts',
    'src/a.test.tsx',
    'e2e/login.spec.js',
    'x.test.mts',
  ]) {
    assert.equal(isTestFile(path), true, path);
  }
  for (const path of ['src/a.ts', 'src/testing.ts', 'src/spec.ts', 'contest.ts']) {
    assert.equal(isTestFile(path), false, path);
  }
});

/* -------------------------------------------------------------------------- */
/*  Enmascarado de lo que no es codigo                                         */
/* -------------------------------------------------------------------------- */

test('blankNonCode borra comentarios pero conserva las lineas', () => {
  const source = ['const a = 1; // it("falso")', '/* it("otro") */', 'const b = 2;'].join('\n');
  const masked = blankNonCode(source);
  assert.equal(masked.split('\n').length, 3);
  assert.doesNotMatch(masked, /falso/);
  assert.doesNotMatch(masked, /otro/);
  assert.match(masked, /const a = 1;/);
});

test('blankNonCode no confunde una division con una expresion regular', () => {
  const source = 'const mitad = total / 2; const r = /it\\(/;';
  const masked = blankNonCode(source);
  assert.match(masked, /const mitad = total \/ 2;/);
  // La regex si se enmascara.
  assert.doesNotMatch(masked, /it\\\(/);
});

test('blankNonCode maneja plantillas con interpolacion anidada', () => {
  const source = 'const x = `a ${ `b ${c}` } d`; const y = 1;';
  const masked = blankNonCode(source);
  assert.match(masked, /const y = 1;/);
  assert.doesNotMatch(masked, /b \$\{c\}/);
});

/* -------------------------------------------------------------------------- */
/*  Localizacion de bloques                                                    */
/* -------------------------------------------------------------------------- */

const SUITE = [
  "import { describe, it, expect } from 'vitest';",
  '',
  "describe('Carrito', () => {",
  "  it('empieza vacio', () => {",
  '    expect(carrito.total).toBe(0);',
  '  });',
  '',
  "  describe('al anadir', () => {",
  "    it('suma el precio', () => {",
  '      expect(carrito.total).toBe(10);',
  '    });',
  '',
  "    it.skip('aplica descuentos', () => {});",
  '  });',
  '});',
  '',
  "test('caso suelto', () => {});",
].join('\n');

const BLOCKS = parseTestBlocks('src/carrito.test.ts', SUITE);

test('parseTestBlocks encuentra las suites de primer nivel', () => {
  assert.deepEqual(
    BLOCKS.map((block) => block.name),
    ['Carrito', 'caso suelto'],
  );
  assert.equal(BLOCKS[0]?.kind, 'suite');
  assert.equal(BLOCKS[1]?.kind, 'case');
});

test('el anidamiento refleja la estructura del archivo', () => {
  const carrito = BLOCKS[0];
  assert.equal(carrito?.children.length, 2);
  assert.equal(carrito?.children[0]?.name, 'empieza vacio');

  const anadir = carrito?.children[1];
  assert.equal(anadir?.name, 'al anadir');
  assert.equal(anadir?.children.length, 2);
  assert.equal(anadir?.children[0]?.name, 'suma el precio');
});

test('el nombre completo es el que los runners filtran con -t', () => {
  const anidada = BLOCKS[0]?.children[1]?.children[0];
  assert.equal(anidada?.fullName, 'Carrito > al anadir > suma el precio');
});

test('las lineas apuntan al bloque, contando desde 1', () => {
  assert.equal(BLOCKS[0]?.line, 3);
  assert.equal(BLOCKS[0]?.children[0]?.line, 4);
});

test('los modificadores se conservan', () => {
  const saltada = BLOCKS[0]?.children[1]?.children[1];
  assert.equal(saltada?.modifier, 'skip');
  assert.equal(BLOCKS[0]?.modifier, 'none');
});

test('un it comentado NO aparece como prueba', () => {
  const source = [
    "describe('grupo', () => {",
    "  // it('desactivada por ahora', () => {});",
    "  /* it('tambien desactivada', () => {}); */",
    "  it('la unica viva', () => {});",
    '});',
  ].join('\n');
  const blocks = parseTestBlocks('a.test.ts', source);
  assert.deepEqual(
    flattenBlocks(blocks).map((block) => block.name),
    ['grupo', 'la unica viva'],
  );
});

test('un it dentro de una cadena NO aparece como prueba', () => {
  const source = [
    "describe('grupo', () => {",
    "  const ejemplo = \"it('esto es texto', () => {})\";",
    "  it('real', () => {});",
    '});',
  ].join('\n');
  assert.deepEqual(
    flattenBlocks(parseTestBlocks('a.test.ts', source)).map((block) => block.name),
    ['grupo', 'real'],
  );
});

test('una llamada cualificada como objeto.test( no se cuenta', () => {
  const source = ["mock.test('no es una prueba', () => {});", "it('si lo es', () => {});"].join(
    '\n',
  );
  assert.deepEqual(
    parseTestBlocks('a.test.ts', source).map((block) => block.name),
    ['si lo es'],
  );
});

test('pero test.describe SI se cuenta: el objeto es un global del framework', () => {
  // Rechazar todo lo que llevara un punto delante se cargaba las suites de
  // Playwright enteras.
  assert.equal(isValidQualifier("test.describe(", 5), true);
  assert.equal(isValidQualifier("describe.each(", 9), true);
  assert.equal(isValidQualifier("mock.test(", 5), false);
  assert.equal(isValidQualifier("it(", 0), true);
});

test('un titulo calculado se descarta en vez de inventarse', () => {
  // Sin ejecutar no se puede saber que dice `nombre`.
  const source = ["it(nombre, () => {});", "it('literal', () => {});"].join('\n');
  assert.deepEqual(
    parseTestBlocks('a.test.ts', source).map((block) => block.name),
    ['literal'],
  );
});

test('readTitle entiende comillas simples, dobles y plantillas', () => {
  assert.equal(readTitle("it('con simples')", 2), 'con simples');
  assert.equal(readTitle('it("con dobles")', 2), 'con dobles');
  assert.equal(readTitle('it(`con plantilla`)', 2), 'con plantilla');
  assert.equal(readTitle("it('escapa \\'esto\\'')", 2), "escapa 'esto'");
});

test('las pruebas de Playwright con test.describe se localizan igual', () => {
  const source = [
    "import { test, expect } from '@playwright/test';",
    '',
    "test.describe('Login', () => {",
    "  test('entra con credenciales validas', async ({ page }) => {",
    '    await page.goto("/");',
    '  });',
    '});',
  ].join('\n');
  const blocks = parseTestBlocks('e2e/login.spec.ts', source);
  assert.equal(blocks[0]?.name, 'Login');
  assert.equal(blocks[0]?.children[0]?.name, 'entra con credenciales validas');
});

/* -------------------------------------------------------------------------- */
/*  Estados                                                                    */
/* -------------------------------------------------------------------------- */

test('normalizeStatus unifica los vocabularios de los tres runners', () => {
  assert.equal(normalizeStatus('passed'), 'passed');
  assert.equal(normalizeStatus('expected'), 'passed');
  assert.equal(normalizeStatus('unexpected'), 'failed');
  assert.equal(normalizeStatus('timedOut'), 'failed');
  assert.equal(normalizeStatus('pending'), 'skipped');
  assert.equal(normalizeStatus('lo-que-sea'), 'pending');
});

test('basta un fallo para que el conjunto falle', () => {
  assert.equal(aggregateStatus(['passed', 'failed', 'skipped']), 'failed');
  assert.equal(aggregateStatus(['passed', 'skipped']), 'passed');
  assert.equal(aggregateStatus(['skipped', 'skipped']), 'skipped');
  assert.equal(aggregateStatus([]), 'pending');
});

/* -------------------------------------------------------------------------- */
/*  Localizacion del fallo                                                     */
/* -------------------------------------------------------------------------- */

test('locateFailure salta los marcos de node_modules y de Node', () => {
  const message = [
    'AssertionError: esperaba 1',
    '    at Object.equal (node:assert:120:5)',
    '    at /proyecto/node_modules/vitest/dist/chunk.js:44:9',
    '    at /proyecto/src/carrito.test.ts:12:5',
  ].join('\n');
  const location = locateFailure(message);
  assert.equal(location?.path, '/proyecto/src/carrito.test.ts');
  assert.equal(location?.line, 12);
  assert.equal(location?.column, 5);
});

test('locateFailure entiende las rutas de Windows', () => {
  const location = locateFailure('    at C:\\Git\\proyecto\\src\\a.test.ts:7:3');
  assert.equal(location?.path, 'C:\\Git\\proyecto\\src\\a.test.ts');
  assert.equal(location?.line, 7);
});

test('locateFailure devuelve null si no hay ningun marco util', () => {
  assert.equal(locateFailure('Error sin traza'), null);
  assert.equal(locateFailure('    at node:internal/main/run:12:3'), null);
});

/* -------------------------------------------------------------------------- */
/*  Informe de Vitest y Jest                                                   */
/* -------------------------------------------------------------------------- */

const VITEST_REPORT = JSON.stringify({
  numTotalTests: 3,
  startTime: 1_700_000_000_000,
  testResults: [
    {
      name: 'src/carrito.test.ts',
      perfStats: { start: 1_700_000_000_000, end: 1_700_000_000_450 },
      assertionResults: [
        { title: 'empieza vacio', fullName: 'Carrito > empieza vacio', status: 'passed', duration: 5 },
        {
          title: 'suma el precio',
          fullName: 'Carrito > suma el precio',
          status: 'failed',
          duration: 12,
          failureMessages: ['AssertionError: esperaba 10\n    at src/carrito.test.ts:9:7'],
        },
        { title: 'pendiente', fullName: 'Carrito > pendiente', status: 'pending', duration: 0 },
      ],
    },
  ],
});

test('el informe de Vitest se normaliza con sus totales', () => {
  const summary = parseTestReport('r1', 'vitest', VITEST_REPORT, identity);
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0]?.durationMs, 450);
});

test('el fallo trae el archivo y la linea para saltar al codigo', () => {
  const summary = parseTestReport('r1', 'vitest', VITEST_REPORT, identity);
  const fallo = summary.files[0]?.cases.find((entry) => entry.status === 'failed');
  assert.equal(fallo?.failurePath, 'src/carrito.test.ts');
  assert.equal(fallo?.failureLine, 9);
  assert.match(fallo?.message ?? '', /esperaba 10/);
});

test('un archivo que no se pudo cargar cuenta como fallo, no como cero pruebas', () => {
  // Sin esto, un error de importacion pareceria un exito silencioso.
  const report = JSON.stringify({
    testResults: [
      {
        name: 'src/roto.test.ts',
        message: "Cannot find module './falta.js'\n    at src/roto.test.ts:1:1",
        assertionResults: [],
      },
    ],
  });
  const summary = parseTestReport('r2', 'vitest', report, identity);
  assert.equal(summary.failed, 1);
  assert.equal(summary.status, 'failed');
  assert.match(summary.files[0]?.cases[0]?.message ?? '', /Cannot find module/);
});

test('un informe ilegible falla con codigo E_PARSE', () => {
  assert.throws(
    () => parseTestReport('r3', 'vitest', 'no soy json', identity),
    (cause: unknown) => (cause as { forge?: { code?: string } }).forge?.code === 'E_PARSE',
  );
});

/* -------------------------------------------------------------------------- */
/*  Informe de Playwright                                                      */
/* -------------------------------------------------------------------------- */

const PLAYWRIGHT_REPORT = JSON.stringify({
  suites: [
    {
      title: 'login.spec.ts',
      suites: [
        {
          title: 'Login',
          specs: [
            {
              title: 'entra con credenciales validas',
              file: 'e2e/login.spec.ts',
              line: 4,
              tests: [{ results: [{ status: 'expected', duration: 820 }] }],
            },
            {
              title: 'rechaza una contrasena mala',
              file: 'e2e/login.spec.ts',
              line: 12,
              tests: [
                {
                  results: [
                    { status: 'unexpected', duration: 300, error: { message: 'x' } },
                    // Reintento: vale el ultimo.
                    { status: 'expected', duration: 250 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

test('el informe de Playwright se normaliza al mismo arbol', () => {
  const summary = parseTestReport('r4', 'playwright', PLAYWRIGHT_REPORT, identity);
  assert.equal(summary.total, 2);
  assert.equal(summary.files[0]?.path, 'e2e/login.spec.ts');
});

test('con reintentos vale el ultimo intento', () => {
  const summary = parseTestReport('r4', 'playwright', PLAYWRIGHT_REPORT, identity);
  const reintentada = summary.files[0]?.cases.find(
    (entry) => entry.name === 'rechaza una contrasena mala',
  );
  assert.equal(reintentada?.status, 'passed');
  assert.equal(summary.status, 'passed');
});

test('las suites anidadas de Playwright componen el nombre completo', () => {
  const summary = parseTestReport('r4', 'playwright', PLAYWRIGHT_REPORT, identity);
  assert.equal(
    summary.files[0]?.cases[0]?.fullName,
    'login.spec.ts > Login > entra con credenciales validas',
  );
});

/* -------------------------------------------------------------------------- */
/*  TAP del runner nativo de Node                                              */
/* -------------------------------------------------------------------------- */

test('parseTap lee ok, not ok y las directivas', () => {
  const output = [
    'TAP version 13',
    'ok 1 - suma bien',
    '  ---',
    '  duration_ms: 1.5',
    '  ...',
    'not ok 2 - resta mal',
    '  ---',
    '  duration_ms: 0.8',
    "  error: 'esperaba 3'",
    '  stack: at tests/a.test.ts:14:5',
    '  ...',
    'ok 3 - pendiente # SKIP',
    '1..3',
  ].join('\n');

  const summary = parseTap('r5', output, 'tests/a.test.ts', identity);
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.status, 'failed');

  const fallo = summary.files[0]?.cases[1];
  assert.equal(fallo?.name, 'resta mal');
  assert.equal(fallo?.message, 'esperaba 3');
  assert.equal(fallo?.failureLine, 14);
});

test('parseTap sobre una salida sin pruebas no inventa archivos', () => {
  const summary = parseTap('r6', 'TAP version 13\n1..0', 'tests/a.test.ts', identity);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.files, []);
});

/* -------------------------------------------------------------------------- */
/*  Cobertura                                                                  */
/* -------------------------------------------------------------------------- */

test('percentage evita dividir por cero', () => {
  assert.equal(percentage(0, 0), 100);
  assert.equal(percentage(1, 3), 33.3);
});

const ISTANBUL = JSON.stringify({
  'src/a.ts': {
    statementMap: {
      '0': { start: { line: 1 }, end: { line: 1 } },
      '1': { start: { line: 2 }, end: { line: 2 } },
      '2': { start: { line: 5 }, end: { line: 5 } },
    },
    s: { '0': 3, '1': 0, '2': 1 },
    b: { '0': [2, 0] },
  },
});

test('parseIstanbulCoverage separa lineas cubiertas de descubiertas', () => {
  const [file] = parseIstanbulCoverage(ISTANBUL, identity);
  assert.equal(file?.path, 'src/a.ts');
  assert.deepEqual(file?.coveredLines, [1, 5]);
  assert.deepEqual(file?.uncoveredLines, [2]);
  assert.equal(file?.statementsCovered, 2);
  assert.equal(file?.statementsTotal, 3);
  assert.equal(file?.branchesCovered, 1);
  assert.equal(file?.branchesTotal, 2);
});

test('una linea con varias sentencias, alguna ejecutada, cuenta como cubierta', () => {
  const json = JSON.stringify({
    'src/b.ts': {
      statementMap: {
        '0': { start: { line: 7 } },
        '1': { start: { line: 7 } },
      },
      s: { '0': 1, '1': 0 },
      b: {},
    },
  });
  const [file] = parseIstanbulCoverage(json, identity);
  assert.deepEqual(file?.coveredLines, [7]);
  assert.deepEqual(file?.uncoveredLines, []);
});

test('parseIstanbulCoverage devuelve vacio ante un JSON roto en vez de lanzar', () => {
  assert.deepEqual(parseIstanbulCoverage('{roto', identity), []);
});

test('parseLcov lee DA y BRDA', () => {
  const lcov = [
    'TN:',
    'SF:src/a.ts',
    'DA:1,3',
    'DA:2,0',
    'DA:5,1',
    'BRDA:3,0,0,2',
    'BRDA:3,0,1,-',
    'end_of_record',
  ].join('\n');

  const [file] = parseLcov(lcov, identity);
  assert.equal(file?.path, 'src/a.ts');
  assert.deepEqual(file?.coveredLines, [1, 5]);
  assert.deepEqual(file?.uncoveredLines, [2]);
  // `-` significa que la rama ni se alcanzo.
  assert.equal(file?.branchesCovered, 1);
  assert.equal(file?.branchesTotal, 2);
});

test('parseLcov cierra el archivo anterior si falta end_of_record', () => {
  const lcov = ['SF:a.ts', 'DA:1,1', 'SF:b.ts', 'DA:1,0', 'end_of_record'].join('\n');
  const files = parseLcov(lcov, identity);
  assert.deepEqual(
    files.map((file) => file.path),
    ['a.ts', 'b.ts'],
  );
});

test('el porcentaje global pesa por sentencias, no promedia archivos', () => {
  // Un archivo de 1 linea al 0% y otro de 99 al 100% dan 99%, no 50%.
  const report = buildCoverageReport(
    [
      {
        path: 'pequeno.ts',
        coveredLines: [],
        uncoveredLines: [1],
        statementsCovered: 0,
        statementsTotal: 1,
        branchesCovered: 0,
        branchesTotal: 0,
        percent: 0,
      },
      {
        path: 'grande.ts',
        coveredLines: [],
        uncoveredLines: [],
        statementsCovered: 99,
        statementsTotal: 99,
        branchesCovered: 0,
        branchesTotal: 0,
        percent: 100,
      },
    ],
    0,
  );
  assert.equal(report.percent, 99);
  assert.equal(report.statementsTotal, 100);
});

/* -------------------------------------------------------------------------- */
/*  Deteccion del ejecutor                                                     */
/* -------------------------------------------------------------------------- */

test('detectRunners reconoce por dependencia y por archivo de configuracion', () => {
  assert.deepEqual(detectRunners(['vitest'], []), ['vitest', 'node']);
  assert.deepEqual(detectRunners([], ['playwright.config.ts']), ['playwright', 'node']);
  assert.deepEqual(detectRunners(['@playwright/test', 'vitest'], []), [
    'vitest',
    'playwright',
    'node',
  ]);
});

test('el runner de Node siempre esta disponible como ultima opcion', () => {
  const runners = detectRunners([], []);
  assert.deepEqual(runners, ['node']);
  assert.equal(preferredRunner(runners), 'node');
  assert.equal(preferredRunner([]), 'node');
});

test('la invocacion de vitest pide el informe a un archivo, no a stdout', () => {
  // Los runners mezclan avisos y barras de progreso con el JSON.
  const command = buildRunnerCommand('vitest', 'npm', { runId: 'r' });
  assert.equal(command.command, 'npx');
  assert.ok(command.args.includes('--reporter=json'));
  assert.ok(command.args.some((arg) => arg.startsWith('--outputFile=')));
  assert.ok(command.reportPath.endsWith('.json'));
});

test('npx se invoca con --no-install para que una errata no descargue nada', () => {
  const command = buildRunnerCommand('vitest', 'npm', { runId: 'r' });
  assert.ok(command.args.includes('--no-install'));
});

test('cada gestor usa su propio ejecutor de binarios locales', () => {
  assert.equal(buildRunnerCommand('vitest', 'pnpm', { runId: 'r' }).command, 'pnpm');
  assert.equal(buildRunnerCommand('vitest', 'yarn', { runId: 'r' }).command, 'yarn');
  assert.equal(buildRunnerCommand('vitest', 'bun', { runId: 'r' }).command, 'bun');
});

test('el filtro por nombre y por archivo llega al ejecutor', () => {
  const command = buildRunnerCommand('vitest', 'npm', {
    runId: 'r',
    path: 'src/a.test.ts',
    testName: 'Carrito > suma',
  });
  assert.ok(command.args.includes('src/a.test.ts'));
  const index = command.args.indexOf('-t');
  assert.notEqual(index, -1);
  assert.equal(command.args[index + 1], 'Carrito > suma');
});

test('Playwright dirige su informe por variable de entorno', () => {
  // No tiene `--outputFile`.
  const command = buildRunnerCommand('playwright', 'npm', { runId: 'r' });
  assert.equal(command.env['PLAYWRIGHT_JSON_OUTPUT_NAME'], command.reportPath);
  assert.ok(command.args.includes('--reporter=json'));
});

test('Jest usa --runTestsByPath para una ruta exacta', () => {
  // El positional de Jest es un patron, no una ruta.
  const command = buildRunnerCommand('jest', 'npm', { runId: 'r', path: 'src/a.test.ts' });
  assert.ok(command.args.includes('--runTestsByPath'));
});

test('el runner de Node usa su reportero TAP', () => {
  const command = buildRunnerCommand('node', 'npm', { runId: 'r', testName: 'algo' });
  assert.equal(command.command, 'node');
  assert.ok(command.args.includes('--test-reporter=tap'));
  assert.ok(command.args.includes('--test-name-pattern'));
});

test('la cobertura se pide bajo node_modules, que ya esta ignorado por Git', () => {
  const command = buildRunnerCommand('vitest', 'npm', { runId: 'r', coverage: true });
  assert.ok(command.args.includes('--coverage'));
  assert.ok(
    command.args.some((arg) => arg.includes('node_modules/.forge/coverage')),
    'el informe no debe ensuciar el estado del repositorio',
  );
});
