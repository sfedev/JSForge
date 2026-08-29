/**
 * Traduccion entre las URL que usa el inspector y las rutas del workspace.
 *
 * El CDP identifica cada script por una URL `file://`, y en Windows esa URL
 * lleva la unidad codificada de una forma que `path` no entiende sin ayuda
 * (`file:///C:/proyecto/src/x.ts`). Todo eso vive aqui, en funciones puras,
 * porque es justo la clase de logica que falla en silencio: un breakpoint
 * mal traducido no da error, simplemente no se detiene nunca.
 *
 * Ninguna de estas funciones sustituye al guardian de rutas. El llamante
 * sigue pasando la ruta relativa resultante por `assertInsideWorkspace()`.
 */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Prefijos internos de Node: no corresponden a ningun archivo del proyecto. */
const INTERNAL_PREFIXES = ['node:', 'internal/', 'evalmachine.', '<anonymous>'];

export function isInternalUrl(url: string): boolean {
  return INTERNAL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Convierte una URL de script a ruta absoluta del sistema.
 * Devuelve `null` para lo que no sea un archivo real en disco.
 */
export function scriptUrlToAbsolute(url: string): string | null {
  if (url === '' || isInternalUrl(url)) {
    return null;
  }
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  // El inspector tambien emite rutas nativas sin esquema cuando el script se
  // cargo por ruta absoluta.
  return path.isAbsolute(url) ? url : null;
}

/** Ruta absoluta -> URL `file://`, la forma que espera `Debugger.setBreakpointByUrl`. */
export function absoluteToScriptUrl(absolute: string): string {
  return pathToFileURL(absolute).href;
}

/**
 * Ruta relativa del workspace (separador `/`) -> URL `file://` absoluta.
 * El `root` ya viene resuelto y validado por el guardian.
 */
export function workspaceRelativeToScriptUrl(root: string, relative: string): string {
  return absoluteToScriptUrl(path.resolve(root, relative.split('/').join(path.sep)));
}

/**
 * URL de script -> ruta relativa al workspace, o `null` si cae fuera.
 *
 * La comparacion se hace por segmentos con `path.relative`, nunca con
 * `startsWith` sobre cadenas: `C:\proyecto-viejo` empieza igual que
 * `C:\proyecto` y no tiene nada que ver con el.
 */
export function scriptUrlToWorkspaceRelative(root: string, url: string): string | null {
  const absolute = scriptUrlToAbsolute(url);
  if (absolute === null) {
    return null;
  }
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

/**
 * Etiqueta legible de un marco de pila para la vista de depuracion.
 * Los internos de Node se marcan como tales en lugar de mostrar la URL cruda.
 */
export function frameLabel(url: string, relative: string | null): string {
  if (relative !== null) {
    return relative;
  }
  if (url === '') {
    return '(sin origen)';
  }
  if (isInternalUrl(url)) {
    return `${url} (interno de Node)`;
  }
  const absolute = scriptUrlToAbsolute(url);
  return absolute ?? url;
}
