/**
 * Parser de `git status --porcelain=v2 --branch -z`.
 *
 * Se usa el formato v2 porque es el unico estable frente a rutas con
 * espacios, saltos de linea y caracteres no ASCII, y porque separa el estado
 * del indice del estado del arbol de trabajo sin ambiguedad.
 *
 * Formato (registros separados por NUL con `-z`):
 *   # branch.oid <sha>
 *   # branch.head <nombre>
 *   # branch.upstream <remoto/rama>
 *   # branch.ab +N -M
 *   1 XY sub mH mI mW hH hI <ruta>
 *   2 XY sub mH mI mW hH hI <puntuacion> <ruta><NUL><ruta-original>
 *   u XY sub m1 m2 m3 mW h1 h2 h3 <ruta>
 *   ? <ruta>
 *   ! <ruta>
 */

import type { GitFileChange, GitFileState, GitStatus } from '../../../shared/contracts.js';

/** Traduce un codigo de estado XY de git a nuestro vocabulario. */
export function stateFromCode(code: string): GitFileState {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    case 'U':
      return 'conflicted';
    case '.':
    default:
      return 'unmodified';
  }
}

function makeChange(
  path: string,
  indexCode: string,
  worktreeCode: string,
  originalPath?: string,
): GitFileChange {
  const index = stateFromCode(indexCode);
  const worktree = stateFromCode(worktreeCode);
  const conflicted = index === 'conflicted' || worktree === 'conflicted';
  return {
    path,
    ...(originalPath === undefined ? {} : { originalPath }),
    index,
    worktree,
    staged: !conflicted && index !== 'unmodified',
    unstaged: !conflicted && worktree !== 'unmodified',
    conflicted,
  };
}

/**
 * Analiza la salida de `git status --porcelain=v2 --branch -z --untracked-files=all`.
 * `raw` es el texto completo con registros separados por NUL.
 */
export function parseStatusV2(raw: string): GitStatus {
  const records = raw.split('\0');
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  const conflicted: GitFileChange[] = [];

  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let detached = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === '') {
      continue;
    }

    /* --- Cabeceras de rama --- */
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') {
        // git escribe "(detached)" cuando no hay rama.
        if (value === '(detached)') {
          detached = true;
        } else {
          branch = value;
        }
      } else if (key === 'branch.upstream') {
        upstream = value;
      } else if (key === 'branch.ab') {
        const match = /\+(-?\d+)\s+-(-?\d+)/.exec(value);
        if (match !== null) {
          ahead = Number.parseInt(match[1] ?? '0', 10);
          behind = Number.parseInt(match[2] ?? '0', 10);
        }
      } else if (key === 'branch.oid' && value === '(initial)') {
        // Repositorio sin commits: no es un estado de error.
        detached = false;
      }
      continue;
    }

    /* --- Entradas ordinarias: "1 XY sub mH mI mW hH hI path" --- */
    if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      const codes = fields[1] ?? '..';
      // La ruta puede contener espacios: es todo lo que sigue al octavo campo.
      const path = fields.slice(8).join(' ');
      if (path === '') {
        continue;
      }
      const change = makeChange(path, codes[0] ?? '.', codes[1] ?? '.');
      if (change.staged) {
        staged.push(change);
      }
      if (change.unstaged) {
        unstaged.push(change);
      }
      continue;
    }

    /* --- Renombrados/copias: "2 XY ... score path" + registro con el origen --- */
    if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      const codes = fields[1] ?? '..';
      const path = fields.slice(9).join(' ');
      // Con `-z`, la ruta original viaja en el registro inmediatamente siguiente.
      const originalPath = records[index + 1];
      index += 1;
      if (path === '') {
        continue;
      }
      const change = makeChange(
        path,
        codes[0] ?? '.',
        codes[1] ?? '.',
        originalPath === '' ? undefined : originalPath,
      );
      if (change.staged) {
        staged.push(change);
      }
      if (change.unstaged) {
        unstaged.push(change);
      }
      continue;
    }

    /* --- Conflictos: "u XY sub m1 m2 m3 mW h1 h2 h3 path" --- */
    if (record.startsWith('u ')) {
      const fields = record.split(' ');
      const codes = fields[1] ?? 'UU';
      const path = fields.slice(10).join(' ');
      if (path === '') {
        continue;
      }
      conflicted.push({
        path,
        index: stateFromCode(codes[0] ?? 'U'),
        worktree: stateFromCode(codes[1] ?? 'U'),
        staged: false,
        unstaged: true,
        conflicted: true,
      });
      continue;
    }

    /* --- Sin seguimiento e ignorados --- */
    if (record.startsWith('? ')) {
      const path = record.slice(2);
      untracked.push({
        path,
        index: 'untracked',
        worktree: 'untracked',
        staged: false,
        unstaged: true,
        conflicted: false,
      });
      continue;
    }
    if (record.startsWith('! ')) {
      // Los ignorados no se muestran; se piden solo cuando el usuario lo pide.
      continue;
    }
  }

  const sortByPath = (a: GitFileChange, b: GitFileChange): number =>
    a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });

  return {
    isRepo: true,
    ...(branch === undefined ? {} : { branch }),
    ...(upstream === undefined ? {} : { upstream }),
    ahead,
    behind,
    detached,
    staged: staged.sort(sortByPath),
    unstaged: unstaged.sort(sortByPath),
    untracked: untracked.sort(sortByPath),
    conflicted: conflicted.sort(sortByPath),
  };
}

/** Estado vacio para cuando la carpeta no es un repositorio. */
export const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  ahead: 0,
  behind: 0,
  detached: false,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
};

/* -------------------------------------------------------------------------- */
/*  Ramas                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Analiza `git for-each-ref --format=%(refname:short)%09%(upstream:short)%09%(HEAD) refs/heads refs/remotes`.
 * El separador es una tabulacion porque los nombres de rama no la admiten.
 */
export function parseBranches(raw: string): {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
}[] {
  const branches: { name: string; current: boolean; remote: boolean; upstream?: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    const [name = '', upstream = '', head = ''] = line.split('\t');
    if (name === '' || name.endsWith('/HEAD')) {
      continue;
    }
    branches.push({
      name,
      current: head.trim() === '*',
      remote: name.includes('/') && !name.startsWith('refs/heads'),
      ...(upstream === '' ? {} : { upstream }),
    });
  }
  return branches;
}

/* -------------------------------------------------------------------------- */
/*  Historial                                                                  */
/* -------------------------------------------------------------------------- */

/** Separadores improbables en el contenido de un commit. */
export const LOG_FIELD_SEPARATOR = '\u001f';
export const LOG_RECORD_SEPARATOR = '\u001e';

export const LOG_FORMAT = [
  '%H',
  '%h',
  '%an',
  '%ae',
  '%at',
  '%s',
  '%b',
  '%D',
].join(LOG_FIELD_SEPARATOR);

export function parseLog(raw: string): {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: number;
  subject: string;
  body: string;
  refs: string[];
}[] {
  const entries: {
    hash: string;
    shortHash: string;
    author: string;
    email: string;
    date: number;
    subject: string;
    body: string;
    refs: string[];
  }[] = [];

  for (const record of raw.split(LOG_RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\r?\n/, '');
    if (trimmed.trim() === '') {
      continue;
    }
    const fields = trimmed.split(LOG_FIELD_SEPARATOR);
    if (fields.length < 8) {
      continue;
    }
    const timestamp = Number.parseInt(fields[4] ?? '0', 10);
    entries.push({
      hash: fields[0] ?? '',
      shortHash: fields[1] ?? '',
      author: fields[2] ?? '',
      email: fields[3] ?? '',
      date: Number.isFinite(timestamp) ? timestamp * 1000 : 0,
      subject: fields[5] ?? '',
      body: (fields[6] ?? '').trim(),
      refs: (fields[7] ?? '')
        .split(',')
        .map((ref) => ref.trim())
        .filter((ref) => ref !== ''),
    });
  }
  return entries;
}
