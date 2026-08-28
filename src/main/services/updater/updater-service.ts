/**
 * Motor de actualizaciones.
 *
 * Dos caminos, con el mismo estado observable:
 *
 *  1. `electron-updater` cuando esta instalado y la aplicacion esta empaquetada
 *     y firmada. Es el camino recomendado porque gestiona los deltas y la
 *     verificacion de firma de la plataforma.
 *  2. Un cliente HTTP propio contra un feed JSON (GitHub Releases, S3 o el
 *     registro DotForge) que descarga en segundo plano y verifica el
 *     SHA-256 antes de dar nada por bueno.
 *
 * En ambos casos la descarga ocurre en el proceso principal: el hilo del
 * renderer no se bloquea nunca.
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  forgeError,
  type UpdateChannel,
  type UpdateInfoView,
  type UpdaterState,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { getSettings, setSettings } from '../settings-service.js';
import { isNewerVersion } from './version.js';

/**
 * Feed por defecto. Se puede sobrescribir con `FORGE_UPDATE_FEED` para
 * apuntar a un registro propio en despliegues internos.
 */
const DEFAULT_FEED = 'https://updates.dotforge.dev/forgejs-ide';

const CHECK_TIMEOUT_MS = 15_000;

let state: UpdaterState = {
  phase: 'idle',
  channel: 'stable',
  currentVersion: '0.0.0',
  autoInstallOnQuit: false,
};

let downloadedPath: string | null = null;

function publish(patch: Partial<UpdaterState>): UpdaterState {
  state = { ...state, ...patch };
  emit({ type: 'updater/state', payload: state });
  return state;
}

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

export function initializeUpdater(): void {
  const settings = getSettings();
  state = {
    phase: app.isPackaged ? 'idle' : 'unsupported',
    channel: settings.updateChannel,
    currentVersion: app.getVersion(),
    autoInstallOnQuit: settings.autoInstallUpdates,
  };
}

export function currentState(): UpdaterState {
  return state;
}

export function setChannel(channel: UpdateChannel): UpdaterState {
  if (channel !== 'stable' && channel !== 'beta' && channel !== 'nightly') {
    failure('E_INVALID_ARGUMENT', `Canal de publicacion desconocido: ${String(channel)}`);
  }
  setSettings({ updateChannel: channel });
  return publish({ channel, phase: 'idle', available: undefined });
}

/* -------------------------------------------------------------------------- */
/*  electron-updater (opcional)                                                */
/* -------------------------------------------------------------------------- */

interface ElectronUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

let electronUpdater: ElectronUpdater | null | undefined;

function loadElectronUpdater(): ElectronUpdater | null {
  if (electronUpdater !== undefined) {
    return electronUpdater;
  }
  try {
    // Dependencia opcional: su ausencia activa el cliente propio.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('electron-updater') as { autoUpdater?: ElectronUpdater };
    electronUpdater = module.autoUpdater ?? null;
    if (electronUpdater !== null) {
      wireElectronUpdater(electronUpdater);
    }
  } catch {
    electronUpdater = null;
  }
  return electronUpdater;
}

function wireElectronUpdater(updater: ElectronUpdater): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = getSettings().autoInstallUpdates;
  updater.channel = state.channel === 'stable' ? null : state.channel;

  updater.on('update-available', (info: unknown) => {
    const record = info as { version?: string; releaseDate?: string; releaseNotes?: string };
    publish({
      phase: 'available',
      available: {
        version: record.version ?? 'desconocida',
        channel: state.channel,
        ...(record.releaseDate === undefined ? {} : { releaseDate: record.releaseDate }),
        ...(typeof record.releaseNotes === 'string' ? { releaseNotes: record.releaseNotes } : {}),
      },
    });
  });

  updater.on('update-not-available', () => {
    publish({ phase: 'not-available', lastCheckedAt: Date.now() });
  });

  updater.on('download-progress', (progress: unknown) => {
    const record = progress as { percent?: number; bytesPerSecond?: number };
    publish({
      phase: 'downloading',
      progressPercent: Math.round(record.percent ?? 0),
      ...(record.bytesPerSecond === undefined ? {} : { bytesPerSecond: record.bytesPerSecond }),
    });
  });

  updater.on('update-downloaded', () => {
    publish({ phase: 'ready', progressPercent: 100 });
  });

  updater.on('error', (cause: unknown) => {
    publish({
      phase: 'error',
      error: forgeError(
        'E_UNKNOWN',
        'El actualizador fallo.',
        cause instanceof Error ? cause.message : String(cause),
      ),
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Feed propio                                                                */
/* -------------------------------------------------------------------------- */

interface FeedEntry {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly size?: number;
  readonly releaseDate?: string;
  readonly releaseNotes?: string;
}

function feedUrl(channel: UpdateChannel): string {
  const base = process.env['FORGE_UPDATE_FEED'] ?? DEFAULT_FEED;
  const platform = process.platform;
  const arch = process.arch;
  return `${base}/${channel}/${platform}-${arch}.json`;
}

async function checkWithFeed(): Promise<UpdaterState> {
  publish({ phase: 'checking' });
  try {
    const response = await fetch(feedUrl(state.channel), {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return publish({
        phase: 'error',
        lastCheckedAt: Date.now(),
        error: forgeError('E_NETWORK', `El feed respondio con estado ${response.status}.`),
      });
    }
    const entry = (await response.json()) as Partial<FeedEntry>;
    if (typeof entry.version !== 'string' || typeof entry.url !== 'string' || typeof entry.sha256 !== 'string') {
      return publish({
        phase: 'error',
        lastCheckedAt: Date.now(),
        error: forgeError('E_PARSE', 'El feed de actualizaciones no tiene el formato esperado.'),
      });
    }
    if (!isNewerVersion(entry.version, state.currentVersion)) {
      return publish({ phase: 'not-available', lastCheckedAt: Date.now() });
    }

    const available: UpdateInfoView = {
      version: entry.version,
      channel: state.channel,
      sha256: entry.sha256,
      url: entry.url,
      ...(entry.size === undefined ? {} : { sizeBytes: entry.size }),
      ...(entry.releaseDate === undefined ? {} : { releaseDate: entry.releaseDate }),
      ...(entry.releaseNotes === undefined ? {} : { releaseNotes: entry.releaseNotes }),
    };
    return publish({ phase: 'available', available, lastCheckedAt: Date.now() });
  } catch (cause) {
    return publish({
      phase: 'error',
      lastCheckedAt: Date.now(),
      error: forgeError(
        'E_NETWORK',
        'No se pudo consultar el feed de actualizaciones.',
        cause instanceof Error ? cause.message : String(cause),
      ),
    });
  }
}

/** Descarga verificando el SHA-256 declarado en el feed. */
async function downloadWithFeed(): Promise<true> {
  const available = state.available;
  if (available?.url === undefined || available.sha256 === undefined) {
    failure('E_INVALID_ARGUMENT', 'No hay ninguna actualizacion preparada para descargar.');
  }

  const directory = path.join(app.getPath('userData'), 'updates');
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, path.basename(new URL(available.url).pathname));

  publish({ phase: 'downloading', progressPercent: 0 });

  const response = await fetch(available.url);
  if (!response.ok || response.body === null) {
    publish({
      phase: 'error',
      error: forgeError('E_NETWORK', `La descarga fallo con estado ${response.status}.`),
    });
    return true;
  }

  const total = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
  const hash = createHash('sha256');
  let received = 0;
  const startedAt = Date.now();

  const source = Readable.fromWeb(response.body as never);
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.byteLength;
    if (total > 0) {
      const elapsed = Math.max(1, Date.now() - startedAt);
      publish({
        phase: 'downloading',
        progressPercent: Math.round((received / total) * 100),
        bytesPerSecond: Math.round((received / elapsed) * 1000),
      });
    }
  });

  try {
    await pipeline(source, createWriteStream(target));
  } catch (cause) {
    rmSync(target, { force: true });
    publish({
      phase: 'error',
      error: forgeError(
        'E_NETWORK',
        'La descarga se interrumpio.',
        cause instanceof Error ? cause.message : String(cause),
      ),
    });
    return true;
  }

  publish({ phase: 'verifying' });
  const digest = hash.digest('hex');
  if (digest.toLowerCase() !== available.sha256.toLowerCase()) {
    // Un binario que no cuadra con su suma NO se conserva.
    rmSync(target, { force: true });
    publish({
      phase: 'error',
      error: forgeError(
        'E_PERMISSION',
        'La suma SHA-256 del paquete descargado no coincide.',
        'La descarga se descarto por seguridad.',
      ),
    });
    return true;
  }

  downloadedPath = target;
  publish({ phase: 'ready', progressPercent: 100 });
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Entrada publica                                                            */
/* -------------------------------------------------------------------------- */

export async function checkForUpdates(): Promise<UpdaterState> {
  if (!app.isPackaged) {
    return publish({
      phase: 'unsupported',
      lastCheckedAt: Date.now(),
      error: forgeError('E_UNSUPPORTED', 'Las actualizaciones solo funcionan en la app empaquetada.'),
    });
  }
  const updater = loadElectronUpdater();
  if (updater !== null) {
    publish({ phase: 'checking' });
    updater.channel = state.channel === 'stable' ? null : state.channel;
    try {
      await updater.checkForUpdates();
    } catch (cause) {
      publish({
        phase: 'error',
        error: forgeError(
          'E_NETWORK',
          'No se pudo comprobar si hay actualizaciones.',
          cause instanceof Error ? cause.message : String(cause),
        ),
      });
    }
    return state;
  }
  return checkWithFeed();
}

export async function downloadUpdate(): Promise<true> {
  if (state.phase !== 'available') {
    failure('E_INVALID_ARGUMENT', 'No hay ninguna actualizacion disponible.');
  }
  const updater = loadElectronUpdater();
  if (updater !== null) {
    publish({ phase: 'downloading', progressPercent: 0 });
    await updater.downloadUpdate();
    return true;
  }
  return downloadWithFeed();
}

/**
 * Aplica la actualizacion. Con `restartNow` en false queda pendiente para el
 * proximo arranque, que es lo que espera quien esta a mitad de una tarea.
 */
export function installUpdate(restartNow: boolean): true {
  if (state.phase !== 'ready') {
    failure('E_INVALID_ARGUMENT', 'No hay ninguna actualizacion lista para instalar.');
  }
  const updater = loadElectronUpdater();
  if (updater !== null) {
    updater.autoInstallOnAppQuit = true;
    if (restartNow) {
      updater.quitAndInstall(false, true);
    } else {
      publish({ autoInstallOnQuit: true });
    }
    return true;
  }

  if (downloadedPath === null || !existsSync(downloadedPath)) {
    failure('E_NOT_FOUND', 'El paquete descargado ya no esta disponible.');
  }
  if (!restartNow) {
    publish({ autoInstallOnQuit: true });
    return true;
  }

  // Sin electron-updater no se puede sustituir la instalacion en caliente
  // de forma segura; se abre el instalador verificado y se cierra el IDE.
  const { shell } = require('electron') as typeof import('electron');
  void shell.openPath(downloadedPath).then(() => {
    app.quit();
  });
  return true;
}

/** Paquete verificado pendiente de instalar, si lo hay. */
export function pendingPackage(): string | null {
  return downloadedPath;
}
