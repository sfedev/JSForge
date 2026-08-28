/**
 * Servicio de Git.
 *
 * Invoca el binario `git` con argumentos en forma de lista: nunca se
 * construye una linea de comando concatenando rutas, de modo que un archivo
 * llamado `; rm -rf ~` es simplemente un archivo con un nombre raro.
 *
 * Las rutas que llegan del renderer pasan por el guardian antes de usarse,
 * y siempre se envian tras `--` para que git no las interprete como opciones.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  forgeError,
  type GitBranch,
  type GitCommitRequest,
  type GitDiffPair,
  type GitDiffRequest,
  type GitLogEntry,
  type GitStatus,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { assertAllInsideWorkspace, assertInsideWorkspace } from '../../security/workspace-guard.js';
import { requireWorkspaceRoot } from '../workspace-service.js';
import {
  EMPTY_STATUS,
  LOG_FIELD_SEPARATOR,
  LOG_RECORD_SEPARATOR,
  parseBranches,
  parseLog,
  parseStatusV2,
} from './porcelain-parser.js';

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 25_000;
const MAX_BUFFER = 32 * 1024 * 1024;

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Ejecuta git. `shell` queda desactivado a proposito en todas las
 * plataformas: `git` es un ejecutable real, no un script `.cmd`.
 */
async function git(args: readonly string[], input?: string): Promise<GitResult> {
  const cwd = requireWorkspaceRoot();
  try {
    const child = run('git', [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Sin paginador ni prompts interactivos: el IDE no puede responderlos.
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
    });
    if (input !== undefined) {
      child.child.stdin?.end(input);
    }
    const { stdout, stderr } = await child;
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (cause) {
    const error = cause as { stderr?: string; stdout?: string; code?: number | string };
    const detail = (error.stderr ?? error.stdout ?? '').trim();
    if (error.code === 'ENOENT') {
      failure('E_NOT_AVAILABLE', 'Git no esta instalado o no esta en el PATH.');
    }
    failure('E_PROCESS_FAILED', 'El comando de git fallo.', detail || String(cause));
  }
}

/** Ejecuta git tolerando el fallo; util para comprobaciones. */
async function gitSafe(args: readonly string[]): Promise<GitResult | null> {
  try {
    return await git(args);
  } catch {
    return null;
  }
}

export async function isRepository(): Promise<boolean> {
  const result = await gitSafe(['rev-parse', '--is-inside-work-tree']);
  return result !== null && result.stdout.trim() === 'true';
}

/* -------------------------------------------------------------------------- */
/*  Estado                                                                     */
/* -------------------------------------------------------------------------- */

export async function status(): Promise<GitStatus> {
  if (!(await isRepository())) {
    return EMPTY_STATUS;
  }
  const { stdout } = await git([
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all',
    '-z',
  ]);
  return parseStatusV2(stdout);
}

/** Recalcula el estado y lo publica; se llama tras cada mutacion. */
export async function refreshStatus(): Promise<GitStatus> {
  const next = await status();
  emit({ type: 'git/changed', payload: next });
  return next;
}

/* -------------------------------------------------------------------------- */
/*  Ramas                                                                      */
/* -------------------------------------------------------------------------- */

export async function branches(): Promise<readonly GitBranch[]> {
  if (!(await isRepository())) {
    return [];
  }
  const { stdout } = await git([
    'for-each-ref',
    '--format=%(refname:short)%09%(upstream:short)%09%(HEAD)',
    'refs/heads',
    'refs/remotes',
  ]);
  return parseBranches(stdout);
}

/** Valida un nombre de rama antes de pasarlo a git. */
function assertValidRef(name: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'El nombre de rama esta vacio.');
  }
  const trimmed = name.trim();
  // Un nombre que empieza por `-` seria interpretado como opcion.
  if (trimmed.startsWith('-')) {
    failure('E_INVALID_ARGUMENT', 'El nombre de rama no puede empezar por "-".');
  }
  if (/[\s~^:?*[\\]/.test(trimmed) || trimmed.includes('..') || trimmed.endsWith('.lock')) {
    failure('E_INVALID_ARGUMENT', `"${trimmed}" no es un nombre de referencia valido para git.`);
  }
  return trimmed;
}

export async function checkout(branch: string): Promise<true> {
  await git(['checkout', assertValidRef(branch)]);
  await refreshStatus();
  return true;
}

export async function createBranch(name: string, from?: string | null): Promise<true> {
  const target = assertValidRef(name);
  const args = from === undefined || from === null || from === ''
    ? ['checkout', '-b', target]
    : ['checkout', '-b', target, assertValidRef(from)];
  await git(args);
  await refreshStatus();
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Indice                                                                     */
/* -------------------------------------------------------------------------- */

function guardPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    failure('E_INVALID_ARGUMENT', 'No se indico ninguna ruta.');
  }
  const root = requireWorkspaceRoot();
  return assertAllInsideWorkspace(root, paths).map((guarded) => guarded.relative);
}

export async function stage(paths: readonly string[]): Promise<true> {
  const targets = guardPaths(paths);
  // `--` separa rutas de opciones: sin esto, un archivo `-f` seria una opcion.
  await git(['add', '--all', '--', ...targets]);
  await refreshStatus();
  return true;
}

export async function unstage(paths: readonly string[]): Promise<true> {
  const targets = guardPaths(paths);
  // En un repositorio sin commits, `reset HEAD` falla: se usa `rm --cached`.
  const hasHead = (await gitSafe(['rev-parse', '--verify', 'HEAD'])) !== null;
  if (hasHead) {
    await git(['restore', '--staged', '--', ...targets]);
  } else {
    await git(['rm', '--cached', '-r', '--', ...targets]);
  }
  await refreshStatus();
  return true;
}

export async function discard(paths: readonly string[]): Promise<true> {
  const targets = guardPaths(paths);
  const current = await status();
  const untracked = new Set(current.untracked.map((entry) => entry.path));

  const tracked = targets.filter((target) => !untracked.has(target));
  const newFiles = targets.filter((target) => untracked.has(target));

  if (tracked.length > 0) {
    await git(['checkout', '--', ...tracked]);
  }
  if (newFiles.length > 0) {
    // Un archivo sin seguimiento no se puede "revertir": se elimina.
    await git(['clean', '-fd', '--', ...newFiles]);
  }
  await refreshStatus();
  return true;
}

/**
 * Aplica un parche unificado al indice. Es lo que permite preparar
 * bloque a bloque: el renderer construye el parche del bloque seleccionado.
 */
export async function applyPatch(patch: string, reverse: boolean): Promise<true> {
  if (typeof patch !== 'string' || patch.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'El parche esta vacio.');
  }
  const args = ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'];
  if (reverse) {
    args.push('--reverse');
  }
  args.push('-');
  await git(args, patch.endsWith('\n') ? patch : `${patch}\n`);
  await refreshStatus();
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Commits                                                                    */
/* -------------------------------------------------------------------------- */

export async function commit(request: GitCommitRequest): Promise<GitLogEntry> {
  if (typeof request?.message !== 'string' || request.message.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'El mensaje del commit esta vacio.');
  }
  const args = ['commit', '--file=-', '--cleanup=strip'];
  if (request.amend === true) {
    args.push('--amend');
  }
  if (request.signoff === true) {
    args.push('--signoff');
  }
  await git(args, request.message);
  await refreshStatus();

  const entries = await log(1);
  const head = entries[0];
  if (head === undefined) {
    failure('E_UNKNOWN', 'El commit se creo pero no se pudo leer.');
  }
  return head;
}

export async function log(limit = 50): Promise<readonly GitLogEntry[]> {
  if (!(await isRepository())) {
    return [];
  }
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const format = ['%H', '%h', '%an', '%ae', '%at', '%s', '%b', '%D'].join(LOG_FIELD_SEPARATOR);
  const result = await gitSafe([
    'log',
    `--max-count=${safeLimit}`,
    `--format=${format}${LOG_RECORD_SEPARATOR}`,
  ]);
  if (result === null) {
    // Repositorio recien creado, sin commits: no es un error.
    return [];
  }
  return parseLog(result.stdout);
}

/* -------------------------------------------------------------------------- */
/*  Diferencias                                                                */
/* -------------------------------------------------------------------------- */

/** Contenido de un archivo en una revision, o cadena vacia si no existe. */
async function showFile(revision: string, relativePath: string): Promise<string> {
  const result = await gitSafe(['show', `${revision}:${relativePath}`]);
  return result === null ? '' : result.stdout;
}

/**
 * Par de contenidos para el visor lado a lado.
 *
 *  - `staged: true`  compara HEAD con el indice.
 *  - `staged: false` compara el indice (o HEAD) con el archivo en disco.
 */
export async function diff(request: GitDiffRequest): Promise<GitDiffPair> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, request.path);
  const relative = guarded.relative;

  // Un archivo binario no tiene diff util; se detecta con numstat.
  const numstat = await gitSafe(['diff', '--numstat', '--', relative]);
  const binary = numstat !== null && /^-\s+-\s+/.test(numstat.stdout);

  if (binary) {
    return {
      path: relative,
      original: '',
      modified: '',
      originalRef: 'HEAD',
      modifiedRef: 'disco',
      binary: true,
    };
  }

  if (request.staged) {
    const original = await showFile('HEAD', relative);
    const indexResult = await gitSafe(['show', `:${relative}`]);
    return {
      path: relative,
      original,
      modified: indexResult === null ? '' : indexResult.stdout,
      originalRef: 'HEAD',
      modifiedRef: 'indice',
      binary: false,
    };
  }

  const indexResult = await gitSafe(['show', `:${relative}`]);
  const original = indexResult === null ? await showFile('HEAD', relative) : indexResult.stdout;

  const { readFile } = await import('../fs-service.js');
  let modified = '';
  try {
    modified = (await readFile(relative)).content;
  } catch {
    // El archivo pudo eliminarse en el arbol de trabajo.
    modified = '';
  }

  return {
    path: relative,
    original,
    modified,
    originalRef: indexResult === null ? 'HEAD' : 'indice',
    modifiedRef: 'disco',
    binary: false,
  };
}

/** Diferencia unificada de un archivo, base para preparar por bloques. */
export async function unifiedDiff(relativePath: string, staged: boolean): Promise<string> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, relativePath);
  const args = ['diff', '--unified=3', '--no-color'];
  if (staged) {
    args.push('--cached');
  }
  args.push('--', guarded.relative);
  const result = await gitSafe(args);
  return result === null ? '' : result.stdout;
}
