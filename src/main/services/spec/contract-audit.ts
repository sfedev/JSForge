/**
 * Auditor de contratos compartidos.
 *
 * Compara la version en disco de un modulo de `src/shared/` con la que hay
 * en Git y senala los cambios que ROMPEN a quien lo consume. La pregunta que
 * responde no es «que ha cambiado» —eso ya lo dice el diff— sino «esto va a
 * dejar de compilar en otra capa».
 *
 * Criterio de ruptura, desde el punto de vista del consumidor:
 *
 *  - Quitar un export o un campo: el consumidor lo usaba y desaparece.
 *  - Anadir un campo OBLIGATORIO: quien construia el objeto ya no compila.
 *  - Volver obligatorio un campo opcional: lo mismo.
 *  - Cambiar el tipo de un campo: la asignacion deja de encajar.
 *  - Quitar una variante de una union: un `switch` exhaustivo se queda corto.
 *
 * Lo que NO se marca, porque es compatible: anadir un campo opcional, anadir
 * una variante a una union (rompe la exhaustividad del productor, no la del
 * consumidor) y volver opcional un campo obligatorio.
 */

import type {
  BreakingChange,
  ContractAuditReport,
  ContractDependent,
} from '../../../shared/contracts.js';
import { extractModuleShape, importedSymbols, type Shape } from './ts-shape.js';

/**
 * Compara dos versiones del mismo modulo.
 *
 * `before` es la referencia (lo que ya consumen otras capas) y `after` lo
 * que hay ahora en el editor.
 */
export function compareModules(before: string, after: string): readonly BreakingChange[] {
  const previous = extractModuleShape(before).shapes;
  const current = extractModuleShape(after).shapes;
  const changes: BreakingChange[] = [];

  for (const [name, old] of previous) {
    const next = current.get(name);

    if (next === undefined) {
      changes.push({
        kind: 'removed-export',
        symbol: name,
        detail: `Se elimino el export "${name}"; quien lo importe dejara de compilar.`,
        line: 1,
      });
      continue;
    }

    if (old.kind !== next.kind) {
      changes.push({
        kind: 'type-changed',
        symbol: name,
        before: old.kind,
        after: next.kind,
        detail: `"${name}" paso de ${old.kind} a ${next.kind}.`,
        line: next.line,
      });
      continue;
    }

    if (old.kind === 'interface') {
      changes.push(...compareInterfaces(old, next));
    } else if (old.kind === 'union') {
      changes.push(...compareUnions(old, next));
    } else if (old.kind === 'alias' && old.aliasOf !== next.aliasOf) {
      changes.push({
        kind: 'type-changed',
        symbol: name,
        before: old.aliasOf,
        after: next.aliasOf,
        detail: `El alias "${name}" cambio de tipo.`,
        line: next.line,
      });
    }
  }

  return changes;
}

function compareInterfaces(old: Shape, next: Shape): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const before = new Map(old.members.map((member) => [member.name, member]));
  const after = new Map(next.members.map((member) => [member.name, member]));

  for (const [name, member] of before) {
    const updated = after.get(name);
    if (updated === undefined) {
      changes.push({
        kind: 'removed-field',
        symbol: old.name,
        member: name,
        before: member.type,
        detail: `"${old.name}.${name}" ya no existe.`,
        line: next.line,
      });
      continue;
    }
    if (member.optional && !updated.optional) {
      changes.push({
        kind: 'optional-became-required',
        symbol: old.name,
        member: name,
        detail: `"${old.name}.${name}" paso de opcional a obligatorio.`,
        line: next.line,
      });
    }
    if (normalizeType(member.type) !== normalizeType(updated.type)) {
      changes.push({
        kind: 'type-changed',
        symbol: old.name,
        member: name,
        before: member.type,
        after: updated.type,
        detail: `"${old.name}.${name}" cambio de "${member.type}" a "${updated.type}".`,
        line: next.line,
      });
    }
  }

  for (const [name, member] of after) {
    // Un campo opcional nuevo es compatible: nadie tiene que construirlo.
    if (before.has(name) || member.optional) {
      continue;
    }
    changes.push({
      kind: 'required-field-added',
      symbol: old.name,
      member: name,
      after: member.type,
      detail: `"${old.name}.${name}" es obligatorio y no existia: quien construya el objeto dejara de compilar.`,
      line: next.line,
    });
  }

  return changes;
}

function compareUnions(old: Shape, next: Shape): BreakingChange[] {
  const after = new Set(next.variants);
  return old.variants
    .filter((variant) => !after.has(variant))
    .map((variant) => ({
      kind: 'enum-value-removed' as const,
      symbol: old.name,
      before: variant,
      detail: `La union "${old.name}" ya no admite ${variant}.`,
      line: next.line,
    }));
}

/**
 * Normaliza un tipo antes de compararlo.
 *
 * Sin esto, reformatear una union larga a varias lineas se contaria como un
 * cambio de tipo en cada campo que la use.
 */
export function normalizeType(type: string): string {
  return type
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, '|')
    .replace(/\s*&\s*/g, '&')
    .replace(/\s*;\s*/g, ';')
    .replace(/\s*,\s*/g, ',')
    .trim();
}

/* -------------------------------------------------------------------------- */
/*  Consumidores afectados                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Archivos que importan alguno de los simbolos tocados.
 *
 * Se buscan por nombre de simbolo importado, no por uso: un archivo que
 * importa `ProcessInfo` es el que hay que revisar, y localizar cada punto de
 * uso exigiria un analisis semantico que aqui no toca.
 */
export function findDependents(
  files: readonly { path: string; source: string }[],
  moduleHint: string,
  affectedSymbols: ReadonlySet<string>,
): readonly ContractDependent[] {
  const dependents: ContractDependent[] = [];

  for (const file of files) {
    const imported = importedSymbols(file.source, moduleHint);
    const touched = imported.filter((symbol) => affectedSymbols.has(symbol));
    if (touched.length === 0) {
      continue;
    }
    dependents.push({
      path: file.path,
      symbols: touched,
      line: importLine(file.source, moduleHint),
    });
  }

  // Primero los que mas simbolos afectados usan: son los mas probables de
  // romper y los que conviene mirar antes.
  return dependents.sort(
    (a, b) => b.symbols.length - a.symbols.length || a.path.localeCompare(b.path),
  );
}

/** Linea del `import` que trae el modulo, para saltar directamente ahi. */
function importLine(source: string, moduleHint: string): number {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.includes('import') && line.includes(moduleHint)) {
      return index + 1;
    }
  }
  return 1;
}

/** Compone el informe completo a partir de las piezas ya calculadas. */
export function buildReport(
  path: string,
  comparedAgainst: string,
  changes: readonly BreakingChange[],
  dependents: readonly ContractDependent[],
): ContractAuditReport {
  return { path, comparedAgainst, changes, dependents };
}

/** Simbolos tocados por un conjunto de cambios. */
export function affectedSymbols(changes: readonly BreakingChange[]): Set<string> {
  return new Set(changes.map((change) => change.symbol));
}
