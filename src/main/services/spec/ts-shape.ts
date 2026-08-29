/**
 * Extractor de la forma publica de un modulo TypeScript.
 *
 * Lee `export interface`, `export type` y `export const` por analisis
 * TEXTUAL. No se evalua nada ni se carga el compilador de TypeScript:
 *
 *  - Evaluar `src/shared/contracts.ts` significaria ejecutar codigo del
 *    proyecto dentro del proceso principal, que es justo lo que este IDE no
 *    hace en ningun sitio (ni con `vite.config.ts` ni con `next.config.js`).
 *  - Cargar `typescript` para esto costaria unos 8 MB y medio segundo en un
 *    proceso cuyo arranque instantaneo es un requisito.
 *
 * A cambio, el extractor acepta lo que cubre el 99% de un archivo de
 * contratos: interfaces con miembros de una linea, alias de union y de tipos
 * simples, y enumeraciones de cadenas. Lo que no entiende lo declara en
 * `unparsed` en vez de inventarse una forma.
 */

/** Miembro de una interfaz. */
export interface ShapeMember {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly readonly: boolean;
}

export type ShapeKind = 'interface' | 'union' | 'alias' | 'const';

export interface Shape {
  readonly name: string;
  readonly kind: ShapeKind;
  /** Solo en `interface`. */
  readonly members: readonly ShapeMember[];
  /** Solo en `union`: los miembros literales, normalizados y ordenados. */
  readonly variants: readonly string[];
  /** Texto del tipo para `alias`. */
  readonly aliasOf: string;
  readonly line: number;
}

export interface ModuleShape {
  readonly shapes: ReadonlyMap<string, Shape>;
  /** Declaraciones exportadas que el extractor no supo interpretar. */
  readonly unparsed: readonly string[];
}

/**
 * Quita comentarios de bloque y de linea.
 *
 * Se hace por caracteres y no con una expresion regular porque una cadena
 * como `'http://x'` contiene `//` y se llevaria por delante media linea.
 */
export function stripComments(source: string): string {
  let out = '';
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (quote !== null) {
      out += char;
      if (char === '\\') {
        // Se copia el escapado entero para no cerrar la cadena por error.
        out += next;
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        // Se conservan los saltos de linea para no descuadrar la numeracion.
        if (source[index] === '\n') {
          out += '\n';
        }
        index += 1;
      }
      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

/** Numero de linea (1-based) de un desplazamiento dentro del texto. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * Cuerpo entre llaves a partir de la de apertura, contando anidamiento.
 * Devuelve `null` si las llaves no cierran (archivo a medio escribir).
 */
function readBraceBody(source: string, openIndex: number): { body: string; end: number } | null {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(openIndex + 1, index), end: index };
      }
    }
  }
  return null;
}

/**
 * Parte el cuerpo de una interfaz en miembros.
 *
 * El separador es `;` o salto de linea, pero solo en el nivel superior: un
 * miembro puede llevar un tipo objeto o una firma de funcion con sus propios
 * separadores dentro.
 */
export function splitMembers(body: string): string[] {
  const members: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;

  for (const char of body) {
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '{' || char === '(' || char === '[' || char === '<') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']' || char === '>') {
      depth -= 1;
    }

    if (depth === 0 && (char === ';' || char === '\n')) {
      if (current.trim() !== '') {
        members.push(current.trim());
      }
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') {
    members.push(current.trim());
  }
  return members;
}

/** Interpreta `readonly nombre?: Tipo`. */
export function parseMember(text: string): ShapeMember | null {
  let rest = text.trim();
  let isReadonly = false;
  if (rest.startsWith('readonly ')) {
    isReadonly = true;
    rest = rest.slice('readonly '.length).trim();
  }

  // Se busca el primer `:` fuera de corchetes: una firma de indice
  // (`[key: string]: T`) tiene uno dentro que no separa nombre de tipo.
  let depth = 0;
  let colon = -1;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    if (char === '[' || char === '(' || char === '<' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === ')' || char === '>' || char === '}') {
      depth -= 1;
    } else if (char === ':' && depth === 0) {
      colon = index;
      break;
    }
  }
  if (colon === -1) {
    return null;
  }

  let name = rest.slice(0, colon).trim();
  const type = rest.slice(colon + 1).trim().replace(/[,;]$/, '');
  const optional = name.endsWith('?');
  if (optional) {
    name = name.slice(0, -1).trim();
  }
  if (name === '' || type === '') {
    return null;
  }
  return { name, type, optional, readonly: isReadonly };
}

/** Normaliza una union a sus variantes ordenadas, para poder compararlas. */
export function unionVariants(text: string): string[] {
  const variants: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;

  for (const char of text) {
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '{' || char === '(' || char === '<' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === '>' || char === ']') {
      depth -= 1;
    }
    if (char === '|' && depth === 0) {
      if (current.trim() !== '') {
        variants.push(current.trim());
      }
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') {
    variants.push(current.trim());
  }
  return variants.sort((a, b) => a.localeCompare(b));
}

/* -------------------------------------------------------------------------- */
/*  Extraccion                                                                 */
/* -------------------------------------------------------------------------- */

const INTERFACE_RE = /export\s+interface\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+[^{]+)?\{/g;
const TYPE_RE = /export\s+type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/g;
const CONST_RE = /export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/g;

/** Analiza el modulo y devuelve su superficie exportada. */
export function extractModuleShape(source: string): ModuleShape {
  const clean = stripComments(source);
  const shapes = new Map<string, Shape>();
  const unparsed: string[] = [];

  /* --- Interfaces --- */
  INTERFACE_RE.lastIndex = 0;
  for (let match = INTERFACE_RE.exec(clean); match !== null; match = INTERFACE_RE.exec(clean)) {
    const name = match[1] ?? '';
    const open = clean.indexOf('{', match.index);
    const block = open === -1 ? null : readBraceBody(clean, open);
    if (block === null) {
      unparsed.push(name);
      continue;
    }
    const members: ShapeMember[] = [];
    for (const raw of splitMembers(block.body)) {
      const member = parseMember(raw);
      if (member === null) {
        // Metodos y firmas de indice: no se comparan, pero tampoco rompen.
        continue;
      }
      members.push(member);
    }
    shapes.set(name, {
      name,
      kind: 'interface',
      members,
      variants: [],
      aliasOf: '',
      line: lineAt(clean, match.index),
    });
  }

  /* --- Alias y uniones --- */
  TYPE_RE.lastIndex = 0;
  for (let match = TYPE_RE.exec(clean); match !== null; match = TYPE_RE.exec(clean)) {
    const name = match[1] ?? '';
    const start = match.index + match[0].length;
    const end = findDeclarationEnd(clean, start);
    const body = clean.slice(start, end).trim().replace(/;$/, '').trim();
    if (body === '') {
      unparsed.push(name);
      continue;
    }

    const variants = unionVariants(body);
    shapes.set(name, {
      name,
      // Un alias con varias ramas se compara variante a variante; uno solo,
      // como texto.
      kind: variants.length > 1 ? 'union' : 'alias',
      members: [],
      variants: variants.length > 1 ? variants : [],
      aliasOf: variants.length > 1 ? '' : body,
      line: lineAt(clean, match.index),
    });
  }

  /* --- Constantes --- */
  CONST_RE.lastIndex = 0;
  for (let match = CONST_RE.exec(clean); match !== null; match = CONST_RE.exec(clean)) {
    const name = match[1] ?? '';
    if (shapes.has(name)) {
      continue;
    }
    shapes.set(name, {
      name,
      kind: 'const',
      members: [],
      variants: [],
      aliasOf: '',
      line: lineAt(clean, match.index),
    });
  }

  return { shapes, unparsed };
}

/**
 * Fin de una declaracion `type X = …`.
 *
 * Termina en el `;` de nivel cero, o en la primera linea en blanco seguida
 * de otra declaracion. Los alias multilinea (una union larga) no llevan
 * necesariamente punto y coma en cada rama, asi que no vale cortar por
 * salto de linea.
 */
function findDeclarationEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '(' || char === '<' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === '>' || char === ']') {
      depth -= 1;
    } else if (char === ';' && depth === 0) {
      return index;
    }
  }
  return source.length;
}

/* -------------------------------------------------------------------------- */
/*  Dependientes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Simbolos que un archivo importa de un modulo concreto.
 *
 * Reconoce `import type { A, B } from '...'`, `import { A } from '...'` y
 * los alias (`A as B`), que son las formas que usa este proyecto.
 */
export function importedSymbols(source: string, moduleHint: string): readonly string[] {
  const clean = stripComments(source);
  const found = new Set<string>();
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

  for (let match = pattern.exec(clean); match !== null; match = pattern.exec(clean)) {
    const specifier = match[2] ?? '';
    // La pista es el nombre del modulo sin extension ni ruta relativa:
    // `contracts` casa con `../../shared/contracts.js`.
    if (!specifier.includes(moduleHint)) {
      continue;
    }
    for (const entry of (match[1] ?? '').split(',')) {
      const name = entry
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name !== undefined && name !== '') {
        found.add(name);
      }
    }
  }
  // Orden por punto de codigo, no `localeCompare`: el resultado se compara
  // entre ejecuciones y una ordenacion dependiente del idioma del sistema
  // colocaria `ok` antes o despues de `ProcessInfo` segun la maquina.
  return [...found].sort();
}
