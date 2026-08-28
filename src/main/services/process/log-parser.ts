/**
 * Analizador de registros estructurados.
 *
 * Reconoce los formatos habituales del ecosistema Node y los normaliza a un
 * unico `LogRecord`:
 *  - Pino y Bunyan: JSON por linea con `level` numerico.
 *  - Winston: JSON con `level` textual, o texto `nivel: mensaje`.
 *  - Morgan: linea de acceso HTTP (`GET /ruta 200 12ms`).
 *  - DotForge CLI: prefijo `[dotforge:nivel]`.
 *  - Texto plano: se infiere el nivel por palabras clave.
 *
 * Ademas extrae los marcos de pila y las URL locales para que el visor pueda
 * hacerlos clicables.
 */

import type { LogFormat, LogLevel, LogRecord, StackFrameRef } from '../../../shared/contracts.js';

/** Niveles numericos de Pino y Bunyan. */
function levelFromNumber(value: number): LogLevel {
  if (value >= 60) {
    return 'fatal';
  }
  if (value >= 50) {
    return 'error';
  }
  if (value >= 40) {
    return 'warn';
  }
  if (value >= 30) {
    return 'info';
  }
  if (value >= 20) {
    return 'debug';
  }
  return 'trace';
}

function levelFromText(value: string): LogLevel | null {
  switch (value.trim().toLowerCase()) {
    case 'fatal':
    case 'crit':
    case 'critical':
      return 'fatal';
    case 'error':
    case 'err':
      return 'error';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'info':
    case 'log':
    case 'notice':
      return 'info';
    case 'debug':
      return 'debug';
    case 'trace':
    case 'verbose':
    case 'silly':
      return 'trace';
    default:
      return null;
  }
}

/** Ultimo recurso: heuristica por palabras clave sobre texto plano. */
function inferLevel(message: string): LogLevel {
  const lower = message.toLowerCase();
  if (/\b(fatal|panic)\b/.test(lower)) {
    return 'fatal';
  }
  if (/\b(error|err!|failed|failure|exception|✖|✘)\b/.test(lower) || lower.includes('error:')) {
    return 'error';
  }
  if (/\b(warn|warning|deprecated|⚠)\b/.test(lower)) {
    return 'warn';
  }
  if (/\b(debug)\b/.test(lower)) {
    return 'debug';
  }
  return 'info';
}

/* -------------------------------------------------------------------------- */
/*  Extraccion de enlaces y marcos de pila                                     */
/* -------------------------------------------------------------------------- */

const URL_PATTERN = /https?:\/\/[^\s'"<>)\]]+/g;

/**
 * Marcos de pila en las formas habituales:
 *   at fn (C:\proyecto\src\a.ts:12:5)
 *   at /proyecto/src/a.ts:12:5
 *   src/a.ts:12:5
 *   ./src/a.ts(12,5)
 */
const STACK_PATTERNS: readonly RegExp[] = [
  /\bat\s+(?:.*?\s+\()?((?:[A-Za-z]:)?[^\s()]+?\.(?:[cm]?[jt]sx?|vue|svelte)):(\d+):(\d+)\)?/g,
  /(^|\s)((?:\.{0,2}\/)?[\w./\\-]+\.(?:[cm]?[jt]sx?|vue|svelte)):(\d+):(\d+)/g,
  /(^|\s)((?:\.{0,2}\/)?[\w./\\-]+\.(?:[cm]?[jt]sx?|vue|svelte))\((\d+),(\d+)\)/g,
];

export interface FrameResolver {
  /** Traduce una ruta absoluta o relativa a ruta del workspace, o `null`. */
  (candidate: string): string | null;
}

export function extractUrls(message: string): string[] {
  const found = message.match(URL_PATTERN);
  return found === null ? [] : [...new Set(found)];
}

export function extractFrames(message: string, resolve: FrameResolver): StackFrameRef[] {
  const frames: StackFrameRef[] = [];
  const seen = new Set<string>();

  for (const pattern of STACK_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(message);
    while (match !== null) {
      // El primer patron captura (ruta, linea, columna); los otros anteponen
      // un grupo de separador, por lo que los indices se desplazan.
      const groups = match.slice(1).filter((group) => group !== undefined);
      const [rawPath, rawLine, rawColumn] =
        groups.length >= 4 ? groups.slice(1) : groups.length === 3 ? groups : [undefined, undefined, undefined];

      if (rawPath !== undefined && rawLine !== undefined) {
        const line = Number.parseInt(rawLine, 10);
        const column = rawColumn === undefined ? undefined : Number.parseInt(rawColumn, 10);
        const resolved = resolve(rawPath);
        const key = `${resolved ?? rawPath}:${line}`;
        if (!seen.has(key) && Number.isFinite(line)) {
          seen.add(key);
          frames.push({
            path: resolved ?? rawPath,
            line,
            ...(column === undefined || Number.isNaN(column) ? {} : { column }),
            inWorkspace: resolved !== null,
          });
        }
      }
      match = pattern.exec(message);
    }
  }
  return frames;
}

/* -------------------------------------------------------------------------- */
/*  Parsers por formato                                                        */
/* -------------------------------------------------------------------------- */

interface ParsedLine {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields?: Record<string, string>;
  readonly time?: number;
}

const JSON_RESERVED = new Set(['level', 'msg', 'message', 'time', 'timestamp', 'v', 'pid', 'hostname']);

function parseJsonLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const levelRaw = record['level'];

  let level: LogLevel;
  if (typeof levelRaw === 'number') {
    level = levelFromNumber(levelRaw);
  } else if (typeof levelRaw === 'string') {
    level = levelFromText(levelRaw) ?? 'info';
  } else {
    return null;
  }

  const message =
    typeof record['msg'] === 'string'
      ? record['msg']
      : typeof record['message'] === 'string'
        ? record['message']
        : '';

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (JSON_RESERVED.has(key)) {
      continue;
    }
    fields[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  const timeRaw = record['time'] ?? record['timestamp'];
  const time =
    typeof timeRaw === 'number'
      ? timeRaw
      : typeof timeRaw === 'string'
        ? Date.parse(timeRaw)
        : undefined;

  // Un `stack` en los campos es lo que de verdad interesa hacer clicable.
  const stack = typeof record['stack'] === 'string' ? record['stack'] : undefined;

  return {
    level,
    message: stack === undefined ? message : `${message}\n${stack}`,
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(time === undefined || Number.isNaN(time) ? {} : { time }),
  };
}

/** Morgan combinado/comun: `GET /api 200 15.2 ms`. */
const MORGAN_PATTERN =
  /^(?:\S+\s+-\s+\S+\s+\[[^\]]+\]\s+")?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+")?\s+(\d{3})\s+([\d.]+)?/;

function parseMorganLine(line: string): ParsedLine | null {
  const match = MORGAN_PATTERN.exec(line.trim());
  if (match === null) {
    return null;
  }
  const status = Number.parseInt(match[3] ?? '0', 10);
  const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  const fields: Record<string, string> = {
    method: match[1] ?? '',
    url: match[2] ?? '',
    status: String(status),
  };
  if (match[4] !== undefined) {
    fields['ms'] = match[4];
  }
  return { level, message: line.trim(), fields };
}

/** DotForge CLI: `[dotforge:info] mensaje` o `dotforge · info · mensaje`. */
const DOTFORGE_PATTERN = /^\[?dotforge[:\s·|-]+(\w+)[\]:\s·|-]+\s*(.*)$/i;

function parseDotForgeLine(line: string): ParsedLine | null {
  const match = DOTFORGE_PATTERN.exec(line.trim());
  if (match === null) {
    return null;
  }
  const level = levelFromText(match[1] ?? '');
  if (level === null) {
    return null;
  }
  return { level, message: match[2] ?? '', fields: { source: 'dotforge' } };
}

/** Winston en modo texto: `error: algo fallo` o `2024-01-01 error algo`. */
const WINSTON_TEXT_PATTERN = /^(?:\S+\s+)??(fatal|error|warn|warning|info|debug|verbose|silly)\s*:\s+(.*)$/i;

function parseWinstonTextLine(line: string): ParsedLine | null {
  const match = WINSTON_TEXT_PATTERN.exec(line.trim());
  if (match === null) {
    return null;
  }
  const level = levelFromText(match[1] ?? '');
  if (level === null) {
    return null;
  }
  return { level, message: match[2] ?? '' };
}

/* -------------------------------------------------------------------------- */
/*  Entrada publica                                                            */
/* -------------------------------------------------------------------------- */

export interface ParseContext {
  readonly processId: string;
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly format: LogFormat;
  readonly seq: number;
  readonly resolveFrame: FrameResolver;
}

/**
 * Convierte una linea cruda en `LogRecord`. Cuando `format` es `auto` se
 * prueban los parsers en orden de especificidad; el texto plano siempre
 * funciona, asi que nunca se pierde una linea.
 */
export function parseLogLine(line: string, context: ParseContext): LogRecord {
  const attempts: ((value: string) => ParsedLine | null)[] = [];

  switch (context.format) {
    case 'pino':
    case 'bunyan':
    case 'winston':
      attempts.push(parseJsonLine, parseWinstonTextLine);
      break;
    case 'morgan':
      attempts.push(parseMorganLine);
      break;
    case 'dotforge':
      attempts.push(parseDotForgeLine, parseJsonLine);
      break;
    case 'plain':
      break;
    case 'auto':
    default:
      attempts.push(parseJsonLine, parseDotForgeLine, parseMorganLine, parseWinstonTextLine);
      break;
  }

  let parsed: ParsedLine | null = null;
  for (const attempt of attempts) {
    parsed = attempt(line);
    if (parsed !== null) {
      break;
    }
  }

  const message = parsed?.message ?? line;
  const level = parsed?.level ?? (context.stream === 'stderr' ? inferLevel(line) : inferLevel(line));
  const frames = extractFrames(message, context.resolveFrame);
  const urls = extractUrls(message);

  return {
    processId: context.processId,
    seq: context.seq,
    time: parsed?.time ?? Date.now(),
    level,
    stream: context.stream,
    message,
    ...(parsed?.fields === undefined ? {} : { fields: parsed.fields }),
    ...(frames.length === 0 ? {} : { frames }),
    ...(urls.length === 0 ? {} : { urls }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Deteccion de puerto                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Extrae el puerto de una linea de arranque. Cubre las formas que emiten
 * Vite, Next, Nest, Angular y los servidores Express escritos a mano.
 */
const PORT_PATTERNS: readonly RegExp[] = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i,
  /\blistening\s+(?:on|at)\s+(?:port\s+)?:?(\d{2,5})/i,
  /\bport\s*[:=]\s*(\d{2,5})/i,
  /\bon\s+port\s+(\d{2,5})/i,
];

export function detectPort(line: string): number | null {
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) {
      const value = Number.parseInt(match[1], 10);
      if (value > 0 && value <= 65535) {
        return value;
      }
    }
  }
  return null;
}
