/**
 * Analizador del subconjunto de YAML que usan los archivos docker-compose.
 *
 * No se depende de una libreria de YAML: solo se necesita el subconjunto
 * real de estos archivos (mapas anidados por indentacion, listas con `-`,
 * escalares y comentarios), y un parser propio acotado es mas pequeno y mas
 * predecible que arrastrar un analizador completo con sus modos exoticos.
 *
 * Lo que NO se soporta, y se ignora sin romper: anclas y alias (`&`/`*`),
 * bloques literales multilinea (`|`, `>`) mas alla de conservarlos como
 * texto, y documentos multiples.
 */

import type {
  ComposeFileView,
  ComposePortMapping,
  ComposeService,
  DotForgeServiceKind,
} from '../../../shared/contracts.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { readTextIfExists } from '../fs-service.js';
import { requireWorkspaceRoot } from '../workspace-service.js';

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

/** Elimina comentarios de fin de linea respetando las comillas. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1] ?? ''))) {
      return text.slice(0, index);
    }
  }
  return text;
}

function parseScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') {
    return null;
  }
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  if (text === 'true' || text === 'yes' || text === 'on') {
    return true;
  }
  if (text === 'false' || text === 'no' || text === 'off') {
    return false;
  }
  // Los puertos y versiones se conservan como texto para no perder ceros
  // a la izquierda ni convertir "3.9" en un numero.
  return text;
}

function collectLines(source: string): Line[] {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === '') {
      return;
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, text: withoutComment.trim(), number: index + 1 });
  });
  return lines;
}

/** Analiza un bloque a partir de `start` con la indentacion dada. */
function parseBlock(lines: readonly Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[start];
  if (first === undefined) {
    return { value: null, next: start };
  }

  /* --- Lista --- */
  if (first.text.startsWith('- ') || first.text === '-') {
    const items: YamlValue[] = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.indent < indent || !(line.text.startsWith('- ') || line.text === '-')) {
        break;
      }
      const inline = line.text === '-' ? '' : line.text.slice(2).trim();
      if (inline === '') {
        // El elemento es un mapa anidado en las lineas siguientes.
        const nested = parseBlock(lines, index + 1, (lines[index + 1]?.indent ?? indent + 2));
        items.push(nested.value);
        index = nested.next;
        continue;
      }
      // `- clave: valor` inicia un mapa dentro del elemento.
      const colon = findKeyColon(inline);
      if (colon !== -1) {
        const map: Record<string, YamlValue> = {};
        const key = inline.slice(0, colon).trim();
        const rest = inline.slice(colon + 1).trim();
        map[key] = rest === '' ? null : parseScalar(rest);

        let cursor = index + 1;
        const childIndent = lines[cursor]?.indent ?? -1;
        if (childIndent > line.indent) {
          const nested = parseBlock(lines, cursor, childIndent);
          if (typeof nested.value === 'object' && nested.value !== null && !Array.isArray(nested.value)) {
            Object.assign(map, nested.value);
          }
          cursor = nested.next;
        }
        items.push(map);
        index = cursor;
        continue;
      }
      items.push(parseScalar(inline));
      index += 1;
    }
    return { value: items, next: index };
  }

  /* --- Mapa --- */
  const map: Record<string, YamlValue> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      // Indentacion inesperada: se salta para no abortar el archivo entero.
      index += 1;
      continue;
    }
    const colon = findKeyColon(line.text);
    if (colon === -1) {
      index += 1;
      continue;
    }
    const key = unquote(line.text.slice(0, colon).trim());
    const rest = line.text.slice(colon + 1).trim();

    if (rest !== '') {
      map[key] = parseInlineValue(rest);
      index += 1;
      continue;
    }

    const child = lines[index + 1];
    if (child === undefined || child.indent <= line.indent) {
      map[key] = null;
      index += 1;
      continue;
    }
    const nested = parseBlock(lines, index + 1, child.indent);
    map[key] = nested.value;
    index = nested.next;
  }
  return { value: map, next: index };
}

/** Posicion del `:` que separa clave y valor, ignorando los de las comillas. */
function findKeyColon(text: string): number {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ':') {
      const next = text[index + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        return index;
      }
    }
  }
  return -1;
}

function unquote(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Valores en linea, incluidas las listas cortas `[a, b]`. */
function parseInlineValue(text: string): YamlValue {
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (inner === '') {
      return [];
    }
    return inner.split(',').map((entry) => parseScalar(entry));
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    const map: Record<string, YamlValue> = {};
    if (inner === '') {
      return map;
    }
    for (const pair of inner.split(',')) {
      const colon = pair.indexOf(':');
      if (colon === -1) {
        continue;
      }
      map[unquote(pair.slice(0, colon).trim())] = parseScalar(pair.slice(colon + 1));
    }
    return map;
  }
  return parseScalar(text);
}

export function parseYaml(source: string): YamlValue {
  const lines = collectLines(source);
  if (lines.length === 0) {
    return {};
  }
  return parseBlock(lines, 0, lines[0]?.indent ?? 0).value;
}

/* -------------------------------------------------------------------------- */
/*  Interpretacion de docker-compose                                           */
/* -------------------------------------------------------------------------- */

/** Deduce la clase de servicio a partir de la imagen. */
export function kindFromImage(image: string | undefined): DotForgeServiceKind {
  if (image === undefined) {
    return 'other';
  }
  const lower = image.toLowerCase();
  if (lower.includes('postgres') || lower.includes('pgvector') || lower.includes('timescale')) {
    return 'postgres';
  }
  if (lower.includes('mysql') || lower.includes('mariadb')) {
    return 'mysql';
  }
  if (lower.includes('mongo')) {
    return 'mongo';
  }
  if (lower.includes('redis') || lower.includes('valkey')) {
    return 'redis';
  }
  if (lower.includes('mailhog') || lower.includes('mailpit')) {
    return 'mailhog';
  }
  return 'other';
}

/**
 * Analiza las formas de `ports`: `"5432:5432"`, `5432`, `"127.0.0.1:5432:5432"`
 * y la forma extendida `{ published: 5432, target: 5432 }`.
 */
export function parsePorts(value: YamlValue): ComposePortMapping[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mappings: ComposePortMapping[] = [];

  for (const entry of value) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const published = Number.parseInt(String(entry['published'] ?? ''), 10);
      const target = Number.parseInt(String(entry['target'] ?? ''), 10);
      if (Number.isFinite(published) && Number.isFinite(target)) {
        mappings.push({ host: published, container: target });
      }
      continue;
    }
    const text = String(entry).replace(/\/(tcp|udp)$/i, '');
    const parts = text.split(':');
    if (parts.length === 1) {
      const port = Number.parseInt(parts[0] ?? '', 10);
      if (Number.isFinite(port)) {
        mappings.push({ host: port, container: port });
      }
      continue;
    }
    // Con tres partes la primera es la IP de escucha y se descarta.
    const host = Number.parseInt(parts[parts.length - 2] ?? '', 10);
    const container = Number.parseInt(parts[parts.length - 1] ?? '', 10);
    if (Number.isFinite(host) && Number.isFinite(container)) {
      mappings.push({ host, container });
    }
  }
  return mappings;
}

/** `environment` admite mapa (`CLAVE: valor`) o lista (`- CLAVE=valor`). */
export function parseEnvironment(value: YamlValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = String(entry);
      const equals = text.indexOf('=');
      if (equals === -1) {
        out[text] = '';
      } else {
        out[text.slice(0, equals)] = text.slice(equals + 1);
      }
    }
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      out[key] = entry === null ? '' : String(entry);
    }
  }
  return out;
}

export function interpretCompose(relativePath: string, source: string): ComposeFileView {
  const warnings: string[] = [];
  const document = parseYaml(source);

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { path: relativePath, services: [], warnings: ['El archivo no contiene un mapa YAML valido.'] };
  }

  const servicesRaw = document['services'];
  if (typeof servicesRaw !== 'object' || servicesRaw === null || Array.isArray(servicesRaw)) {
    return { path: relativePath, services: [], warnings: ['El archivo no declara "services".'] };
  }

  const services: ComposeService[] = [];
  for (const [name, raw] of Object.entries(servicesRaw)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      warnings.push(`El servicio "${name}" no es un mapa; se ignoro.`);
      continue;
    }
    const image = typeof raw['image'] === 'string' ? raw['image'] : undefined;
    if (image === undefined && raw['build'] === undefined) {
      warnings.push(`El servicio "${name}" no declara ni "image" ni "build".`);
    }
    const volumes = Array.isArray(raw['volumes'])
      ? raw['volumes'].map((entry) => String(entry))
      : [];

    services.push({
      name,
      ...(image === undefined ? {} : { image }),
      kind: kindFromImage(image),
      ports: parsePorts(raw['ports'] ?? []),
      environment: parseEnvironment(raw['environment'] ?? {}),
      volumes,
    });
  }

  return { path: relativePath, services, warnings };
}

/** Lee y analiza un docker-compose del workspace. */
export async function readCompose(relativePath: string): Promise<ComposeFileView> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, relativePath);
  const source = await readTextIfExists(guarded.relative);
  if (source === null) {
    return { path: guarded.relative, services: [], warnings: ['El archivo no existe.'] };
  }
  return interpretCompose(guarded.relative, source);
}
