/**
 * Localizador de bloques de prueba en un archivo fuente.
 *
 * Encuentra `describe`, `it`, `test`, `suite` y `bench` con sus posiciones y
 * su anidamiento, para que el editor pueda pintar un code lens sobre cada
 * uno y ejecutarlo por separado.
 *
 * Se hace por analisis textual, no evaluando el archivo. Es la misma regla
 * que rige en todo el proyecto —nunca se ejecuta codigo ajeno— y ademas es
 * lo unico viable: el archivo puede importar medio proyecto y no compilar
 * todavia.
 *
 * Lo que el analizador si respeta, porque de lo contrario daria falsos
 * positivos constantes: comentarios, cadenas (incluidas las de plantilla con
 * interpolacion anidada) y expresiones regulares. Un `// it('...')` comentado
 * no debe aparecer como prueba ejecutable.
 */

import type { TestBlock, TestBlockKind, TestModifier } from '../../../shared/contracts.js';

/** Funciones que abren un bloque. El valor indica si agrupa o es un caso. */
const OPENERS: Readonly<Record<string, TestBlockKind>> = {
  describe: 'suite',
  suite: 'suite',
  context: 'suite',
  it: 'case',
  test: 'case',
  bench: 'case',
  specify: 'case',
};

const MODIFIERS: readonly TestModifier[] = ['only', 'skip', 'todo', 'failing', 'concurrent'];

/** Extensiones que este IDE considera archivos de prueba. */
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestFile(relativePath: string): boolean {
  return TEST_FILE_RE.test(relativePath);
}

/* -------------------------------------------------------------------------- */
/*  Tokenizado minimo                                                          */
/* -------------------------------------------------------------------------- */

interface Position {
  readonly index: number;
  readonly line: number;
  readonly column: number;
}

/**
 * Recorre el texto saltando lo que no es codigo y anota, por cada posicion
 * relevante, la linea y la columna. Devuelve una copia del texto en la que
 * comentarios, cadenas y expresiones regulares se han sustituido por
 * espacios (conservando los saltos de linea), de forma que las posiciones
 * siguen coincidiendo con el original.
 */
export function blankNonCode(source: string): string {
  const out: string[] = [];
  let index = 0;

  /** Ultimo caracter de codigo significativo: decide si `/` abre regex. */
  let lastMeaningful = '';

  const push = (text: string, blank: boolean): void => {
    if (!blank) {
      out.push(text);
      return;
    }
    // Se conservan los saltos para no descuadrar la numeracion de lineas.
    out.push(text.replace(/[^\n]/g, ' '));
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    /* --- Comentarios --- */
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      push(source.slice(index, stop), true);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      push(source.slice(index, stop), true);
      index = stop;
      continue;
    }

    /* --- Cadenas --- */
    if (char === '"' || char === "'") {
      const stop = skipQuoted(source, index, char);
      push(source.slice(index, stop), true);
      index = stop;
      lastMeaningful = '"';
      continue;
    }
    if (char === '`') {
      const stop = skipTemplate(source, index);
      push(source.slice(index, stop), true);
      index = stop;
      lastMeaningful = '`';
      continue;
    }

    /* --- Expresiones regulares --- */
    // `/` es division o inicio de regex segun lo que venga antes. Tras un
    // identificador o un cierre es division; en cualquier otro sitio, regex.
    if (char === '/' && !/[\w)\]]/.test(lastMeaningful)) {
      const stop = skipRegex(source, index);
      if (stop > index) {
        push(source.slice(index, stop), true);
        index = stop;
        continue;
      }
    }

    push(char, false);
    if (!/\s/.test(char)) {
      lastMeaningful = char;
    }
    index += 1;
  }

  return out.join('');
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    // Una cadena normal no cruza lineas: si lo hace, esta sin cerrar.
    if (char === '\n') {
      return index;
    }
    index += 1;
  }
  return source.length;
}

/** Cadena de plantilla, contando las interpolaciones anidadas. */
function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '`') {
      return index + 1;
    }
    if (char === '$' && source[index + 1] === '{') {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === '{') {
          depth += 1;
        } else if (inner === '}') {
          depth -= 1;
        } else if (inner === '`') {
          // Plantilla dentro de la interpolacion.
          index = skipTemplate(source, index) - 1;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return source.length;
}

/** Devuelve el final de la regex, o `start` si no lo parecia. */
function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '\n') {
      return start;
    }
    if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      index += 1;
      // Banderas.
      while (index < source.length && /[a-z]/i.test(source[index] ?? '')) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  return start;
}

/* -------------------------------------------------------------------------- */
/*  Extraccion del titulo                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Lee el primer argumento de la llamada: el titulo de la prueba.
 *
 * Se toma del texto ORIGINAL (el enmascarado ha borrado las cadenas), y solo
 * se acepta un literal. Un titulo calculado (`it(nombre, …)`) no se puede
 * conocer sin ejecutar, asi que se devuelve `null` y el bloque se descarta.
 */
export function readTitle(source: string, openParen: number): string | null {
  let index = openParen + 1;
  while (index < source.length && /\s/.test(source[index] ?? '')) {
    index += 1;
  }
  const quote = source[index] ?? '';
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return null;
  }

  let text = '';
  index += 1;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '\\') {
      const escaped = source[index + 1] ?? '';
      text += escaped === 'n' ? '\n' : escaped;
      index += 2;
      continue;
    }
    if (char === quote) {
      return text;
    }
    if (char === '\n' && quote !== '`') {
      return null;
    }
    // En una plantilla, la interpolacion se conserva tal cual: es lo que el
    // usuario ve en el archivo y basta para identificar la prueba.
    text += char;
    index += 1;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Analisis                                                                   */
/* -------------------------------------------------------------------------- */

interface RawBlock {
  readonly kind: TestBlockKind;
  readonly name: string;
  readonly modifier: TestModifier;
  readonly line: number;
  readonly column: number;
  /** Indice del `{` que abre el cuerpo, o -1 si no se encontro. */
  readonly bodyStart: number;
  /** Indice del `}` que lo cierra. */
  bodyEnd: number;
  children: RawBlock[];
}

/** Posiciones de linea y columna a partir de un indice. */
function positionOf(source: string, index: number): Position {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source[cursor] === '\n') {
      line += 1;
      lineStart = cursor + 1;
    }
  }
  return { index, line, column: index - lineStart + 1 };
}

/** Cierre de la llave abierta en `openIndex`, o -1 si no cierra. */
function matchBrace(masked: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Comprueba el contexto inmediatamente anterior a la llamada.
 *
 * Sin punto delante, siempre vale. Con punto, solo si quien cualifica es
 * otro global del framework (`test.describe`, `describe.each`), nunca un
 * objeto cualquiera.
 */
export function isValidQualifier(masked: string, callIndex: number): boolean {
  const before = masked.slice(0, callIndex).trimEnd();
  if (!before.endsWith('.')) {
    return true;
  }
  const qualifier = /([A-Za-z_$][\w$]*)\s*\.$/.exec(before)?.[1];
  return qualifier !== undefined && OPENERS[qualifier] !== undefined;
}

const CALL_RE =
  /\b(describe|suite|context|it|test|bench|specify)\s*(?:\.\s*(only|skip|todo|failing|concurrent|each|sequential)\s*)?(?:\([^)]*\)\s*)?\(/g;

/**
 * Analiza el archivo y devuelve el arbol de bloques.
 *
 * El anidamiento se deduce por los indices del cuerpo: un bloque cuyo rango
 * cae dentro del de otro es su hijo. Es mas robusto que contar llaves sobre
 * la marcha, porque un `it` dentro de un `forEach` dentro de un `describe`
 * sigue quedando en su sitio.
 */
export function parseTestBlocks(relativePath: string, source: string): readonly TestBlock[] {
  const masked = blankNonCode(source);
  const raw: RawBlock[] = [];

  CALL_RE.lastIndex = 0;
  for (let match = CALL_RE.exec(masked); match !== null; match = CALL_RE.exec(masked)) {
    const fn = match[1] ?? '';
    const kind = OPENERS[fn];
    if (kind === undefined) {
      continue;
    }
    // Una llamada cualificada solo vale si el objeto es a su vez un global
    // del propio framework: `test.describe(...)` de Playwright es legitimo,
    // pero `mock.test(...)` no es una prueba. Rechazar todo lo que lleve un
    // punto delante se cargaria las suites de Playwright enteras.
    if (!isValidQualifier(masked, match.index)) {
      continue;
    }

    const openParen = match.index + match[0].length - 1;
    const name = readTitle(source, openParen);
    if (name === null) {
      // Titulo calculado: no se puede saber sin ejecutar.
      continue;
    }

    const rawModifier = match[2];
    const modifier: TestModifier =
      rawModifier !== undefined && MODIFIERS.includes(rawModifier as TestModifier)
        ? (rawModifier as TestModifier)
        : rawModifier === 'each'
          ? 'each'
          : 'none';

    // El cuerpo empieza en la primera llave tras la coma del titulo.
    const bodyStart = masked.indexOf('{', openParen);
    const bodyEnd = bodyStart === -1 ? -1 : matchBrace(masked, bodyStart);
    const position = positionOf(source, match.index);

    raw.push({
      kind,
      name,
      modifier,
      line: position.line,
      column: position.column,
      bodyStart,
      bodyEnd: bodyEnd === -1 ? masked.length : bodyEnd,
      children: [],
    });
  }

  /* --- Anidamiento por contencion de rangos --- */
  const roots: RawBlock[] = [];
  // Se recorre en orden de aparicion y se apila lo que sigue abierto.
  const stack: RawBlock[] = [];

  for (const block of raw) {
    while (stack.length > 0) {
      const parent = stack[stack.length - 1];
      if (parent !== undefined && block.bodyStart < parent.bodyEnd && parent.bodyStart !== -1) {
        break;
      }
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(block);
    } else {
      parent.children.push(block);
    }
    if (block.bodyStart !== -1) {
      stack.push(block);
    }
  }

  return roots.map((block) => toTestBlock(relativePath, block, ''));
}

function toTestBlock(relativePath: string, block: RawBlock, prefix: string): TestBlock {
  // El nombre completo es lo que los runners usan para filtrar con `-t`.
  const fullName = prefix === '' ? block.name : `${prefix} > ${block.name}`;
  return {
    id: `${relativePath}::${fullName}`,
    kind: block.kind,
    name: block.name,
    fullName,
    path: relativePath,
    line: block.line,
    column: block.column,
    modifier: block.modifier,
    children: block.children.map((child) => toTestBlock(relativePath, child, fullName)),
  };
}

/** Aplana el arbol; util para contar y para buscar por nombre. */
export function flattenBlocks(blocks: readonly TestBlock[]): readonly TestBlock[] {
  const out: TestBlock[] = [];
  const visit = (block: TestBlock): void => {
    out.push(block);
    for (const child of block.children) {
      visit(child);
    }
  };
  for (const block of blocks) {
    visit(block);
  }
  return out;
}
