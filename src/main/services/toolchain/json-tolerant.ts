/**
 * Analizador de JSON tolerante.
 *
 * Los archivos de configuracion reales del ecosistema JS no son JSON puro:
 * `tsconfig.json` admite comentarios, muchos generadores dejan comas
 * sobrantes y Windows anade BOM. Este modulo acepta todo eso sin recurrir a
 * `eval` ni a `new Function`, y ademas informa de la posicion de cada clave
 * para poder colocar diagnosticos en el editor.
 */

export interface JsonParseResult<T> {
  readonly value: T | null;
  readonly warnings: readonly string[];
  readonly error?: { readonly message: string; readonly line: number; readonly column: number };
}

const BOM = '\uFEFF';

/**
 * Elimina comentarios de linea y de bloque respetando las cadenas.
 * Sustituye por espacios en vez de recortar, para que las posiciones de
 * los errores sigan correspondiendo con el texto original.
 */
export function stripJsonComments(source: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < source.length) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false;
        out += character;
      } else {
        out += ' ';
      }
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        index += 2;
        continue;
      }
      out += character === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (inString) {
      out += character;
      if (character === '\\') {
        out += next;
        index += 2;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (character === '"') {
      inString = true;
      out += character;
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      inLineComment = true;
      out += '  ';
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      index += 2;
      continue;
    }

    out += character;
    index += 1;
  }

  return out;
}

/** Elimina comas sobrantes antes de `}` o `]`, respetando las cadenas. */
export function stripTrailingCommas(source: string): string {
  let out = '';
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';

    if (inString) {
      out += character;
      if (character === '\\') {
        out += source[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === ',') {
      // Mira adelante saltando espacios: si viene un cierre, la coma sobra.
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead] ?? '')) {
        lookahead += 1;
      }
      const following = source[lookahead];
      if (following === '}' || following === ']') {
        out += ' ';
        continue;
      }
    }
    out += character;
  }

  return out;
}

/** Convierte un desplazamiento en linea y columna de base 1. */
export function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lastBreak = index;
    }
  }
  return { line, column: offset - lastBreak };
}

/**
 * Analiza JSON con comentarios y comas sobrantes. Nunca lanza: devuelve el
 * error como dato para que la capa IPC lo transporte y el editor lo pinte.
 */
export function parseJsonTolerant<T = unknown>(source: string): JsonParseResult<T> {
  const warnings: string[] = [];
  let text = source;

  if (text.startsWith(BOM)) {
    text = text.slice(1);
    warnings.push('El archivo empieza con una marca de orden de bytes (BOM).');
  }
  if (text.trim() === '') {
    return { value: null, warnings, error: { message: 'El archivo esta vacio.', line: 1, column: 1 } };
  }

  const withoutComments = stripJsonComments(text);
  if (withoutComments !== text) {
    warnings.push('El archivo contiene comentarios; se ignoraron al analizarlo.');
  }
  const cleaned = stripTrailingCommas(withoutComments);
  if (cleaned !== withoutComments) {
    warnings.push('El archivo contiene comas sobrantes; se ignoraron al analizarlo.');
  }

  try {
    return { value: JSON.parse(cleaned) as T, warnings };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Node incluye "at position N" en el mensaje; se aprovecha para situar
    // el error en el editor.
    const match = /position (\d+)/.exec(message);
    const offset = match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
    const position = offsetToPosition(cleaned, offset);
    return { value: null, warnings, error: { message, ...position } };
  }
}

/** Localiza la linea de una clave de primer o segundo nivel, para diagnosticos. */
export function findKeyLine(source: string, key: string): number {
  const pattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? '')) {
      return index + 1;
    }
  }
  return 1;
}
