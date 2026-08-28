/**
 * Gestor de procesos y pipelines DotForge.
 *
 * Cada proceso tiene su propio canal de salida. Los detalles que importan:
 *  - Los comandos se resuelven contra el gestor de paquetes detectado; no se
 *    concatenan cadenas ni se pasa por el shell salvo en Windows, donde los
 *    gestores son archivos `.cmd` y no hay alternativa.
 *  - Las lineas se agrupan con un freno de refresco configurable, de modo que
 *    un `next dev` verboso no ahogue al renderer.
 *  - Los valores secretos del entorno se redactan de la salida antes de
 *    enviarla, para que una credencial impresa por error no acabe en pantalla.
 *  - Al terminar el proceso se mata el arbol completo: un `npm run dev` deja
 *    hijos que sobrevivirian al padre.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

import {
  forgeError,
  type LogFormat,
  type LogRecord,
  type ProcessInfo,
  type ProcessStatus,
  type StartProcessRequest,
} from '../../../shared/contracts.js';
import { ThrottledBatcher, emit } from '../../ipc/event-bus.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { getSettings } from '../settings-service.js';
import { relativeToWorkspace, requireWorkspaceRoot } from '../workspace-service.js';
import { readManifest } from '../dotforge/config-service.js';
import { detectToolchain, scriptCommand } from '../toolchain/package-manager.js';
import { resolveProcessEnv, secretKeys } from './env-service.js';
import { detectPort, parseLogLine } from './log-parser.js';

interface ManagedProcess {
  info: ProcessInfo;
  child: ChildProcessWithoutNullStreams | null;
  request: StartProcessRequest;
  stdoutBuffer: string;
  stderrBuffer: string;
  seq: number;
  readyMatcher: RegExp | null;
  redactions: readonly string[];
  batcher: ThrottledBatcher<LogRecord>;
}

const processes = new Map<string, ManagedProcess>();

/** Longitud minima para redactar un valor: por debajo produce falsos positivos. */
const MIN_REDACTION_LENGTH = 6;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sustituye los valores secretos por un marcador en la salida. */
function redact(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    if (secret.length < MIN_REDACTION_LENGTH) {
      continue;
    }
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '«oculto»');
  }
  return out;
}

function publish(managed: ManagedProcess): void {
  emit({ type: 'process/state', payload: managed.info });
}

function setStatus(managed: ManagedProcess, status: ProcessStatus, patch: Partial<ProcessInfo> = {}): void {
  managed.info = { ...managed.info, status, ...patch };
  publish(managed);
}

/** Resuelve una ruta de marco de pila a ruta relativa del workspace. */
function frameResolver(cwd: string): (candidate: string) => string | null {
  return (candidate: string): string | null => {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    return relativeToWorkspace(absolute);
  };
}

function emitSystemLine(managed: ManagedProcess, message: string): void {
  managed.seq += 1;
  managed.batcher.push({
    processId: managed.info.id,
    seq: managed.seq,
    time: Date.now(),
    level: 'info',
    stream: 'system',
    message,
  });
}

/** Procesa un fragmento de salida, respetando lineas partidas entre chunks. */
function consume(
  managed: ManagedProcess,
  chunk: string,
  stream: 'stdout' | 'stderr',
  format: LogFormat,
  resolve: (candidate: string) => string | null,
): void {
  const buffered = (stream === 'stdout' ? managed.stdoutBuffer : managed.stderrBuffer) + chunk;
  const lines = buffered.split(/\r?\n/);
  // La ultima parte puede ser una linea incompleta: se guarda para el
  // siguiente chunk en lugar de emitirla partida.
  const tail = lines.pop() ?? '';
  if (stream === 'stdout') {
    managed.stdoutBuffer = tail;
  } else {
    managed.stderrBuffer = tail;
  }

  for (const rawLine of lines) {
    if (rawLine.trim() === '') {
      continue;
    }
    const line = redact(rawLine, managed.redactions);
    managed.seq += 1;
    const record = parseLogLine(line, {
      processId: managed.info.id,
      stream,
      format,
      seq: managed.seq,
      resolveFrame: resolve,
    });
    managed.batcher.push(record);

    if (managed.info.port === undefined) {
      const port = detectPort(line);
      if (port !== null) {
        managed.info = { ...managed.info, port, url: `http://localhost:${port}` };
        publish(managed);
      }
    }
    if (
      managed.readyMatcher !== null &&
      managed.info.status !== 'ready' &&
      managed.readyMatcher.test(line)
    ) {
      setStatus(managed, 'ready');
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Arranque                                                                   */
/* -------------------------------------------------------------------------- */

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

export async function startProcess(request: StartProcessRequest): Promise<ProcessInfo> {
  if (typeof request?.id !== 'string' || request.id === '') {
    failure('E_INVALID_ARGUMENT', 'La peticion de proceso no declara identificador.');
  }
  if (typeof request.command !== 'string' || request.command.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'La peticion de proceso no declara comando.');
  }

  const existing = processes.get(request.id);
  if (existing !== undefined && existing.child !== null) {
    failure('E_ALREADY_EXISTS', `El proceso "${request.id}" ya esta en ejecucion.`);
  }

  const root = requireWorkspaceRoot();
  // El cwd tambien pasa por el guardian: una tarea no puede ejecutarse fuera.
  const guarded = assertInsideWorkspace(root, request.cwd ?? '');

  const env = await resolveProcessEnv(request.environment ?? null, request.env ?? {});
  const secrets = await secretKeys(request.environment ?? null);
  const redactions = [...secrets]
    .map((key) => env[key])
    .filter((value): value is string => typeof value === 'string' && value.length >= MIN_REDACTION_LENGTH);

  let readyMatcher: RegExp | null = null;
  if (request.readyPattern !== undefined && request.readyPattern !== '') {
    try {
      readyMatcher = new RegExp(request.readyPattern, 'i');
    } catch {
      readyMatcher = null;
    }
  }

  const args = [...(request.args ?? [])];
  const info: ProcessInfo = {
    id: request.id,
    label: request.label,
    command: request.command,
    args,
    cwd: guarded.relative,
    status: 'starting',
    startedAt: Date.now(),
    ...(request.port === undefined ? {} : { port: request.port, url: `http://localhost:${request.port}` }),
    ...(request.pipelineId === undefined ? {} : { pipelineId: request.pipelineId }),
  };

  const managed: ManagedProcess = {
    info,
    child: null,
    request,
    stdoutBuffer: '',
    stderrBuffer: '',
    seq: existing?.seq ?? 0,
    readyMatcher,
    redactions,
    batcher: new ThrottledBatcher<LogRecord>(
      (records) => emit({ type: 'process/logs', payload: records }),
      getSettings().logThrottleMs,
    ),
  };
  processes.set(request.id, managed);
  publish(managed);

  const child = spawn(request.command, args, {
    cwd: guarded.absolute,
    env,
    windowsHide: true,
    // En Windows npm/pnpm/yarn son `.cmd`: sin shell, `spawn` no los encuentra.
    shell: process.platform === 'win32',
    // Grupo propio para poder matar el arbol entero al detener.
    detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams;

  managed.child = child;
  const format = request.logFormat ?? 'auto';
  const resolve = frameResolver(guarded.absolute);

  emitSystemLine(managed, `▸ ${request.command} ${args.join(' ')}  (${guarded.relative || '.'})`);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => consume(managed, chunk, 'stdout', format, resolve));

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => consume(managed, chunk, 'stderr', format, resolve));

  child.on('spawn', () => {
    setStatus(managed, 'running', { pid: child.pid ?? undefined });
  });

  child.on('error', (cause: Error) => {
    emitSystemLine(managed, `✖ No se pudo iniciar: ${cause.message}`);
    managed.batcher.flushNow();
    managed.child = null;
    setStatus(managed, 'failed', { endedAt: Date.now() });
  });

  child.on('close', (code, signal) => {
    // Se vacian los restos de linea sin terminar antes de cerrar el canal.
    if (managed.stdoutBuffer !== '') {
      consume(managed, '\n', 'stdout', format, resolve);
    }
    if (managed.stderrBuffer !== '') {
      consume(managed, '\n', 'stderr', format, resolve);
    }
    const exitCode = code ?? -1;
    emitSystemLine(
      managed,
      signal === null
        ? `◼ Proceso terminado con codigo ${exitCode}.`
        : `◼ Proceso terminado por la senal ${signal}.`,
    );
    managed.batcher.flushNow();
    managed.child = null;
    const status: ProcessStatus =
      managed.info.status === 'stopped' ? 'stopped' : exitCode === 0 ? 'exited' : 'failed';
    setStatus(managed, status, { exitCode, endedAt: Date.now() });
  });

  return managed.info;
}

/* -------------------------------------------------------------------------- */
/*  Parada                                                                     */
/* -------------------------------------------------------------------------- */

export async function stopProcess(id: string): Promise<true> {
  const managed = processes.get(id);
  if (managed === undefined || managed.child === null) {
    return true;
  }
  setStatus(managed, 'stopped');
  killTree(managed.child);
  return true;
}

/**
 * Termina el proceso y toda su descendencia.
 * En Windows se delega en `taskkill /T`; en POSIX se envia la senal al grupo.
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    // El pid negativo apunta al grupo creado por `detached: true`.
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  // Red de seguridad: si en 4 s sigue vivo, se fuerza.
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 4000);
  timer.unref();
}

export async function restartProcess(id: string): Promise<ProcessInfo> {
  const managed = processes.get(id);
  if (managed === undefined) {
    failure('E_NOT_FOUND', `No hay ningun proceso con el identificador "${id}".`);
  }
  const request = managed.request;
  await stopProcess(id);
  // Se espera a que el sistema libere el puerto antes de relanzar.
  await new Promise((resolve) => setTimeout(resolve, 350));
  return startProcess(request);
}

export function listProcesses(): readonly ProcessInfo[] {
  return [...processes.values()].map((managed) => managed.info);
}

export function clearProcess(id: string): true {
  const managed = processes.get(id);
  if (managed === undefined) {
    return true;
  }
  if (managed.child !== null) {
    failure('E_INVALID_ARGUMENT', 'El proceso sigue en ejecucion; detenlo antes de limpiarlo.');
  }
  managed.batcher.dispose();
  processes.delete(id);
  return true;
}

/** Detiene todo al cerrar la aplicacion. */
export function disposeAllProcesses(): void {
  for (const managed of processes.values()) {
    if (managed.child !== null) {
      killTree(managed.child);
    }
    managed.batcher.dispose();
  }
  processes.clear();
}

export function setLogThrottle(intervalMs: number): void {
  for (const managed of processes.values()) {
    managed.batcher.setInterval(intervalMs);
  }
}

/* -------------------------------------------------------------------------- */
/*  Pipelines DotForge                                                         */
/* -------------------------------------------------------------------------- */

/** Convierte una tarea del manifiesto en una peticion de arranque. */
export async function requestForTask(
  taskId: string,
  pipelineId?: string,
  environment?: string,
): Promise<StartProcessRequest> {
  const manifest = await readManifest();
  const task = manifest.config.tasks?.[taskId];
  if (task === undefined) {
    failure('E_NOT_FOUND', `La tarea "${taskId}" no existe en el manifiesto DotForge.`);
  }

  let command: string;
  let args: string[];

  if (task.script !== undefined) {
    const toolchain = await detectToolchain(manifest.config.packageManager);
    const resolved = scriptCommand(toolchain.preferred, task.script);
    command = resolved.command;
    args = [...resolved.args, ...(task.args ?? [])];
  } else {
    // `command` puede venir con argumentos incluidos: se parte respetando
    // las comillas, sin pasar la cadena entera a un shell.
    const parts = splitCommandLine(task.command ?? '');
    command = parts[0] ?? '';
    args = [...parts.slice(1), ...(task.args ?? [])];
  }

  if (command === '') {
    failure('E_INVALID_ARGUMENT', `La tarea "${taskId}" no define un comando ejecutable.`);
  }

  return {
    id: pipelineId === undefined ? `task:${taskId}` : `${pipelineId}:${taskId}`,
    label: task.label ?? taskId,
    command,
    args,
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    ...(task.env === undefined ? {} : { env: task.env }),
    ...(environment === undefined ? {} : { environment }),
    ...(task.logFormat === undefined ? {} : { logFormat: task.logFormat }),
    ...(task.readyPattern === undefined ? {} : { readyPattern: task.readyPattern }),
    ...(task.port === undefined ? {} : { port: task.port }),
    ...(pipelineId === undefined ? {} : { pipelineId }),
  };
}

/**
 * Parte una linea de comando respetando comillas simples y dobles.
 * Es deliberadamente simple: no expande variables ni interpreta operadores
 * del shell, porque el comando NO se ejecuta a traves de un shell.
 */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current !== '') {
    parts.push(current);
  }
  return parts;
}

export async function runPipeline(pipelineId: string): Promise<readonly ProcessInfo[]> {
  const manifest = await readManifest();
  const pipeline = manifest.config.pipelines?.[pipelineId];
  if (pipeline === undefined) {
    failure('E_NOT_FOUND', `El pipeline "${pipelineId}" no existe en el manifiesto DotForge.`);
  }

  const started: ProcessInfo[] = [];

  if (pipeline.parallel !== false) {
    const requests = await Promise.all(
      pipeline.tasks.map((taskId) => requestForTask(taskId, pipelineId, pipeline.environment)),
    );
    for (const request of requests) {
      started.push(await startProcess(request));
    }
    return started;
  }

  // Modo encadenado: cada tarea espera a que la anterior salga con exito.
  for (const taskId of pipeline.tasks) {
    const request = await requestForTask(taskId, pipelineId, pipeline.environment);
    const info = await startProcess(request);
    started.push(info);
    const exitCode = await waitForExit(request.id);
    if (exitCode !== 0 && pipeline.stopOnError === true) {
      emit({
        type: 'notification',
        payload: {
          level: 'error',
          message: `El pipeline "${pipelineId}" se detuvo.`,
          detail: `La tarea "${taskId}" salio con codigo ${exitCode}.`,
        },
      });
      break;
    }
  }
  return started;
}

/** Espera a que un proceso termine y devuelve su codigo de salida. */
function waitForExit(id: string): Promise<number> {
  return new Promise((resolve) => {
    const managed = processes.get(id);
    if (managed === undefined || managed.child === null) {
      resolve(managed?.info.exitCode ?? 0);
      return;
    }
    managed.child.once('close', (code) => resolve(code ?? -1));
  });
}

/** Procesos vivos con su pid, para el panel de metricas. */
export function livePids(): readonly { id: string; label: string; pid: number }[] {
  const out: { id: string; label: string; pid: number }[] = [];
  for (const managed of processes.values()) {
    const pid = managed.child?.pid;
    if (pid !== undefined) {
      out.push({ id: managed.info.id, label: managed.info.label, pid });
    }
  }
  return out;
}
