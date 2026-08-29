/**
 * Deteccion del ejecutor de pruebas y construccion de su linea de comando.
 *
 * La deteccion es por dependencias declaradas y por archivos de
 * configuracion, nunca ejecutando nada. Que exista `vitest` en
 * `devDependencies` es una senal mas fiable que buscar el binario, porque el
 * binario puede estar sin instalar y aun asi ser el runner del proyecto.
 *
 * Las funciones que construyen la linea de comando son puras: dado un runner
 * y una peticion, siempre producen los mismos argumentos. Eso permite
 * probarlas sin lanzar procesos, que es donde de verdad se cuelan los fallos
 * (un flag mal escrito no falla al compilar, falla al ejecutar).
 */

import type {
  PackageManagerId,
  TestRunRequest,
  TestRunnerId,
} from '../../../shared/contracts.js';

/** Orden de preferencia cuando el proyecto declara varios. */
const PRIORITY: readonly TestRunnerId[] = ['vitest', 'playwright', 'jest', 'node'];

const CONFIG_FILES: Readonly<Record<TestRunnerId, readonly string[]>> = {
  vitest: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.workspace.ts'],
  playwright: ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'],
  jest: ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.json'],
  node: [],
};

const PACKAGES: Readonly<Record<TestRunnerId, readonly string[]>> = {
  vitest: ['vitest'],
  playwright: ['@playwright/test', 'playwright'],
  jest: ['jest', 'ts-jest'],
  node: [],
};

/**
 * Runners que el proyecto declara.
 *
 * `dependencies` reune las dependencias de produccion y de desarrollo ya
 * fusionadas; `files` son los archivos presentes en la raiz.
 */
export function detectRunners(
  dependencies: readonly string[],
  files: readonly string[],
): readonly TestRunnerId[] {
  const declared = new Set(dependencies);
  const present = new Set(files);
  const found: TestRunnerId[] = [];

  for (const runner of PRIORITY) {
    if (runner === 'node') {
      continue;
    }
    const byPackage = (PACKAGES[runner] ?? []).some((name) => declared.has(name));
    const byConfig = (CONFIG_FILES[runner] ?? []).some((file) => present.has(file));
    if (byPackage || byConfig) {
      found.push(runner);
    }
  }

  // El runner nativo de Node siempre esta disponible: es la ultima opcion,
  // no una que se detecte.
  found.push('node');
  return found;
}

/** El runner preferido: el primero declarado, o el de Node. */
export function preferredRunner(runners: readonly TestRunnerId[]): TestRunnerId {
  return runners[0] ?? 'node';
}

/* -------------------------------------------------------------------------- */
/*  Linea de comando                                                           */
/* -------------------------------------------------------------------------- */

export interface RunnerCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Archivo donde el runner deja el informe JSON, relativo al workspace. */
  readonly reportPath: string;
  /** Variables extra necesarias para dirigir la salida. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Carpeta de trabajo del IDE dentro del proyecto.
 *
 * Cuelga de `node_modules` a proposito: ya esta ignorada por Git en
 * cualquier proyecto de JavaScript, asi que el informe no ensucia el estado
 * del repositorio ni hay que tocar el `.gitignore` del usuario.
 */
export const FORGE_WORK_DIR = 'node_modules/.forge';

/** Ejecutable del gestor para lanzar un binario local. */
function executor(manager: PackageManagerId): { command: string; args: readonly string[] } {
  switch (manager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['exec'] };
    case 'yarn':
      return { command: 'yarn', args: [] };
    case 'bun':
      return { command: 'bun', args: ['x'] };
    default:
      // `npx --no-install` evita que una errata descargue medio registro.
      return { command: 'npx', args: ['--no-install'] };
  }
}

/**
 * Construye la invocacion del runner.
 *
 * El informe se pide siempre a un ARCHIVO, no a la salida estandar: los
 * runners mezclan avisos, trazas y barras de progreso con el JSON, y
 * rescatarlo del texto es fragil. Con `--outputFile` el archivo o esta
 * completo o no esta.
 */
export function buildRunnerCommand(
  runner: TestRunnerId,
  manager: PackageManagerId,
  request: TestRunRequest,
): RunnerCommand {
  const reportPath = `${FORGE_WORK_DIR}/test-report-${runner}.json`;
  const { command, args: prefix } = executor(manager);

  switch (runner) {
    case 'vitest': {
      const args = [...prefix, 'vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`];
      if (request.coverage === true) {
        args.push('--coverage', '--coverage.reporter=json', '--coverage.reportsDirectory=' + `${FORGE_WORK_DIR}/coverage`);
      }
      if (request.path !== undefined && request.path !== '') {
        args.push(request.path);
      }
      if (request.testName !== undefined && request.testName !== '') {
        // `-t` filtra por nombre completo, que es lo que el code lens tiene.
        args.push('-t', request.testName);
      }
      return { command, args, reportPath, env: {} };
    }

    case 'jest': {
      const args = [...prefix, 'jest', '--json', `--outputFile=${reportPath}`];
      if (request.coverage === true) {
        args.push('--coverage', '--coverageReporters=json', `--coverageDirectory=${FORGE_WORK_DIR}/coverage`);
      }
      if (request.path !== undefined && request.path !== '') {
        // En Jest el positional es un patron de ruta, no una ruta exacta.
        args.push('--runTestsByPath', request.path);
      }
      if (request.testName !== undefined && request.testName !== '') {
        args.push('-t', request.testName);
      }
      return { command, args, reportPath, env: {} };
    }

    case 'playwright': {
      const args = [...prefix, 'playwright', 'test', '--reporter=json'];
      if (request.path !== undefined && request.path !== '') {
        args.push(request.path);
      }
      if (request.testName !== undefined && request.testName !== '') {
        args.push('-g', request.testName);
      }
      return {
        command,
        args,
        reportPath,
        // Playwright no tiene `--outputFile`: se dirige por entorno.
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
      };
    }

    default: {
      // El runner nativo de Node no sabe emitir el formato jest, asi que se
      // usa su reportero TAP y se convierte despues.
      const args = ['--test', '--test-reporter=tap'];
      if (request.path !== undefined && request.path !== '') {
        args.push(request.path);
      }
      if (request.testName !== undefined && request.testName !== '') {
        args.push('--test-name-pattern', request.testName);
      }
      return { command: 'node', args, reportPath: '', env: {} };
    }
  }
}

/**
 * Rutas donde buscar el informe de cobertura, en orden de preferencia.
 * Se prueban varias porque el proyecto puede tener configurada la suya.
 */
export function coverageCandidates(): readonly string[] {
  return [
    `${FORGE_WORK_DIR}/coverage/coverage-final.json`,
    'coverage/coverage-final.json',
    `${FORGE_WORK_DIR}/coverage/lcov.info`,
    'coverage/lcov.info',
  ];
}
