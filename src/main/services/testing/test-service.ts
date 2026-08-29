/**
 * Servicio de pruebas: descubrimiento, ejecucion y cobertura.
 *
 * Ejecuta el runner como un proceso hijo y no bloquea nada: el renderer
 * recibe `test/started` al lanzar y `test/finished` con el resumen, igual
 * que ocurre con los procesos del gestor. Una suite larga no congela la UI
 * ni ocupa el hilo del proceso principal.
 *
 * El analisis del informe vive en modulos puros al lado; aqui solo esta la
 * fontaneria: rutas, spawn y composicion del evento.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  forgeError,
  type CoverageReport,
  type TestBlock,
  type TestRunRequest,
  type TestRunSummary,
  type TestRunnerId,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { relativeToWorkspace, requireWorkspaceRoot } from '../workspace-service.js';
import { exists, findFilesByName, readTextIfExists } from '../fs-service.js';
import { readPackageJson } from '../toolchain/project-parsers.js';
import { detectToolchain } from '../toolchain/package-manager.js';
import { resolveProcessEnv } from '../process/env-service.js';
import { isTestFile, parseTestBlocks } from './test-parser.js';
import { parseTap, parseTestReport } from './result-parser.js';
import { buildCoverageReport, parseIstanbulCoverage, parseLcov } from './coverage.js';
import {
  buildRunnerCommand,
  coverageCandidates,
  detectRunners,
  preferredRunner,
} from './runner-detect.js';

/** Plazo de una ejecucion completa. Una suite honesta no llega a esto. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Cota de archivos de prueba listados; mas no cabe en la vista. */
const MAX_TEST_FILES = 500;

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

/** Ejecuciones vivas, para poder cancelarlas. */
const running = new Map<string, { kill: () => void }>();

let lastRun: TestRunSummary | null = null;
let lastCoverage: CoverageReport | null = null;

/* -------------------------------------------------------------------------- */
/*  Descubrimiento                                                             */
/* -------------------------------------------------------------------------- */

export async function discoverTestFiles(): Promise<readonly string[]> {
  requireWorkspaceRoot();
  const found = new Set<string>();
  // Dos barridos porque el filtro del recorrido es por subcadena.
  for (const needle of ['.test.', '.spec.']) {
    for (const file of await findFilesByName(needle, MAX_TEST_FILES)) {
      if (isTestFile(file)) {
        found.add(file);
      }
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/** Bloques de prueba de un archivo, para el code lens del editor. */
export async function testBlocks(relativePath: string): Promise<readonly TestBlock[]> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, relativePath);
  const source = await readTextIfExists(guarded.relative);
  if (source === null) {
    return [];
  }
  return parseTestBlocks(guarded.relative, source);
}

/**
 * Analiza un contenido que el renderer ya tiene en memoria.
 *
 * El editor pinta el code lens mientras se escribe, antes de guardar: leer
 * del disco mostraria los bloques de la version anterior.
 */
export function blocksFromSource(relativePath: string, source: string): readonly TestBlock[] {
  return parseTestBlocks(relativePath, source);
}

export async function availableRunners(): Promise<readonly TestRunnerId[]> {
  requireWorkspaceRoot();
  const { summary } = await readPackageJson();
  const dependencies = [
    ...Object.keys(summary?.dependencies ?? {}),
    ...Object.keys(summary?.devDependencies ?? {}),
  ];

  const files: string[] = [];
  for (const candidate of [
    'vitest.config.ts',
    'vitest.config.js',
    'vitest.config.mts',
    'vitest.workspace.ts',
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'jest.config.ts',
    'jest.config.js',
    'jest.config.mjs',
    'jest.config.json',
  ]) {
    if (await exists(candidate)) {
      files.push(candidate);
    }
  }

  return detectRunners(dependencies, files);
}

/* -------------------------------------------------------------------------- */
/*  Ejecucion                                                                  */
/* -------------------------------------------------------------------------- */

/** Traduce una ruta del runner a ruta relativa del workspace. */
function relativeResolver(root: string): (candidate: string) => string {
  return (candidate: string): string => {
    if (candidate === '') {
      return '';
    }
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
    // Si cae fuera del workspace se devuelve tal cual: es informacion util
    // aunque el editor no pueda abrirla.
    return relativeToWorkspace(absolute) ?? candidate;
  };
}

export async function runTests(request: TestRunRequest): Promise<TestRunSummary> {
  const runId = request.runId;
  if (typeof runId !== 'string' || runId === '') {
    failure('E_INVALID_ARGUMENT', 'La ejecucion de pruebas no declara identificador.');
  }
  if (running.has(runId)) {
    failure('E_ALREADY_EXISTS', `La ejecucion "${runId}" ya esta en marcha.`);
  }

  const root = requireWorkspaceRoot();
  // La ruta viene del editor, pero pasa igualmente por el guardian.
  const targetPath =
    request.path === undefined || request.path === ''
      ? undefined
      : assertInsideWorkspace(root, request.path).relative;

  const runners = await availableRunners();
  const runner = request.runner ?? preferredRunner(runners);
  const toolchain = await detectToolchain();
  const invocation = buildRunnerCommand(runner, toolchain.preferred, {
    ...request,
    ...(targetPath === undefined ? {} : { path: targetPath }),
  });

  emit({
    type: 'test/started',
    payload: {
      runId,
      runner,
      ...(targetPath === undefined ? {} : { path: targetPath }),
    },
  });

  const env = await resolveProcessEnv(null, invocation.env);
  const startedAt = Date.now();

  const output = await new Promise<{ stdout: string; code: number }>((resolve) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: root,
      env,
      windowsHide: true,
      // En Windows los gestores son `.cmd` y `spawn` no los encuentra sin shell.
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      running.delete(runId);
      resolve({ stdout, code });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(-1);
    }, RUN_TIMEOUT_MS);
    timer.unref();

    running.set(runId, {
      kill: () => {
        child.kill('SIGKILL');
        finish(-1);
      },
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // La salida de error tambien se acumula: el runner de Node emite ahi
    // parte del TAP, y un fallo de arranque solo aparece en stderr.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.on('error', (cause: Error) => {
      stdout += `\n${cause.message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });

  const toRelative = relativeResolver(root);
  let summary: TestRunSummary;

  if (runner === 'node') {
    summary = parseTap(runId, output.stdout, targetPath ?? 'tests', toRelative);
  } else {
    const report = await readTextIfExists(invocation.reportPath);
    if (report === null) {
      // Sin informe no se puede inventar un resultado: se dice lo que paso.
      failure(
        'E_PROCESS_FAILED',
        `El ejecutor "${runner}" no genero ningun informe.`,
        output.stdout.slice(-2000),
      );
    }
    summary = parseTestReport(runId, runner, report, toRelative);
  }

  const finished: TestRunSummary = {
    ...summary,
    startedAt: summary.startedAt === 0 ? startedAt : summary.startedAt,
    endedAt: Date.now(),
    // Un runner que salio con error sin registrar ningun fallo (por ejemplo,
    // una configuracion invalida) no puede darse por bueno.
    status: output.code !== 0 && summary.failed === 0 && summary.total === 0
      ? 'failed'
      : summary.status,
  };

  lastRun = finished;
  emit({ type: 'test/finished', payload: finished });

  if (request.coverage === true) {
    const coverage = await readCoverage();
    if (coverage !== null) {
      emit({ type: 'test/coverage', payload: coverage });
    }
  }

  return finished;
}

export function cancelRun(runId: string): true {
  running.get(runId)?.kill();
  return true;
}

export function lastRunSummary(): TestRunSummary | null {
  return lastRun;
}

/* -------------------------------------------------------------------------- */
/*  Cobertura                                                                  */
/* -------------------------------------------------------------------------- */

/** Busca y lee el informe de cobertura mas reciente que encuentre. */
export async function readCoverage(): Promise<CoverageReport | null> {
  const root = requireWorkspaceRoot();
  const toRelative = relativeResolver(root);

  for (const candidate of coverageCandidates()) {
    const source = await readTextIfExists(candidate);
    if (source === null || source.trim() === '') {
      continue;
    }
    const files = candidate.endsWith('.json')
      ? parseIstanbulCoverage(source, toRelative)
      : parseLcov(source, toRelative);
    if (files.length === 0) {
      continue;
    }
    lastCoverage = buildCoverageReport(files, Date.now());
    return lastCoverage;
  }
  return null;
}

export function lastCoverageReport(): CoverageReport | null {
  return lastCoverage;
}

/** Cancela lo que siga corriendo al cerrar la aplicacion. */
export function disposeTestRuns(): void {
  for (const entry of running.values()) {
    entry.kill();
  }
  running.clear();
}
