/**
 * Analizador del formato `.http` / `.rest`.
 *
 * Sintaxis admitida:
 *
 *   @baseUrl = http://localhost:3000
 *
 *   ### Crear usuario
 *   POST {{baseUrl}}/api/users
 *   Content-Type: application/json
 *   Authorization: Bearer {{token}}
 *
 *   {
 *     "nombre": "Sergio"
 *   }
 *
 * Reglas:
 *  - `###` separa peticiones y su texto es el nombre.
 *  - `#` y `//` son comentarios.
 *  - Las variables `{{nombre}}` se resuelven con las declaradas con `@`.
 *  - El cuerpo empieza tras la primera linea en blanco posterior a las
 *    cabeceras y termina en el siguiente separador.
 */

import type { HttpRequestSpec } from '../../../shared/contracts.js';

const METHOD_PATTERN =
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i;

const VARIABLE_PATTERN = /^@([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

/** Sustituye `{{variable}}`; deja intacta la que no exista. */
export function interpolate(text: string, variables: ReadonlyMap<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (match, name: string) => {
    const value = variables.get(name);
    return value === undefined ? match : value;
  });
}

export function parseHttpFile(source: string): readonly HttpRequestSpec[] {
  const lines = source.split(/\r?\n/);
  const variables = new Map<string, string>();
  const requests: HttpRequestSpec[] = [];

  let index = 0;
  let counter = 0;
  let pendingName: string | undefined;

  while (index < lines.length) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    index += 1;

    if (line === '') {
      continue;
    }
    if (line.startsWith('###')) {
      const name = line.replace(/^#+/, '').trim();
      pendingName = name === '' ? undefined : name;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('//')) {
      continue;
    }

    const variableMatch = VARIABLE_PATTERN.exec(line);
    if (variableMatch !== null) {
      const name = variableMatch[1];
      const value = variableMatch[2] ?? '';
      if (name !== undefined) {
        // Una variable puede referirse a otra declarada antes.
        variables.set(name, interpolate(value.trim(), variables));
      }
      continue;
    }

    const methodMatch = METHOD_PATTERN.exec(line);
    if (methodMatch === null) {
      continue;
    }

    const startLine = index; // Base 1: `index` ya apunta a la siguiente.
    const method = (methodMatch[1] ?? 'GET').toUpperCase();
    const url = interpolate(methodMatch[2] ?? '', variables);

    /* --- Cabeceras --- */
    const headers: Record<string, string> = {};
    while (index < lines.length) {
      const headerLine = (lines[index] ?? '').trim();
      if (headerLine === '') {
        index += 1;
        break;
      }
      if (headerLine.startsWith('###')) {
        break;
      }
      if (headerLine.startsWith('#') || headerLine.startsWith('//')) {
        index += 1;
        continue;
      }
      const colon = headerLine.indexOf(':');
      if (colon === -1) {
        break;
      }
      const name = headerLine.slice(0, colon).trim();
      const value = interpolate(headerLine.slice(colon + 1).trim(), variables);
      if (name !== '') {
        headers[name] = value;
      }
      index += 1;
    }

    /* --- Cuerpo --- */
    const bodyLines: string[] = [];
    while (index < lines.length) {
      const bodyLine = lines[index] ?? '';
      if (bodyLine.trim().startsWith('###')) {
        break;
      }
      bodyLines.push(bodyLine);
      index += 1;
    }
    const body = interpolate(bodyLines.join('\n').trim(), variables);

    counter += 1;
    requests.push({
      id: `http-${counter}`,
      ...(pendingName === undefined ? {} : { name: pendingName }),
      method,
      url,
      headers,
      ...(body === '' ? {} : { body }),
      line: startLine,
    });
    pendingName = undefined;
  }

  return requests;
}

/* -------------------------------------------------------------------------- */
/*  Lente de endpoints                                                         */
/* -------------------------------------------------------------------------- */

import type { HttpEndpointLens } from '../../../shared/contracts.js';

/** Express y Fastify: `app.get('/ruta', ...)`, `router.post('/x', ...)`. */
const EXPRESS_PATTERN =
  /\b(?:app|router|server|fastify|api)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

/** NestJS: decoradores `@Get('ruta')` sobre metodos de un controlador. */
const NEST_METHOD_PATTERN = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
const NEST_CONTROLLER_PATTERN = /@Controller\s*\(\s*(?:['"`]([^'"`]*)['"`])?/;

/** Next.js App Router: `export async function GET(...)` en `route.ts`. */
const NEXT_HANDLER_PATTERN =
  /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
    }
  }
  return line;
}

function joinRoutes(base: string, route: string): string {
  const left = base.replace(/\/+$/, '');
  const right = route.replace(/^\/+/, '');
  if (right === '') {
    return left === '' ? '/' : `/${left.replace(/^\/+/, '')}`;
  }
  return left === '' ? `/${right}` : `/${left.replace(/^\/+/, '')}/${right}`;
}

/**
 * Detecta endpoints por analisis textual. Es una lente de comodidad, no un
 * analizador semantico: prefiere no reportar nada a reportar algo falso.
 */
export function detectEndpoints(relativePath: string, source: string): readonly HttpEndpointLens[] {
  const found: HttpEndpointLens[] = [];

  /* --- Next.js App Router --- */
  if (/(^|\/)route\.[cm]?[jt]sx?$/.test(relativePath)) {
    // La ruta HTTP se deduce de la ubicacion del archivo.
    const route = relativePath
      .replace(/^(src\/)?app\//, '')
      .replace(/\/route\.[cm]?[jt]sx?$/, '')
      // Los grupos `(admin)` no forman parte de la URL.
      .replace(/\([^/]+\)\//g, '')
      // `[id]` se muestra como `:id`.
      .replace(/\[\.\.\.([^\]]+)\]/g, '*')
      .replace(/\[([^\]]+)\]/g, ':$1');

    NEXT_HANDLER_PATTERN.lastIndex = 0;
    let match = NEXT_HANDLER_PATTERN.exec(source);
    while (match !== null) {
      found.push({
        path: relativePath,
        line: lineOf(source, match.index),
        method: (match[1] ?? 'GET').toUpperCase(),
        route: route === '' ? '/' : `/${route}`,
        framework: 'next',
      });
      match = NEXT_HANDLER_PATTERN.exec(source);
    }
    return found;
  }

  /* --- NestJS --- */
  if (source.includes('@Controller')) {
    const base = NEST_CONTROLLER_PATTERN.exec(source)?.[1] ?? '';
    NEST_METHOD_PATTERN.lastIndex = 0;
    let match = NEST_METHOD_PATTERN.exec(source);
    while (match !== null) {
      found.push({
        path: relativePath,
        line: lineOf(source, match.index),
        method: (match[1] ?? 'GET').toUpperCase() === 'ALL' ? 'GET' : (match[1] ?? 'GET').toUpperCase(),
        route: joinRoutes(base, match[2] ?? ''),
        framework: 'nestjs',
      });
      match = NEST_METHOD_PATTERN.exec(source);
    }
    return found;
  }

  /* --- Express / Fastify --- */
  const isFastify = /\bfastify\b/.test(source);
  EXPRESS_PATTERN.lastIndex = 0;
  let match = EXPRESS_PATTERN.exec(source);
  while (match !== null) {
    const method = (match[1] ?? 'get').toUpperCase();
    found.push({
      path: relativePath,
      line: lineOf(source, match.index),
      method: method === 'ALL' ? 'GET' : method,
      route: match[2] ?? '/',
      framework: isFastify ? 'fastify' : 'express',
    });
    match = EXPRESS_PATTERN.exec(source);
  }
  return found;
}
