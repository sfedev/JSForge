/**
 * Estado del workspace abierto.
 *
 * Es el unico punto que conoce la raiz real (con symlinks resueltos). El
 * resto de servicios pide la raiz aqui y se la pasa al guardian de rutas;
 * nadie mas guarda una copia, de modo que cerrar el workspace invalida
 * inmediatamente cualquier acceso posterior.
 */

import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

import {
  DOTFORGE_MANIFEST_NAMES,
  forgeError,
  type FileChangeEvent,
  type WorkspaceInfo,
} from '../../shared/contracts.js';
import { WorkspaceGuardError, resolveWorkspaceRoot, toRelative } from '../security/workspace-guard.js';
import { ThrottledBatcher, emit } from '../ipc/event-bus.js';

/** Directorios que nunca se vigilan ni se recorren en busquedas. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.turbo',
  '.nx',
  '.cache',
  '.vite',
  'coverage',
  '.venv',
  '__pycache__',
]);

let current: WorkspaceInfo | null = null;
let watcher: FSWatcher | null = null;

const changeBatcher = new ThrottledBatcher<FileChangeEvent>((items) => {
  emit({ type: 'fs/changed', payload: dedupeChanges(items) });
}, 250);

function dedupeChanges(items: readonly FileChangeEvent[]): readonly FileChangeEvent[] {
  const seen = new Map<string, FileChangeEvent>();
  for (const item of items) {
    seen.set(`${item.type}:${item.path}`, item);
  }
  return [...seen.values()];
}

export function getWorkspace(): WorkspaceInfo | null {
  return current;
}

/** Raiz absoluta real del workspace, o `null` si no hay ninguno abierto. */
export function getWorkspaceRoot(): string | null {
  return current === null ? null : current.root;
}

/** Igual que `getWorkspaceRoot` pero lanza cuando no hay workspace. */
export function requireWorkspaceRoot(): string {
  const root = getWorkspaceRoot();
  if (root === null) {
    throw new WorkspaceGuardError(
      forgeError('E_NO_WORKSPACE', 'No hay ningun workspace abierto.'),
    );
  }
  return root;
}

function describe(root: string): WorkspaceInfo {
  const hasDotForge = DOTFORGE_MANIFEST_NAMES.some((name) => existsSync(path.join(root, name)));
  return {
    root,
    name: path.basename(root) || root,
    hasDotForge,
    hasPackageJson: existsSync(path.join(root, 'package.json')),
    isGitRepo: existsSync(path.join(root, '.git')),
    openedAt: Date.now(),
  };
}

export function openWorkspace(candidate: string): WorkspaceInfo {
  const root = resolveWorkspaceRoot(candidate);
  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new WorkspaceGuardError(
      forgeError('E_NOT_FOUND', 'La carpeta indicada no existe.', candidate),
    );
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceGuardError(
      forgeError('E_INVALID_ARGUMENT', 'El workspace debe ser una carpeta.', candidate),
    );
  }
  stopWatching();
  current = describe(root);
  emit({ type: 'workspace/changed', payload: current });
  return current;
}

export function closeWorkspace(): void {
  stopWatching();
  current = null;
  emit({ type: 'workspace/changed', payload: null });
}

/** Refresca los indicadores derivados (aparicion de .git, dotforge, etc.). */
export function refreshWorkspace(): WorkspaceInfo | null {
  if (current === null) {
    return null;
  }
  const refreshed = { ...describe(current.root), openedAt: current.openedAt };
  current = refreshed;
  return refreshed;
}

/* -------------------------------------------------------------------------- */
/*  Vigilancia del arbol de archivos                                           */
/* -------------------------------------------------------------------------- */

function shouldIgnore(relativePath: string): boolean {
  if (relativePath === '') {
    return true;
  }
  for (const segment of relativePath.split('/')) {
    if (IGNORED_DIRECTORIES.has(segment)) {
      return true;
    }
  }
  return false;
}

export function startWatching(): boolean {
  const root = getWorkspaceRoot();
  if (root === null || watcher !== null) {
    return watcher !== null;
  }
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename === null || filename === undefined) {
        return;
      }
      const name = String(filename);
      const relative = name.split(path.sep).join('/');
      if (shouldIgnore(relative)) {
        return;
      }
      const absolute = path.join(root, name);
      const type: FileChangeEvent['type'] = existsSync(absolute) ? 'modified' : 'deleted';
      changeBatcher.push({ path: relative, type });
    });
    watcher.on('error', (cause) => {
      console.error('[forge] el vigilante de archivos fallo', cause);
      stopWatching();
    });
    return true;
  } catch (cause) {
    // `recursive: true` no esta disponible en todas las plataformas antiguas.
    console.warn('[forge] vigilancia recursiva no disponible', cause);
    watcher = null;
    return false;
  }
}

export function stopWatching(): void {
  changeBatcher.dispose();
  if (watcher !== null) {
    try {
      watcher.close();
    } catch {
      // Ya estaba cerrado.
    }
    watcher = null;
  }
}

/** Traduce una ruta absoluta a relativa al workspace, o `null` si esta fuera. */
export function relativeToWorkspace(absolute: string): string | null {
  return toRelative(getWorkspaceRoot(), absolute);
}

export function setChangeThrottle(intervalMs: number): void {
  changeBatcher.setInterval(intervalMs);
}
