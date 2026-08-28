/**
 * Servicio de sistema de archivos.
 *
 * Todas las operaciones reciben rutas RELATIVAS al workspace y las validan
 * con `assertInsideWorkspace` antes de tocar el disco. Ninguna funcion de
 * este modulo acepta rutas absolutas del renderer.
 *
 * Detalles que importan en un IDE:
 *  - Se preserva el BOM UTF-8 y el estilo de fin de linea del archivo.
 *  - La escritura es atomica (temporal + rename) y detecta ediciones
 *    externas comparando el mtime esperado.
 *  - Los archivos binarios o demasiado grandes se rechazan con un codigo
 *    claro en lugar de devolver basura al editor.
 */

import {
  createReadStream,
  promises as fs,
  type Dirent,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  forgeError,
  type DirEntry,
  type EolStyle,
  type FileKind,
  type FileStat,
  type ReadFileResult,
  type SearchMatch,
  type SearchRequest,
  type SearchResult,
  type WriteFileRequest,
} from '../../shared/contracts.js';
import { assertInsideWorkspace, type GuardedPath } from '../security/workspace-guard.js';
import { IGNORED_DIRECTORIES, requireWorkspaceRoot } from './workspace-service.js';

/** Limite de apertura en el editor: 12 MB de texto ya es patologico. */
const MAX_TEXT_BYTES = 12 * 1024 * 1024;
/** Limite por archivo al buscar; evita bloquearse con bundles y mapas. */
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEARCH_RESULTS = 500;
const BOM = '\uFEFF';

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'psd',
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz', 'lz4', 'zst',
  'mp3', 'mp4', 'wav', 'ogg', 'flac', 'webm', 'mov', 'avi', 'mkv', 'm4a',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'node', 'wasm', 'class', 'jar', 'pdb',
  'db', 'sqlite', 'sqlite3', 'bin', 'dat', 'pack', 'idx', 'lock',
]);

function isBinaryName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function kindOf(entry: Dirent | Stats): FileKind {
  if (entry.isDirectory()) {
    return 'directory';
  }
  if (entry.isSymbolicLink()) {
    return 'symlink';
  }
  if (entry.isFile()) {
    return 'file';
  }
  return 'other';
}

function guard(relativePath: string): GuardedPath {
  return assertInsideWorkspace(requireWorkspaceRoot(), relativePath);
}

function toStat(relative: string, stats: Stats): FileStat {
  return {
    path: relative,
    kind: kindOf(stats),
    size: stats.size,
    modifiedAt: Math.floor(stats.mtimeMs),
    createdAt: Math.floor(stats.birthtimeMs),
  };
}

/* -------------------------------------------------------------------------- */
/*  Lectura                                                                    */
/* -------------------------------------------------------------------------- */

export async function readDirectory(relativePath: string): Promise<readonly DirEntry[]> {
  const target = guard(relativePath);
  const entries = await fs.readdir(target.absolute, { withFileTypes: true });

  const results = await Promise.all(
    entries.map(async (entry): Promise<DirEntry | null> => {
      const childRelative = target.relative === '' ? entry.name : `${target.relative}/${entry.name}`;
      let stats: Stats;
      try {
        stats = await fs.stat(path.join(target.absolute, entry.name));
      } catch {
        // Enlace roto o carrera con un borrado: se omite en lugar de fallar.
        return null;
      }
      return {
        name: entry.name,
        path: childRelative,
        kind: kindOf(entry),
        size: stats.isDirectory() ? 0 : stats.size,
        modifiedAt: Math.floor(stats.mtimeMs),
        binary: !stats.isDirectory() && isBinaryName(entry.name),
      };
    }),
  );

  // Carpetas primero y despues alfabetico, insensible a mayusculas.
  return results
    .filter((entry): entry is DirEntry => entry !== null)
    .sort((a, b) => {
      const aDir = a.kind === 'directory';
      const bDir = b.kind === 'directory';
      if (aDir !== bDir) {
        return aDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

export async function readFile(relativePath: string): Promise<ReadFileResult> {
  const target = guard(relativePath);
  const stats = await fs.stat(target.absolute);

  if (stats.isDirectory()) {
    throw forgeErrorAsThrow('E_INVALID_ARGUMENT', 'La ruta indicada es una carpeta.');
  }
  if (stats.size > MAX_TEXT_BYTES) {
    throw forgeErrorAsThrow(
      'E_TOO_LARGE',
      'El archivo supera el limite de apertura del editor.',
      `${stats.size} bytes (maximo ${MAX_TEXT_BYTES}).`,
    );
  }
  if (isBinaryName(target.relative)) {
    throw forgeErrorAsThrow('E_BINARY', 'El archivo parece binario.', target.relative);
  }

  const buffer = await fs.readFile(target.absolute);
  // Un NUL en los primeros KB delata contenido binario sin extension conocida.
  if (buffer.subarray(0, 4096).includes(0)) {
    throw forgeErrorAsThrow('E_BINARY', 'El archivo contiene bytes nulos.', target.relative);
  }

  let content = buffer.toString('utf8');
  const bom = content.startsWith(BOM);
  if (bom) {
    content = content.slice(1);
  }
  const eol: EolStyle = content.includes('\r\n') ? 'crlf' : 'lf';
  if (eol === 'crlf') {
    content = content.split('\r\n').join('\n');
  }

  return {
    path: target.relative,
    content,
    bom,
    eol,
    size: stats.size,
    modifiedAt: Math.floor(stats.mtimeMs),
  };
}

export async function statPath(relativePath: string): Promise<FileStat> {
  const target = guard(relativePath);
  const stats = await fs.stat(target.absolute);
  return toStat(target.relative, stats);
}

/* -------------------------------------------------------------------------- */
/*  Escritura                                                                  */
/* -------------------------------------------------------------------------- */

function forgeErrorAsThrow(
  code: Parameters<typeof forgeError>[0],
  message: string,
  detail?: string,
): Error & { forge: ReturnType<typeof forgeError> } {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  return error;
}

export async function writeFile(request: WriteFileRequest): Promise<FileStat> {
  if (typeof request?.content !== 'string') {
    throw forgeErrorAsThrow('E_INVALID_ARGUMENT', 'El contenido debe ser una cadena.');
  }
  const target = guard(request.path);

  // Deteccion de edicion externa: solo si el llamante declaro que esperaba
  // una version concreta del archivo.
  if (request.expectedModifiedAt !== undefined) {
    try {
      const current = await fs.stat(target.absolute);
      if (Math.floor(current.mtimeMs) !== request.expectedModifiedAt) {
        throw forgeErrorAsThrow(
          'E_CONFLICT',
          'El archivo cambio en el disco desde la ultima lectura.',
          target.relative,
        );
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw cause;
      }
    }
  }

  const eol: EolStyle = request.eol ?? 'lf';
  const normalized = eol === 'crlf' ? request.content.split('\n').join('\r\n') : request.content;
  const payload = (request.bom === true ? BOM : '') + normalized;

  await fs.mkdir(path.dirname(target.absolute), { recursive: true });

  // Escritura atomica: si el proceso muere a mitad, el archivo original
  // sigue intacto en lugar de quedar truncado.
  const temporary = `${target.absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, payload, 'utf8');
    await fs.rename(temporary, target.absolute);
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }

  return toStat(target.relative, await fs.stat(target.absolute));
}

export async function createFile(relativePath: string, content = ''): Promise<FileStat> {
  const target = guard(relativePath);
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  // `wx` falla si ya existe: crear nunca debe sobrescribir.
  const handle = await fs.open(target.absolute, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return toStat(target.relative, await fs.stat(target.absolute));
}

export async function createDirectory(relativePath: string): Promise<FileStat> {
  const target = guard(relativePath);
  await fs.mkdir(target.absolute, { recursive: true });
  return toStat(target.relative, await fs.stat(target.absolute));
}

export async function renamePath(fromRelative: string, toRelative: string): Promise<FileStat> {
  const from = guard(fromRelative);
  const to = guard(toRelative);
  await fs.mkdir(path.dirname(to.absolute), { recursive: true });
  try {
    // `rename` sobrescribe en POSIX; se comprueba antes para no perder datos.
    await fs.access(to.absolute);
    throw forgeErrorAsThrow('E_ALREADY_EXISTS', 'El destino ya existe.', to.relative);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw cause;
    }
  }
  await fs.rename(from.absolute, to.absolute);
  return toStat(to.relative, await fs.stat(to.absolute));
}

export async function removePath(relativePath: string): Promise<true> {
  const target = guard(relativePath);
  if (target.relative === '') {
    throw forgeErrorAsThrow('E_INVALID_ARGUMENT', 'No se puede borrar la raiz del workspace.');
  }
  await fs.rm(target.absolute, { recursive: true, force: true });
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Busqueda                                                                   */
/* -------------------------------------------------------------------------- */

/** Convierte un glob sencillo (`**`, `*`, `?`) en expresion regular. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        // `**/` cruza cualquier numero de directorios, incluido ninguno.
        pattern += '.*';
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += (character ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`, 'i');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Recorre el workspace saltando los directorios ignorados. */
async function* walk(root: string, relative = ''): AsyncGenerator<{ relative: string; absolute: string }> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      yield* walk(root, childRelative);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    yield { relative: childRelative, absolute: path.join(root, childRelative) };
  }
}

export async function search(request: SearchRequest): Promise<SearchResult> {
  const root = requireWorkspaceRoot();
  const started = Date.now();
  const limit = Math.min(Math.max(request.maxResults ?? DEFAULT_SEARCH_RESULTS, 1), 5000);

  if (typeof request.query !== 'string' || request.query === '') {
    return { matches: [], truncated: false, scannedFiles: 0, elapsedMs: 0 };
  }

  let matcher: RegExp;
  try {
    const source = request.regex === true ? request.query : escapeRegExp(request.query);
    const body = request.wholeWord === true ? `\\b(?:${source})\\b` : source;
    matcher = new RegExp(body, request.caseSensitive === true ? 'g' : 'gi');
  } catch (cause) {
    throw forgeErrorAsThrow(
      'E_INVALID_ARGUMENT',
      'La expresion regular no es valida.',
      cause instanceof Error ? cause.message : undefined,
    );
  }

  const includes = (request.include ?? []).map(globToRegExp);
  const excludes = (request.exclude ?? []).map(globToRegExp);

  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let truncated = false;

  for await (const file of walk(root)) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    if (isBinaryName(file.relative)) {
      continue;
    }
    if (includes.length > 0 && !includes.some((pattern) => pattern.test(file.relative))) {
      continue;
    }
    if (excludes.some((pattern) => pattern.test(file.relative))) {
      continue;
    }

    let stats: Stats;
    try {
      stats = await fs.stat(file.absolute);
    } catch {
      continue;
    }
    if (stats.size > MAX_SEARCH_BYTES) {
      continue;
    }

    scannedFiles += 1;
    const fileMatches = await searchInFile(file.absolute, file.relative, matcher, limit - matches.length);
    matches.push(...fileMatches);
  }

  return {
    matches,
    truncated: truncated || matches.length >= limit,
    scannedFiles,
    elapsedMs: Date.now() - started,
  };
}

/** Lectura por lineas en flujo: no carga el archivo entero en memoria. */
async function searchInFile(
  absolute: string,
  relative: string,
  matcher: RegExp,
  remaining: number,
): Promise<SearchMatch[]> {
  if (remaining <= 0) {
    return [];
  }
  const results: SearchMatch[] = [];
  const stream = createReadStream(absolute, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (line.length > 4000) {
        // Linea de un bundle minificado: no aporta nada al usuario.
        continue;
      }
      matcher.lastIndex = 0;
      let match = matcher.exec(line);
      while (match !== null) {
        results.push({
          path: relative,
          line: lineNumber,
          column: match.index + 1,
          length: match[0].length,
          preview: line.trim().slice(0, 240),
        });
        if (results.length >= remaining) {
          return results;
        }
        if (match[0] === '') {
          matcher.lastIndex += 1;
        }
        match = matcher.exec(line);
      }
    }
  } finally {
    reader.close();
    stream.close();
  }
  return results;
}

/** Busqueda de archivos por nombre (para "Ir al archivo"). */
export async function findFilesByName(query: string, limit = 200): Promise<readonly string[]> {
  const root = requireWorkspaceRoot();
  const needle = query.toLowerCase();
  const found: string[] = [];
  for await (const file of walk(root)) {
    if (file.relative.toLowerCase().includes(needle)) {
      found.push(file.relative);
      if (found.length >= limit) {
        break;
      }
    }
  }
  return found;
}

/** Lee un archivo del workspace como texto plano, sin validar tamano. */
export async function readTextIfExists(relativePath: string): Promise<string | null> {
  try {
    const target = guard(relativePath);
    const buffer = await fs.readFile(target.absolute);
    return buffer.toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

export async function exists(relativePath: string): Promise<boolean> {
  try {
    const target = guard(relativePath);
    await fs.access(target.absolute);
    return true;
  } catch {
    return false;
  }
}
