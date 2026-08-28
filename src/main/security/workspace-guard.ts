/**
 * Guardian de rutas del proceso principal.
 *
 * Toda ruta que llegue desde el renderer pasa obligatoriamente por
 * `assertInsideWorkspace`. La comprobacion es estructural (no textual):
 *
 *  1. Se rechazan rutas absolutas, unidades de Windows y rutas UNC.
 *  2. Se normaliza y se resuelve contra la raiz del workspace.
 *  3. Se resuelven los enlaces simbolicos del prefijo existente mas largo,
 *     de modo que un symlink que apunte fuera del workspace no sirva de fuga.
 *  4. Se compara con la raiz ya resuelta usando separadores reales.
 *
 * Ninguna comparacion se hace con `startsWith` sobre cadenas crudas: eso
 * dejaria pasar `/ws-malicioso` cuando la raiz es `/ws`.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

import { forgeError, type ForgeError } from '../../shared/contracts.js';

/** Error lanzado cuando una ruta no pertenece al workspace abierto. */
export class WorkspaceGuardError extends Error {
  public readonly forge: ForgeError;

  public constructor(forge: ForgeError) {
    super(forge.message);
    this.name = 'WorkspaceGuardError';
    this.forge = forge;
  }
}

const NULL_BYTE = '\u0000';

/** Prefijos de dispositivo de Windows que nunca deben aceptarse. */
const WINDOWS_DEVICE_RE = /^(\\\\|\/\/|[a-zA-Z]:)/;

/** Nombres reservados de Windows (CON, PRN, AUX, NUL, COM1..9, LPT1..9). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function guardFail(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  throw new WorkspaceGuardError(forgeError(code, message, detail));
}

/**
 * Resuelve la raiz del workspace una sola vez, eliminando symlinks.
 * Se llama al abrir el workspace; el resultado se cachea en el servicio.
 */
export function resolveWorkspaceRoot(candidate: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    guardFail('E_INVALID_ARGUMENT', 'La ruta del workspace esta vacia.');
  }
  if (candidate.includes(NULL_BYTE)) {
    guardFail('E_INVALID_ARGUMENT', 'La ruta del workspace contiene bytes nulos.');
  }
  if (!path.isAbsolute(candidate)) {
    guardFail('E_INVALID_ARGUMENT', 'La ruta del workspace debe ser absoluta.');
  }
  const normalized = path.resolve(candidate);
  try {
    return realpathSync.native(normalized);
  } catch {
    // El directorio puede no existir todavia (p. ej. destino de scaffolding).
    return normalized;
  }
}

/**
 * Normaliza una ruta relativa recibida del renderer.
 * Devuelve la forma canonica con separadores POSIX, o lanza si es invalida.
 */
export function normalizeRelative(relativePath: string): string {
  if (typeof relativePath !== 'string') {
    guardFail('E_INVALID_ARGUMENT', 'La ruta debe ser una cadena.');
  }
  if (relativePath.includes(NULL_BYTE)) {
    guardFail('E_INVALID_ARGUMENT', 'La ruta contiene bytes nulos.');
  }
  // Se acepta la raiz explicita en cualquiera de sus formas.
  const trimmed = relativePath.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './' || trimmed === '/') {
    return '';
  }
  if (WINDOWS_DEVICE_RE.test(trimmed)) {
    guardFail(
      'E_OUTSIDE_WORKSPACE',
      'Solo se aceptan rutas relativas al workspace.',
      'Se recibio una ruta absoluta, UNC o con letra de unidad.',
    );
  }
  if (path.isAbsolute(trimmed)) {
    guardFail('E_OUTSIDE_WORKSPACE', 'Solo se aceptan rutas relativas al workspace.');
  }

  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      if (stack.length === 0) {
        guardFail(
          'E_OUTSIDE_WORKSPACE',
          'La ruta intenta salir del workspace.',
          `Segmento invalido en "${relativePath}".`,
        );
      }
      stack.pop();
      continue;
    }
    if (WINDOWS_RESERVED_RE.test(segment)) {
      guardFail(
        'E_INVALID_ARGUMENT',
        'La ruta usa un nombre reservado del sistema.',
        `Segmento "${segment}".`,
      );
    }
    stack.push(segment);
  }
  return stack.join('/');
}

/**
 * Resuelve el prefijo existente mas largo de `absolute` mediante `realpath`,
 * y le vuelve a anadir la cola inexistente. Permite validar rutas de archivos
 * que aun no se han creado sin abrir un hueco por symlinks intermedios.
 */
function realpathLongestExistingPrefix(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];
  // Como maximo se sube hasta la raiz del volumen.
  for (let depth = 0; depth < 4096; depth += 1) {
    try {
      const resolved = realpathSync.native(current);
      return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return absolute;
}

/** true si `child` es igual a `parent` o cuelga estrictamente de el. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') {
    return true;
  }
  if (relative.startsWith('..')) {
    // `path.relative` devuelve ".." o "../..." cuando child esta fuera.
    const first = relative.split(/[\\/]/)[0];
    if (first === '..') {
      return false;
    }
  }
  return !path.isAbsolute(relative);
}

export interface GuardedPath {
  /** Ruta relativa canonica con separadores POSIX (''para la raiz). */
  readonly relative: string;
  /** Ruta absoluta del sistema, lista para las APIs de `node:fs`. */
  readonly absolute: string;
}

/**
 * Valida que `relativePath` pertenezca estricta y unicamente al workspace.
 *
 * @throws {WorkspaceGuardError} si no hay workspace abierto o la ruta escapa.
 */
export function assertInsideWorkspace(
  workspaceRoot: string | null,
  relativePath: string,
): GuardedPath {
  if (workspaceRoot === null || workspaceRoot === '') {
    guardFail('E_NO_WORKSPACE', 'No hay ningun workspace abierto.');
  }
  const relative = normalizeRelative(relativePath);
  const absolute = relative === '' ? workspaceRoot : path.join(workspaceRoot, relative);

  // Comprobacion previa sobre la forma lexica.
  if (!isInside(workspaceRoot, absolute)) {
    guardFail('E_OUTSIDE_WORKSPACE', 'La ruta queda fuera del workspace.', relativePath);
  }

  // Comprobacion definitiva resolviendo enlaces simbolicos.
  const realAbsolute = realpathLongestExistingPrefix(absolute);
  if (!isInside(workspaceRoot, realAbsolute)) {
    guardFail(
      'E_OUTSIDE_WORKSPACE',
      'La ruta apunta fuera del workspace a traves de un enlace simbolico.',
      relativePath,
    );
  }

  return { relative, absolute };
}

/**
 * Convierte una ruta absoluta del sistema en su equivalente relativa al
 * workspace. Devuelve `null` si la ruta esta fuera.
 */
export function toRelative(workspaceRoot: string | null, absolute: string): string | null {
  if (workspaceRoot === null || workspaceRoot === '') {
    return null;
  }
  if (!isInside(workspaceRoot, absolute)) {
    return null;
  }
  const relative = path.relative(workspaceRoot, absolute);
  return relative.split(path.sep).join('/');
}

/** Valida un lote de rutas y devuelve sus formas absolutas. */
export function assertAllInsideWorkspace(
  workspaceRoot: string | null,
  relativePaths: readonly string[],
): readonly GuardedPath[] {
  if (!Array.isArray(relativePaths)) {
    guardFail('E_INVALID_ARGUMENT', 'Se esperaba una lista de rutas.');
  }
  return relativePaths.map((candidate) => assertInsideWorkspace(workspaceRoot, candidate));
}
