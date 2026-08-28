/**
 * Diferencia por lineas mediante subsecuencia comun mas larga (LCS).
 *
 * Se usa para la vista previa del asistente en linea: antes de tocar el
 * documento, el usuario ve exactamente que lineas se anaden y cuales se
 * eliminan.
 *
 * La tabla de LCS completa es O(n·m) en memoria, lo que para un archivo
 * grande es inaceptable. Aqui se acota de dos maneras:
 *  1. Se recortan los prefijos y sufijos comunes, que en una refactorizacion
 *     tipica son casi todo el archivo.
 *  2. Si aun asi el producto supera el limite, se degrada a una diferencia
 *     de bloque unico (todo lo de en medio se marca como reemplazado).
 */

export type DiffKind = 'equal' | 'added' | 'removed';

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
  /** Numero de linea en el original (1..n), o `null` si es una adicion. */
  readonly originalLine: number | null;
  /** Numero de linea en el resultado (1..n), o `null` si es una eliminacion. */
  readonly modifiedLine: number | null;
}

export interface DiffSummary {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  /** true si hubo que degradar por tamano. */
  readonly approximate: boolean;
}

/** Producto maximo de longitudes para calcular la LCS exacta. */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function diffLines(original: string, modified: string): DiffSummary {
  const a = splitLines(original);
  const b = splitLines(modified);

  /* --- Prefijo comun --- */
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }

  /* --- Sufijo comun --- */
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);

  const lines: DiffLine[] = [];
  let originalCursor = 1;
  let modifiedCursor = 1;

  for (let index = 0; index < start; index += 1) {
    lines.push({
      kind: 'equal',
      text: a[index] ?? '',
      originalLine: originalCursor,
      modifiedLine: modifiedCursor,
    });
    originalCursor += 1;
    modifiedCursor += 1;
  }

  let approximate = false;

  if (middleA.length * middleB.length > MAX_LCS_CELLS) {
    approximate = true;
    for (const text of middleA) {
      lines.push({ kind: 'removed', text, originalLine: originalCursor, modifiedLine: null });
      originalCursor += 1;
    }
    for (const text of middleB) {
      lines.push({ kind: 'added', text, originalLine: null, modifiedLine: modifiedCursor });
      modifiedCursor += 1;
    }
  } else {
    const table = buildLcsTable(middleA, middleB);
    let i = 0;
    let j = 0;
    const width = middleB.length + 1;

    while (i < middleA.length && j < middleB.length) {
      if (middleA[i] === middleB[j]) {
        lines.push({
          kind: 'equal',
          text: middleA[i] ?? '',
          originalLine: originalCursor,
          modifiedLine: modifiedCursor,
        });
        originalCursor += 1;
        modifiedCursor += 1;
        i += 1;
        j += 1;
        continue;
      }
      // Se avanza por el lado que conserva mas subsecuencia comun.
      const down = table[(i + 1) * width + j] ?? 0;
      const right = table[i * width + (j + 1)] ?? 0;
      if (down >= right) {
        lines.push({
          kind: 'removed',
          text: middleA[i] ?? '',
          originalLine: originalCursor,
          modifiedLine: null,
        });
        originalCursor += 1;
        i += 1;
      } else {
        lines.push({
          kind: 'added',
          text: middleB[j] ?? '',
          originalLine: null,
          modifiedLine: modifiedCursor,
        });
        modifiedCursor += 1;
        j += 1;
      }
    }
    while (i < middleA.length) {
      lines.push({
        kind: 'removed',
        text: middleA[i] ?? '',
        originalLine: originalCursor,
        modifiedLine: null,
      });
      originalCursor += 1;
      i += 1;
    }
    while (j < middleB.length) {
      lines.push({
        kind: 'added',
        text: middleB[j] ?? '',
        originalLine: null,
        modifiedLine: modifiedCursor,
      });
      modifiedCursor += 1;
      j += 1;
    }
  }

  for (let index = endA; index < a.length; index += 1) {
    lines.push({
      kind: 'equal',
      text: a[index] ?? '',
      originalLine: originalCursor,
      modifiedLine: modifiedCursor,
    });
    originalCursor += 1;
    modifiedCursor += 1;
  }

  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'added') {
      added += 1;
    } else if (line.kind === 'removed') {
      removed += 1;
    }
  }

  return { lines, added, removed, approximate };
}

/**
 * Tabla de longitudes de LCS en un array plano, recorrida desde el final.
 * `table[i * width + j]` es la LCS de `a[i..]` con `b[j..]`.
 */
function buildLcsTable(a: readonly string[], b: readonly string[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0);
    }
  }
  return table;
}

/**
 * Recorta el resultado a los bloques con cambios mas `context` lineas
 * alrededor, para que la vista previa no muestre el archivo entero.
 */
export function collapseContext(summary: DiffSummary, context = 3): readonly DiffLine[] {
  const { lines } = summary;
  const keep = new Set<number>();

  lines.forEach((line, index) => {
    if (line.kind === 'equal') {
      return;
    }
    for (let offset = -context; offset <= context; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) {
        keep.add(target);
      }
    }
  });

  const out: DiffLine[] = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      skipping = false;
      out.push(line);
      return;
    }
    if (!skipping) {
      skipping = true;
      out.push({ kind: 'equal', text: '⋯', originalLine: null, modifiedLine: null });
    }
  });
  return out;
}
