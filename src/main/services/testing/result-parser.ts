/**
 * Lectura de los informes de Vitest, Jest y Playwright.
 *
 * Los tres emiten JSON, pero con formas distintas:
 *
 *  - Vitest y Jest comparten el formato «jest json»: `testResults[]` por
 *    archivo, con `assertionResults[]` dentro.
 *  - Playwright anida `suites[] > specs[] > tests[] > results[]`, y las
 *    suites pueden anidarse entre si.
 *
 * Ambas se normalizan al mismo arbol para que la vista no sepa cual corrio.
 * Todo aqui es puro: entra el JSON en texto, sale el resumen.
 */

import type {
  TestCaseResult,
  TestFileResult,
  TestRunSummary,
  TestRunnerId,
  TestStatus,
} from '../../../shared/contracts.js';

type Record_ = Record<string, unknown>;

function asRecord(value: unknown): Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record_)
    : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/*  Estados                                                                    */
/* -------------------------------------------------------------------------- */

const STATUS_MAP: Readonly<Record<string, TestStatus>> = {
  passed: 'passed',
  pass: 'passed',
  expected: 'passed',
  failed: 'failed',
  fail: 'failed',
  unexpected: 'failed',
  timedOut: 'failed',
  interrupted: 'failed',
  skipped: 'skipped',
  pending: 'skipped',
  todo: 'skipped',
  disabled: 'skipped',
  flaky: 'passed',
};

export function normalizeStatus(raw: string): TestStatus {
  return STATUS_MAP[raw] ?? 'pending';
}

/** Estado agregado: basta un fallo para que el conjunto falle. */
export function aggregateStatus(statuses: readonly TestStatus[]): TestStatus {
  if (statuses.some((status) => status === 'failed')) {
    return 'failed';
  }
  if (statuses.some((status) => status === 'passed')) {
    return 'passed';
  }
  // Todo saltado (o vacio): no es un exito, pero tampoco un fallo.
  return statuses.length === 0 ? 'pending' : 'skipped';
}

/* -------------------------------------------------------------------------- */
/*  Localizacion del fallo                                                     */
/* -------------------------------------------------------------------------- */

export interface FailureLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Primera linea del mensaje de error que apunta a un archivo del proyecto.
 *
 * Se descartan los marcos de `node_modules` y los internos de Node: lo que
 * el usuario quiere al pulsar el error es su propio codigo, no el interior
 * del framework de aserciones.
 */
export function locateFailure(message: string): FailureLocation | null {
  // Formatos habituales: `at fn (/ruta/a.ts:12:5)` y `/ruta/a.ts:12:5`.
  const pattern = /(?:\(|\s|^)([A-Za-z]:[\\/][^\s():]+|\/[^\s():]+|[.\w][^\s():]*\.[cm]?[jt]sx?):(\d+):(\d+)/g;

  for (let match = pattern.exec(message); match !== null; match = pattern.exec(message)) {
    const path = match[1] ?? '';
    if (path.includes('node_modules') || path.startsWith('node:') || path.includes('internal/')) {
      continue;
    }
    return {
      path,
      line: Number.parseInt(match[2] ?? '1', 10),
      column: Number.parseInt(match[3] ?? '1', 10),
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Formato de Vitest y Jest                                                   */
/* -------------------------------------------------------------------------- */

function parseJestLike(
  document: Record_,
  toRelative: (absolute: string) => string,
): TestFileResult[] {
  const files: TestFileResult[] = [];

  for (const entry of asArray(document['testResults'])) {
    const fileNode = asRecord(entry);
    const absolute = asString(fileNode['name']) || asString(fileNode['testFilePath']);
    const path = toRelative(absolute);

    const cases: TestCaseResult[] = [];
    for (const assertion of asArray(fileNode['assertionResults'])) {
      const node = asRecord(assertion);
      const name = asString(node['title'], asString(node['fullName'], 'sin nombre'));
      const fullName = asString(node['fullName'], name);
      const messages = asArray(node['failureMessages'])
        .map((message) => asString(message))
        .filter((message) => message !== '');
      const message = messages.join('\n');
      const location = message === '' ? null : locateFailure(message);

      cases.push({
        id: `${path}::${fullName}`,
        name,
        fullName,
        path,
        status: normalizeStatus(asString(node['status'], 'pending')),
        durationMs: asNumber(node['duration']),
        ...(message === '' ? {} : { message }),
        ...(location === null
          ? {}
          : { failurePath: toRelative(location.path), failureLine: location.line }),
      });
    }

    // Un archivo que ni siquiera se pudo cargar no trae aserciones, pero si
    // un mensaje: sin esto, un error de importacion se veria como «0 pruebas»
    // y pareceria que todo fue bien.
    const loadFailure = asString(fileNode['message']);
    if (cases.length === 0 && loadFailure !== '') {
      const location = locateFailure(loadFailure);
      cases.push({
        id: `${path}::<carga>`,
        name: 'No se pudo cargar el archivo',
        fullName: 'No se pudo cargar el archivo',
        path,
        status: 'failed',
        durationMs: 0,
        message: loadFailure,
        ...(location === null
          ? {}
          : { failurePath: toRelative(location.path), failureLine: location.line }),
      });
    }

    const startedAt = asNumber(asRecord(fileNode['perfStats'])['start']);
    const endedAt = asNumber(asRecord(fileNode['perfStats'])['end']);

    files.push({
      path,
      status: aggregateStatus(cases.map((entry_) => entry_.status)),
      durationMs: endedAt > startedAt ? endedAt - startedAt : 0,
      cases,
    });
  }

  return files;
}

/* -------------------------------------------------------------------------- */
/*  Formato de Playwright                                                      */
/* -------------------------------------------------------------------------- */

function parsePlaywright(
  document: Record_,
  toRelative: (absolute: string) => string,
): TestFileResult[] {
  const byFile = new Map<string, TestCaseResult[]>();

  /** Las suites de Playwright se anidan; se recorren en profundidad. */
  const visitSuite = (suite: Record_, titles: readonly string[]): void => {
    const title = asString(suite['title']);
    const trail = title === '' ? titles : [...titles, title];

    for (const specEntry of asArray(suite['specs'])) {
      const spec = asRecord(specEntry);
      const specTitle = asString(spec['title'], 'sin nombre');
      // `file` viene relativo al `testDir`, que ya cuelga del workspace.
      const path = toRelative(asString(spec['file']));
      const fullName = [...trail, specTitle].filter((part) => part !== '').join(' > ');

      for (const testEntry of asArray(spec['tests'])) {
        const testNode = asRecord(testEntry);
        const results = asArray(testNode['results']);
        // Se toma el ultimo intento: con reintentos, el que vale es el final.
        const last = asRecord(results[results.length - 1]);
        const errorMessage = asString(asRecord(last['error'])['message']);
        const location = errorMessage === '' ? null : locateFailure(errorMessage);

        const list = byFile.get(path) ?? [];
        list.push({
          id: `${path}::${fullName}`,
          name: specTitle,
          fullName,
          path,
          status: normalizeStatus(
            asString(last['status'], asString(testNode['status'], 'pending')),
          ),
          durationMs: asNumber(last['duration']),
          ...(errorMessage === '' ? {} : { message: errorMessage }),
          ...(location === null
            ? {
                // Playwright ya indica en que linea esta el `test(...)`.
                failurePath: path,
                failureLine: asNumber(spec['line'], 1),
              }
            : { failurePath: toRelative(location.path), failureLine: location.line }),
        });
        byFile.set(path, list);
      }
    }

    for (const child of asArray(suite['suites'])) {
      visitSuite(asRecord(child), trail);
    }
  };

  for (const suite of asArray(document['suites'])) {
    visitSuite(asRecord(suite), []);
  }

  return [...byFile.entries()].map(([path, cases]) => ({
    path,
    status: aggregateStatus(cases.map((entry) => entry.status)),
    durationMs: cases.reduce((sum, entry) => sum + entry.durationMs, 0),
    cases,
  }));
}

/* -------------------------------------------------------------------------- */
/*  TAP (runner nativo de Node)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Interpreta la salida TAP del runner de Node.
 *
 * Node no sabe emitir el formato jest, asi que se lee su TAP. Solo se
 * necesitan tres cosas de cada linea de resultado: si paso, el nombre y, en
 * los bloques `---`/`...` que siguen a un fallo, el archivo y la linea.
 *
 * Los subtests aparecen indentados y su nombre se repite despues en el nivel
 * superior; se conservan igualmente porque son las pruebas reales cuando el
 * archivo agrupa con `describe`.
 */
export function parseTap(
  runId: string,
  output: string,
  fallbackPath: string,
  toRelative: (absolute: string) => string,
): TestRunSummary {
  const cases: TestCaseResult[] = [];
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^\s*(ok|not ok)\s+\d+\s*-?\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }

    const passed = match[1] === 'ok';
    let name = (match[2] ?? '').trim();
    let status: TestStatus = passed ? 'passed' : 'failed';

    // Las directivas van al final: `# SKIP`, `# TODO`.
    const directive = /#\s*(SKIP|TODO)\b/i.exec(name);
    if (directive !== null) {
      status = 'skipped';
      name = name.slice(0, directive.index).trim();
    }

    // Bloque YAML del diagnostico, si lo hay.
    let message = '';
    let failurePath: string | null = null;
    let failureLine = 0;
    let durationMs = 0;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const detail = (lines[cursor] ?? '').trim();
      if (detail === '---') {
        continue;
      }
      if (detail === '...' || /^(ok|not ok)\s/.test(detail)) {
        index = detail === '...' ? cursor : cursor - 1;
        break;
      }
      const duration = /^duration_ms:\s*([\d.]+)/.exec(detail);
      if (duration !== null) {
        durationMs = Number.parseFloat(duration[1] ?? '0');
        continue;
      }
      const error = /^error:\s*(.*)$/.exec(detail);
      if (error !== null) {
        message = (error[1] ?? '').replace(/^['"]|['"]$/g, '');
        continue;
      }
      const file = /^(?:file|failureType|stack):\s*(.*)$/.exec(detail);
      if (file !== null) {
        const location = locateFailure(file[1] ?? '');
        if (location !== null) {
          failurePath = location.path;
          failureLine = location.line;
        }
      }
    }

    cases.push({
      id: `${fallbackPath}::${name}`,
      name,
      fullName: name,
      path: fallbackPath,
      status,
      durationMs,
      ...(message === '' ? {} : { message }),
      ...(failurePath === null
        ? {}
        : { failurePath: toRelative(failurePath), failureLine }),
    });
  }

  const file: TestFileResult = {
    path: fallbackPath,
    status: aggregateStatus(cases.map((entry) => entry.status)),
    durationMs: cases.reduce((sum, entry) => sum + entry.durationMs, 0),
    cases,
  };

  return {
    runId,
    runner: 'node',
    status: file.status,
    total: cases.length,
    passed: cases.filter((entry) => entry.status === 'passed').length,
    failed: cases.filter((entry) => entry.status === 'failed').length,
    skipped: cases.filter((entry) => entry.status === 'skipped').length,
    durationMs: file.durationMs,
    files: cases.length === 0 ? [] : [file],
    startedAt: 0,
    endedAt: 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  Punto de entrada                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Convierte el informe en un resumen normalizado.
 *
 * `toRelative` traduce las rutas absolutas del runner a rutas del workspace;
 * lo aporta el llamante porque este modulo no conoce el disco.
 */
export function parseTestReport(
  runId: string,
  runner: TestRunnerId,
  json: string,
  toRelative: (absolute: string) => string,
): TestRunSummary {
  let document: Record_;
  try {
    document = asRecord(JSON.parse(json));
  } catch (cause) {
    throw Object.assign(new Error('El informe de pruebas no es JSON valido.'), {
      forge: {
        code: 'E_PARSE' as const,
        message: 'El informe de pruebas no es JSON valido.',
        detail: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }

  // La forma manda sobre el runner declarado: `vitest --reporter=json`
  // produce formato jest, y un `playwright` mal configurado podria no.
  const files =
    document['suites'] !== undefined && document['testResults'] === undefined
      ? parsePlaywright(document, toRelative)
      : parseJestLike(document, toRelative);

  const cases = files.flatMap((file) => file.cases);
  const startedAt = asNumber(document['startTime'], 0);

  return {
    runId,
    runner,
    status: aggregateStatus(files.map((file) => file.status)),
    total: cases.length,
    passed: cases.filter((entry) => entry.status === 'passed').length,
    failed: cases.filter((entry) => entry.status === 'failed').length,
    skipped: cases.filter((entry) => entry.status === 'skipped').length,
    durationMs: files.reduce((sum, file) => sum + file.durationMs, 0),
    files,
    startedAt,
    endedAt: 0,
  };
}
