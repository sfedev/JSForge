/**
 * Terminal integrada.
 *
 * `node-pty` es un modulo nativo y por tanto OPCIONAL: exigir una pasada de
 * compilacion C++ en la maquina del usuario rompe la promesa de builds
 * reproducibles. Se carga bajo demanda y, si no esta disponible, se degrada
 * a un shell por tuberias.
 *
 * Diferencias del modo degradado, que la interfaz muestra explicitamente:
 *  - No hay TTY real: los programas que dibujan interfaces (vim, top) no
 *    funcionan, y muchos desactivan el color.
 *  - `resize` no tiene efecto.
 *  - Ctrl+C se traduce a una senal al proceso en vez de viajar por el TTY.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  forgeError,
  type CommandSuggestion,
  type PtyCreateRequest,
  type PtyCreateResult,
  type PtyProfile,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { requireWorkspaceRoot } from '../workspace-service.js';
import { readManifest } from '../dotforge/config-service.js';
import { readScripts } from '../toolchain/project-parsers.js';
import { detectToolchain } from '../toolchain/package-manager.js';
import { resolveProcessEnv } from '../process/env-service.js';

/* -------------------------------------------------------------------------- */
/*  Carga opcional de node-pty                                                 */
/* -------------------------------------------------------------------------- */

interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      useConpty?: boolean;
    },
  ): PtyProcess;
}

let nodePty: NodePtyModule | null | undefined;

/**
 * Devuelve el modulo si esta instalado y carga bien. Se cachea tambien el
 * fallo, para no reintentar una carga cara en cada terminal nueva.
 */
function loadNodePty(): NodePtyModule | null {
  if (nodePty !== undefined) {
    return nodePty;
  }
  try {
    // `require` dinamico: esbuild lo deja como externo y la ausencia del
    // modulo se convierte en modo degradado, no en un fallo de arranque.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require('node-pty') as NodePtyModule;
    nodePty = typeof loaded?.spawn === 'function' ? loaded : null;
  } catch {
    nodePty = null;
  }
  if (nodePty === null) {
    console.info('[forge] node-pty no disponible; la terminal usara el modo degradado.');
  }
  return nodePty;
}

export function isPtyAvailable(): boolean {
  return loadNodePty() !== null;
}

/* -------------------------------------------------------------------------- */
/*  Perfiles                                                                   */
/* -------------------------------------------------------------------------- */

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const powershell = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pwsh = path.join(powershell, 'PowerShell', '7', 'pwsh.exe');
    if (existsSync(pwsh)) {
      return { command: pwsh, args: ['-NoLogo'] };
    }
    return { command: process.env['COMSPEC'] ?? 'cmd.exe', args: [] };
  }
  return { command: process.env['SHELL'] ?? '/bin/bash', args: ['-l'] };
}

/** Busca un binario en `node_modules/.bin` del workspace. */
function localBinary(name: string): string | null {
  let root: string;
  try {
    root = requireWorkspaceRoot();
  } catch {
    return null;
  }
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const suffix of suffixes) {
    const candidate = path.join(root, 'node_modules', '.bin', `${name}${suffix}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function listProfiles(): Promise<readonly PtyProfile[]> {
  const shell = defaultShell();
  const toolchain = await detectToolchain();

  const profiles: PtyProfile[] = [
    {
      id: 'default',
      label: process.platform === 'win32' ? 'Shell del sistema' : path.basename(shell.command),
      command: shell.command,
      args: shell.args,
      available: true,
    },
    {
      id: 'node',
      label: 'Node REPL',
      command: 'node',
      args: [],
      available: toolchain.nodeVersion !== undefined,
    },
    {
      id: 'dotforge',
      label: 'DotForge CLI',
      command: localBinary('dotforge') ?? 'dotforge',
      args: [],
      available: localBinary('dotforge') !== null,
    },
    {
      id: 'claude',
      label: 'Claude Code CLI',
      command: 'claude',
      args: [],
      available: true,
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      command: 'gemini',
      args: [],
      available: true,
    },
  ];

  return profiles;
}

/* -------------------------------------------------------------------------- */
/*  Sesiones                                                                   */
/* -------------------------------------------------------------------------- */

interface Session {
  readonly id: string;
  readonly degraded: boolean;
  readonly pty: PtyProcess | null;
  readonly child: ChildProcessWithoutNullStreams | null;
}

const sessions = new Map<string, Session>();

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

export async function createSession(request: PtyCreateRequest): Promise<PtyCreateResult> {
  if (typeof request?.id !== 'string' || request.id === '') {
    failure('E_INVALID_ARGUMENT', 'La terminal no declara identificador.');
  }
  if (sessions.has(request.id)) {
    failure('E_ALREADY_EXISTS', `Ya existe una terminal con el identificador "${request.id}".`);
  }

  const profiles = await listProfiles();
  const profile = profiles.find((entry) => entry.id === request.profileId) ?? profiles[0];
  if (profile === undefined) {
    failure('E_NOT_AVAILABLE', 'No hay ningun perfil de terminal disponible.');
  }

  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, request.cwd ?? '');
  const env = await resolveProcessEnv(null, request.env ?? {});
  // En una terminal interactiva si queremos color.
  delete env['NO_COLOR'];
  env['FORCE_COLOR'] = '1';
  env['TERM'] = 'xterm-256color';

  const pty = loadNodePty();

  if (pty !== null) {
    let process_: PtyProcess;
    try {
      process_ = pty.spawn(profile.command, [...profile.args], {
        name: 'xterm-256color',
        cols: Math.max(20, request.cols),
        rows: Math.max(5, request.rows),
        cwd: guarded.absolute,
        env,
      });
    } catch (cause) {
      failure(
        'E_PROCESS_FAILED',
        `No se pudo iniciar "${profile.label}".`,
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    process_.onData((data) => {
      emit({ type: 'pty/data', payload: { id: request.id, data } });
    });
    process_.onExit(({ exitCode }) => {
      sessions.delete(request.id);
      emit({ type: 'pty/exit', payload: { id: request.id, exitCode } });
    });

    sessions.set(request.id, { id: request.id, degraded: false, pty: process_, child: null });
    return { id: request.id, pid: process_.pid, profileId: profile.id, degraded: false };
  }

  /* --- Modo degradado: shell por tuberias --- */
  const child = spawn(profile.command, [...profile.args], {
    cwd: guarded.absolute,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    // xterm espera CRLF; una tuberia entrega LF pelado.
    emit({ type: 'pty/data', payload: { id: request.id, data: data.split('\n').join('\r\n') } });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => {
    emit({ type: 'pty/data', payload: { id: request.id, data: data.split('\n').join('\r\n') } });
  });
  child.on('error', (cause) => {
    emit({
      type: 'pty/data',
      payload: { id: request.id, data: `\r\n\x1b[31mNo se pudo iniciar: ${cause.message}\x1b[0m\r\n` },
    });
    sessions.delete(request.id);
    emit({ type: 'pty/exit', payload: { id: request.id, exitCode: -1 } });
  });
  child.on('close', (code) => {
    sessions.delete(request.id);
    emit({ type: 'pty/exit', payload: { id: request.id, exitCode: code ?? -1 } });
  });

  sessions.set(request.id, { id: request.id, degraded: true, pty: null, child });

  emit({
    type: 'pty/data',
    payload: {
      id: request.id,
      data:
        '\x1b[33mTerminal en modo degradado: node-pty no esta instalado.\x1b[0m\r\n' +
        '\x1b[90mLos programas de pantalla completa no funcionaran. Instala node-pty para una terminal completa.\x1b[0m\r\n\r\n',
    },
  });

  return { id: request.id, pid: child.pid ?? -1, profileId: profile.id, degraded: true };
}

export function writeToSession(id: string, data: string): true {
  const session = sessions.get(id);
  if (session === undefined) {
    return true;
  }
  if (session.pty !== null) {
    session.pty.write(data);
    return true;
  }
  const child = session.child;
  if (child === null) {
    return true;
  }
  // Sin TTY, Ctrl+C no llega como caracter: se traduce a senal.
  if (data === '\u0003') {
    child.kill('SIGINT');
    return true;
  }
  child.stdin.write(data);
  return true;
}

export function resizeSession(id: string, cols: number, rows: number): true {
  const session = sessions.get(id);
  if (session?.pty === undefined || session.pty === null) {
    // En modo degradado no hay dimensiones que ajustar.
    return true;
  }
  try {
    session.pty.resize(Math.max(20, cols), Math.max(5, rows));
  } catch {
    // La sesion pudo morir entre el evento de resize y esta llamada.
  }
  return true;
}

export function disposeSession(id: string): true {
  const session = sessions.get(id);
  if (session === undefined) {
    return true;
  }
  sessions.delete(id);
  try {
    if (session.pty !== null) {
      session.pty.kill();
    } else {
      session.child?.kill();
    }
  } catch {
    // Ya estaba muerta.
  }
  return true;
}

export function disposeAllSessions(): void {
  for (const id of [...sessions.keys()]) {
    disposeSession(id);
  }
}

/* -------------------------------------------------------------------------- */
/*  Sugerencias de comandos                                                    */
/* -------------------------------------------------------------------------- */

/** Subcomandos habituales de cada gestor, para completar por prefijo. */
const MANAGER_SUBCOMMANDS: readonly string[] = [
  'install',
  'run',
  'add',
  'remove',
  'update',
  'outdated',
  'audit',
  'exec',
  'dlx',
  'create',
  'init',
  'test',
  'build',
  'why',
  'link',
  'publish',
];

const DOTFORGE_SUBCOMMANDS: readonly string[] = [
  'dev',
  'build',
  'test',
  'lint',
  'run',
  'pipeline',
  'task',
  'env',
  'generate',
  'doctor',
  'sync',
  'services',
];

/**
 * Sugerencias por prefijo leyendo los scripts y tareas REALES del proyecto.
 * No se inventan comandos: si el proyecto no tiene `build`, no se ofrece.
 */
export async function suggest(prefix: string): Promise<readonly CommandSuggestion[]> {
  const text = typeof prefix === 'string' ? prefix.trimStart() : '';
  const suggestions: CommandSuggestion[] = [];

  const [manifest, scripts, toolchain] = await Promise.all([
    readManifest(),
    readScripts(),
    detectToolchain(),
  ]);

  const manager = toolchain.preferred;
  const parts = text.split(/\s+/);
  const head = parts[0] ?? '';

  /* --- Se esta escribiendo el primer token --- */
  if (parts.length <= 1) {
    for (const candidate of [manager, 'npm', 'pnpm', 'yarn', 'bun', 'dotforge', 'node', 'git']) {
      if (candidate.startsWith(head) && !suggestions.some((entry) => entry.value === candidate)) {
        suggestions.push({ value: candidate, kind: 'command' });
      }
    }
    // Atajo: escribir el nombre del script completa el comando entero.
    for (const script of scripts) {
      if (script.name.startsWith(head)) {
        suggestions.push({
          value: `${manager} run ${script.name}`,
          detail: script.command,
          kind: 'script',
        });
      }
    }
    return suggestions.slice(0, 40);
  }

  const tail = parts[parts.length - 1] ?? '';

  /* --- Segundo token de un gestor de paquetes --- */
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(head)) {
    if (parts.length === 2) {
      for (const subcommand of MANAGER_SUBCOMMANDS) {
        if (subcommand.startsWith(tail)) {
          suggestions.push({ value: `${head} ${subcommand}`, kind: 'command' });
        }
      }
    }
    if (parts.length === 3 && parts[1] === 'run') {
      for (const script of scripts) {
        if (script.name.startsWith(tail)) {
          suggestions.push({
            value: `${head} run ${script.name}`,
            detail: script.command,
            kind: 'script',
          });
        }
      }
    }
    return suggestions.slice(0, 40);
  }

  /* --- DotForge --- */
  if (head === 'dotforge') {
    if (parts.length === 2) {
      for (const subcommand of DOTFORGE_SUBCOMMANDS) {
        if (subcommand.startsWith(tail)) {
          suggestions.push({ value: `dotforge ${subcommand}`, kind: 'command' });
        }
      }
      for (const id of Object.keys(manifest.config.pipelines ?? {})) {
        if (id.startsWith(tail)) {
          suggestions.push({ value: `dotforge ${id}`, detail: 'pipeline', kind: 'pipeline' });
        }
      }
    }
    if (parts.length === 3 && (parts[1] === 'run' || parts[1] === 'task')) {
      for (const [id, task] of Object.entries(manifest.config.tasks ?? {})) {
        if (id.startsWith(tail)) {
          suggestions.push({
            value: `dotforge ${parts[1]} ${id}`,
            detail: task.command ?? task.script ?? '',
            kind: 'task',
          });
        }
      }
    }
    if (parts.length === 3 && parts[1] === 'pipeline') {
      for (const [id, pipeline] of Object.entries(manifest.config.pipelines ?? {})) {
        if (id.startsWith(tail)) {
          suggestions.push({
            value: `dotforge pipeline ${id}`,
            detail: pipeline.tasks.join(', '),
            kind: 'pipeline',
          });
        }
      }
    }
  }

  return suggestions.slice(0, 40);
}
