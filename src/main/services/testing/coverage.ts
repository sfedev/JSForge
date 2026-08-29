/**
 * Lectura de informes de cobertura.
 *
 * Se admiten los dos formatos que producen Vitest y Jest sin configuracion
 * extra:
 *
 *  - `coverage-final.json` de Istanbul, que es lo que emite el proveedor
 *    `v8` de Vitest tras convertir.
 *  - `lcov.info`, por si el proyecto ya lo genera para su CI.
 *
 * La salida es la misma en ambos casos: por archivo, que lineas se
 * ejecutaron y cuales no, que es lo unico que el editor necesita para
 * pintar el margen.
 */

import type { CoverageReport, FileCoverage } from '../../../shared/contracts.js';

type Record_ = Record<string, unknown>;

function asRecord(value: unknown): Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record_)
    : {};
}

/** Porcentaje redondeado a un decimal; 100 cuando no hay nada que cubrir. */
export function percentage(covered: number, total: number): number {
  if (total <= 0) {
    return 100;
  }
  return Number(((covered / total) * 100).toFixed(1));
}

/* -------------------------------------------------------------------------- */
/*  Istanbul                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Interpreta `coverage-final.json`.
 *
 * La estructura por archivo es `statementMap` (id -> rango) y `s`
 * (id -> numero de ejecuciones). Una linea cuenta como cubierta si ALGUNA
 * sentencia que empieza en ella se ejecuto: una linea con dos sentencias, de
 * las que solo una corrio, esta parcialmente cubierta, y marcarla como no
 * cubierta seria mas confuso que util.
 */
export function parseIstanbulCoverage(
  json: string,
  toRelative: (absolute: string) => string,
): readonly FileCoverage[] {
  let document: Record_;
  try {
    document = asRecord(JSON.parse(json));
  } catch {
    return [];
  }

  const files: FileCoverage[] = [];

  for (const [absolute, value] of Object.entries(document)) {
    const node = asRecord(value);
    const statementMap = asRecord(node['statementMap']);
    const counts = asRecord(node['s']);

    const covered = new Set<number>();
    const uncovered = new Set<number>();
    let statementsCovered = 0;
    let statementsTotal = 0;

    for (const [id, range] of Object.entries(statementMap)) {
      const start = asRecord(asRecord(range)['start']);
      const line = typeof start['line'] === 'number' ? start['line'] : 0;
      if (line <= 0) {
        continue;
      }
      const hits = counts[id];
      const executed = typeof hits === 'number' && hits > 0;
      statementsTotal += 1;
      if (executed) {
        statementsCovered += 1;
        covered.add(line);
      } else {
        uncovered.add(line);
      }
    }

    // Una linea con varias sentencias, alguna ejecutada, cuenta como cubierta.
    for (const line of covered) {
      uncovered.delete(line);
    }

    const branchCounts = asRecord(node['b']);
    let branchesCovered = 0;
    let branchesTotal = 0;
    for (const entry of Object.values(branchCounts)) {
      if (!Array.isArray(entry)) {
        continue;
      }
      for (const hits of entry) {
        branchesTotal += 1;
        if (typeof hits === 'number' && hits > 0) {
          branchesCovered += 1;
        }
      }
    }

    files.push({
      path: toRelative(absolute),
      coveredLines: [...covered].sort((a, b) => a - b),
      uncoveredLines: [...uncovered].sort((a, b) => a - b),
      statementsCovered,
      statementsTotal,
      branchesCovered,
      branchesTotal,
      percent: percentage(statementsCovered, statementsTotal),
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/* -------------------------------------------------------------------------- */
/*  LCOV                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Interpreta `lcov.info`.
 *
 * Solo interesan cuatro registros: `SF` (archivo), `DA` (linea:ejecuciones),
 * `BRDA` (rama) y `end_of_record`. El resto se ignora sin romper.
 */
export function parseLcov(
  source: string,
  toRelative: (absolute: string) => string,
): readonly FileCoverage[] {
  const files: FileCoverage[] = [];

  let path: string | null = null;
  let covered: number[] = [];
  let uncovered: number[] = [];
  let branchesCovered = 0;
  let branchesTotal = 0;

  const flush = (): void => {
    if (path === null) {
      return;
    }
    const statementsCovered = covered.length;
    const statementsTotal = covered.length + uncovered.length;
    files.push({
      path: toRelative(path),
      coveredLines: [...covered].sort((a, b) => a - b),
      uncoveredLines: [...uncovered].sort((a, b) => a - b),
      statementsCovered,
      statementsTotal,
      branchesCovered,
      branchesTotal,
      percent: percentage(statementsCovered, statementsTotal),
    });
    path = null;
    covered = [];
    uncovered = [];
    branchesCovered = 0;
    branchesTotal = 0;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      // Un `SF` nuevo sin `end_of_record` cierra el anterior igualmente.
      flush();
      path = line.slice(3);
      continue;
    }
    if (line === 'end_of_record') {
      flush();
      continue;
    }
    if (line.startsWith('DA:')) {
      const [rawNumber, rawHits] = line.slice(3).split(',');
      const number = Number.parseInt(rawNumber ?? '', 10);
      const hits = Number.parseInt(rawHits ?? '', 10);
      if (!Number.isFinite(number)) {
        continue;
      }
      if (Number.isFinite(hits) && hits > 0) {
        covered.push(number);
      } else {
        uncovered.push(number);
      }
      continue;
    }
    if (line.startsWith('BRDA:')) {
      const parts = line.slice(5).split(',');
      const taken = parts[3] ?? '-';
      branchesTotal += 1;
      // `-` significa que la rama ni siquiera se alcanzo.
      if (taken !== '-' && Number.parseInt(taken, 10) > 0) {
        branchesCovered += 1;
      }
    }
  }
  flush();

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/* -------------------------------------------------------------------------- */
/*  Informe                                                                    */
/* -------------------------------------------------------------------------- */

/** Compone el informe global a partir de la cobertura por archivo. */
export function buildCoverageReport(
  files: readonly FileCoverage[],
  generatedAt: number,
): CoverageReport {
  const statementsCovered = files.reduce((sum, file) => sum + file.statementsCovered, 0);
  const statementsTotal = files.reduce((sum, file) => sum + file.statementsTotal, 0);
  return {
    files,
    // Porcentaje sobre el total de sentencias, no la media de porcentajes:
    // promediar daria el mismo peso a un archivo de 5 lineas y a uno de 500.
    percent: percentage(statementsCovered, statementsTotal),
    statementsCovered,
    statementsTotal,
    generatedAt,
  };
}
