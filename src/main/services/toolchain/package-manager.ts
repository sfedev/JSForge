/**
 * Deteccion del gestor de paquetes y de las herramientas del sistema.
 *
 * Orden de decision, de mayor a menor autoridad:
 *  1. `packageManager` declarado en dotforge.config.json.
 *  2. `packageManager` declarado en package.json (formato Corepack).
 *  3. Lockfile presente en el workspace.
 *  4. Primer gestor disponible en el PATH.
 *  5. npm como ultimo recurso.
 *
 * Las versiones se consultan una sola vez por sesion: lanzar cuatro procesos
 * en cada refresco de la UI se nota en el arranque.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  PackageManagerId,
  PackageManagerInfo,
  PreferredReason,
  ToolchainInfo,
} from '../../../shared/contracts.js';
import { exists } from '../fs-service.js';
import { readPackageJson } from './project-parsers.js';

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 4000;

const LOCKFILES: readonly { readonly file: string; readonly manager: PackageManagerId }[] = [
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
];

const MANAGERS: readonly PackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** Cache de version por binario; `null` significa "no disponible". */
const versionCache = new Map<string, string | null>();

/**
 * Consulta `<binario> --version`. En Windows los gestores son archivos `.cmd`,
 * asi que se ejecuta a traves del shell; los argumentos son constantes del
 * codigo, nunca entrada del usuario.
 */
async function probeVersion(binary: string, argument = '--version'): Promise<string | null> {
  const cached = versionCache.get(binary);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const { stdout } = await run(binary, [argument], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: process.platform === 'win32',
      maxBuffer: 1024 * 64,
    });
    const version = stdout.trim().split(/\r?\n/)[0] ?? '';
    const value = version === '' ? null : version;
    versionCache.set(binary, value);
    return value;
  } catch {
    versionCache.set(binary, null);
    return null;
  }
}

export function clearToolchainCache(): void {
  versionCache.clear();
}

/** Lockfile presente, si lo hay. */
async function detectByLockfile(): Promise<PackageManagerId | null> {
  for (const entry of LOCKFILES) {
    if (await exists(entry.file)) {
      return entry.manager;
    }
  }
  return null;
}

/** `packageManager: "pnpm@9.1.0"` -> `pnpm`. */
export function parseDeclaredManager(declared: string | undefined): PackageManagerId | null {
  if (declared === undefined) {
    return null;
  }
  const name = declared.split('@')[0]?.trim().toLowerCase();
  return MANAGERS.find((manager) => manager === name) ?? null;
}

export async function detectToolchain(declaredByDotForge?: PackageManagerId): Promise<ToolchainInfo> {
  const managers: PackageManagerInfo[] = await Promise.all(
    MANAGERS.map(async (id): Promise<PackageManagerInfo> => {
      const version = await probeVersion(id);
      return version === null
        ? { id, available: false }
        : { id, available: true, version };
    }),
  );

  const [{ summary }, nodeVersion, gitVersion, dockerVersion, lockfileManager] = await Promise.all([
    readPackageJson(),
    probeVersion('node'),
    probeVersion('git'),
    probeVersion('docker'),
    detectByLockfile(),
  ]);

  const declared = declaredByDotForge ?? parseDeclaredManager(summary?.packageManager);

  let preferred: PackageManagerId;
  let preferredReason: PreferredReason;

  if (declared !== null && declared !== undefined) {
    preferred = declared;
    preferredReason = 'declared';
  } else if (lockfileManager !== null) {
    preferred = lockfileManager;
    preferredReason = 'lockfile';
  } else {
    const available = managers.find((manager) => manager.available);
    if (available === undefined) {
      preferred = 'npm';
      preferredReason = 'default';
    } else {
      preferred = available.id;
      preferredReason = 'available';
    }
  }

  return {
    managers,
    preferred,
    preferredReason,
    ...(nodeVersion === null ? {} : { nodeVersion }),
    ...(gitVersion === null ? {} : { gitVersion: gitVersion.replace(/^git version /, '') }),
    ...(dockerVersion === null ? {} : { dockerVersion }),
  };
}

/**
 * Comando completo para ejecutar un script de package.json con el gestor
 * indicado. `npm` necesita `run`, `bun` usa `run` tambien; `pnpm` y `yarn`
 * aceptan el nombre del script directamente, pero se usa `run` en todos para
 * evitar colisiones con subcomandos propios (`yarn build` vs `yarn workspace`).
 */
export function scriptCommand(
  manager: PackageManagerId,
  script: string,
): { command: string; args: string[] } {
  switch (manager) {
    case 'npm':
      return { command: 'npm', args: ['run', script] };
    case 'pnpm':
      return { command: 'pnpm', args: ['run', script] };
    case 'yarn':
      return { command: 'yarn', args: ['run', script] };
    case 'bun':
      return { command: 'bun', args: ['run', script] };
    default:
      return { command: 'npm', args: ['run', script] };
  }
}

/** Comando de ejecucion de binarios locales (`npx`, `pnpm dlx`, `bunx`). */
export function executeCommand(
  manager: PackageManagerId,
  binary: string,
  args: readonly string[] = [],
): { command: string; args: string[] } {
  switch (manager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', binary, ...args] };
    case 'yarn':
      return { command: 'yarn', args: ['exec', binary, ...args] };
    case 'bun':
      return { command: 'bunx', args: [binary, ...args] };
    case 'npm':
    default:
      return { command: 'npx', args: ['--no-install', binary, ...args] };
  }
}

/** true si el binario responde a `--version`. */
export async function isAvailable(binary: string): Promise<boolean> {
  return (await probeVersion(binary)) !== null;
}
