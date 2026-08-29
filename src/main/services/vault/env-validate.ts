/**
 * Validacion de valores de entorno y comparacion entre archivos.
 *
 * Dos cosas que el editor tabular necesita y que se prueban sin tocar disco:
 *
 *  1. Reconocer el formato esperado de una variable por su nombre. Una clave
 *     que se llama `PORT` y vale `abc` es un error que hoy solo se descubre
 *     al arrancar el servidor.
 *  2. Comparar `.env` con `.env.example` para senalar lo que falta. Es el
 *     fallo mas comun al clonar un proyecto y el mas tonto de depurar.
 *
 * Las reglas son advertencias, no prohibiciones: el editor avisa y deja
 * guardar igual. Un formato «raro» puede ser perfectamente intencionado, y
 * un editor que se niega a guardar es peor que uno que no valida.
 */

import type { EnvIssue, EnvIssueKind, EnvValueFormat } from '../../../shared/contracts.js';

/** Reglas de formato deducidas del nombre de la variable. */
const FORMAT_RULES: readonly { readonly pattern: RegExp; readonly format: EnvValueFormat }[] = [
  { pattern: /(^|_)PORT$/i, format: 'port' },
  { pattern: /(^|_)(URL|URI|ENDPOINT)$/i, format: 'url' },
  { pattern: /(^|_)DSN$/i, format: 'url' },
  { pattern: /(^|_)EMAIL$/i, format: 'email' },
  { pattern: /(^|_)(ENABLED|DISABLED|DEBUG|VERBOSE)$/i, format: 'boolean' },
  { pattern: /(^|_)(TIMEOUT|INTERVAL|TTL|MAX|MIN|LIMIT|RETRIES)(_MS|_S)?$/i, format: 'number' },
  { pattern: /(^|_)(BASE64|B64)$/i, format: 'base64' },
  { pattern: /(^|_)(SECRET|TOKEN|KEY|PASSWORD)$/i, format: 'secret' },
];

export function formatFor(key: string): EnvValueFormat {
  for (const rule of FORMAT_RULES) {
    if (rule.pattern.test(key)) {
      return rule.format;
    }
  }
  return 'text';
}

/* -------------------------------------------------------------------------- */
/*  Validadores                                                                */
/* -------------------------------------------------------------------------- */

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Puerto valido: entero de 1 a 65535. El 0 significa «el que sea». */
function validatePort(value: string): string | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return 'No es un puerto valido: se espera un entero entre 0 y 65535.';
  }
  if (parsed !== 0 && parsed < 1024) {
    return 'Los puertos por debajo de 1024 requieren privilegios elevados.';
  }
  return null;
}

/**
 * URL utilizable.
 *
 * Se acepta cualquier esquema porque las cadenas de conexion no son http
 * (`postgres://`, `redis://`, `mongodb+srv://`). Lo que se comprueba es que
 * tenga esquema y algo detras.
 */
function validateUrl(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return 'No parece una URL: falta el esquema (por ejemplo, https:// o postgres://).';
  }
  try {
    const parsed = new URL(value);
    if (parsed.host === '' && parsed.pathname === '') {
      return 'La URL no indica ningun destino.';
    }
  } catch {
    return 'La URL no se puede interpretar.';
  }
  return null;
}

function validateBoolean(value: string): string | null {
  return ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())
    ? null
    : 'Se esperaba un booleano (true/false, 1/0, yes/no, on/off).';
}

function validateNumber(value: string): string | null {
  return Number.isFinite(Number(value)) ? null : 'Se esperaba un valor numerico.';
}

function validateBase64(value: string): string | null {
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    return 'No es Base64 valido.';
  }
  return null;
}

function validateEmail(value: string): string | null {
  return EMAIL_RE.test(value) ? null : 'No parece una direccion de correo.';
}

/**
 * Valida un valor segun el formato deducido de su nombre.
 * Devuelve el mensaje del problema, o `null` si esta en orden.
 */
export function validateValue(key: string, value: string, format = formatFor(key)): string | null {
  // Un valor vacio se senala aparte, con su propio tipo de aviso.
  if (value === '') {
    return null;
  }
  switch (format) {
    case 'port':
      return validatePort(value);
    case 'url':
      return validateUrl(value);
    case 'boolean':
      return validateBoolean(value);
    case 'number':
      return validateNumber(value);
    case 'base64':
      return validateBase64(value);
    case 'email':
      return validateEmail(value);
    case 'secret':
      // Un secreto de menos de 8 caracteres casi siempre es un marcador de
      // posicion que se quedo sin sustituir.
      return value.length < 8
        ? 'El valor es muy corto para un secreto: parece un marcador sin sustituir.'
        : null;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Analisis de un conjunto de archivos                                        */
/* -------------------------------------------------------------------------- */

/** Marcadores de posicion que suelen quedarse sin sustituir. */
const PLACEHOLDER_RE =
  /^(<.*>|your[-_ ]?.*|changeme|xxx+|todo|tbd|placeholder|\.\.\.|__.*__)$/i;

export interface EnvFileSnapshot {
  readonly path: string;
  readonly variables: ReadonlyMap<string, string>;
}

/**
 * Compara los archivos de un proyecto y produce la lista de avisos.
 *
 * `example` es el archivo de referencia (`.env.example`), si existe. La
 * comparacion se hace en los dos sentidos: lo que falta y lo que sobra. Lo
 * que sobra tambien importa: una variable en `.env` que ya no esta en el
 * ejemplo suele ser configuracion muerta.
 */
export function analyzeEnvironment(
  files: readonly EnvFileSnapshot[],
  example: EnvFileSnapshot | null,
): readonly EnvIssue[] {
  const issues: EnvIssue[] = [];

  const add = (
    kind: EnvIssueKind,
    file: string,
    key: string,
    message: string,
    severity: EnvIssue['severity'],
  ): void => {
    issues.push({ kind, file, key, message, severity });
  };

  for (const file of files) {
    for (const [key, value] of file.variables) {
      if (value === '') {
        add('empty', file.path, key, 'La variable no tiene valor.', 'warning');
        continue;
      }
      if (PLACEHOLDER_RE.test(value.trim())) {
        add(
          'placeholder',
          file.path,
          key,
          'El valor parece un marcador de posicion sin sustituir.',
          'warning',
        );
        continue;
      }
      const problem = validateValue(key, value);
      if (problem !== null) {
        add('invalid-format', file.path, key, problem, 'warning');
      }
    }
  }

  if (example === null) {
    return issues;
  }

  // Las claves declaradas en el ejemplo y ausentes en el resto.
  const declared = new Set<string>();
  for (const file of files) {
    for (const key of file.variables.keys()) {
      declared.add(key);
    }
  }

  for (const key of example.variables.keys()) {
    if (!declared.has(key)) {
      add(
        'missing',
        example.path,
        key,
        `"${key}" esta en ${example.path} pero no se define en ningun .env.`,
        'error',
      );
    }
  }

  for (const file of files) {
    if (file.path === example.path) {
      continue;
    }
    for (const key of file.variables.keys()) {
      if (!example.variables.has(key)) {
        add(
          'undocumented',
          file.path,
          key,
          `"${key}" no aparece en ${example.path}: documentala o retirala.`,
          'info',
        );
      }
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Serializacion                                                              */
/* -------------------------------------------------------------------------- */

/** true si el valor necesita comillas para sobrevivir a una relectura. */
export function needsQuotes(value: string): boolean {
  return (
    value !== value.trim() ||
    /[\s#'"\\]/.test(value) ||
    value.includes('\n') ||
    value === ''
  );
}

/** Escribe un valor listo para un archivo `.env`. */
export function serializeValue(value: string): string {
  if (!needsQuotes(value)) {
    return value;
  }
  // Comillas dobles y escapado del propio caracter, la barra y el salto:
  // es lo que entiende `parseEnvFile` al releerlo.
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Reescribe un archivo `.env` aplicando cambios y CONSERVANDO comentarios,
 * lineas en blanco y el orden original.
 *
 * Regenerar el archivo desde el mapa de variables perderia los comentarios,
 * que es donde suele estar documentado para que sirve cada clave. Por eso se
 * edita linea a linea y solo se anaden al final las claves nuevas.
 */
export function applyEnvEdits(
  source: string,
  edits: ReadonlyMap<string, string | null>,
): string {
  const lines = source.split(/\r?\n/);
  const applied = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equals = withoutExport.indexOf('=');
    if (equals === -1) {
      out.push(line);
      continue;
    }
    const key = withoutExport.slice(0, equals).trim();
    if (!edits.has(key)) {
      out.push(line);
      continue;
    }

    applied.add(key);
    const value = edits.get(key);
    if (value === null || value === undefined) {
      // Eliminada: la linea desaparece.
      continue;
    }
    // Se conserva el `export` si lo tenia: puede que el archivo se cargue
    // con `source`, y quitarlo lo romperia.
    const prefix = trimmed.startsWith('export ') ? 'export ' : '';
    out.push(`${prefix}${key}=${serializeValue(value)}`);
  }

  const added = [...edits.entries()].filter(
    ([key, value]) => !applied.has(key) && value !== null,
  );
  if (added.length > 0) {
    if (out.length > 0 && (out[out.length - 1] ?? '').trim() !== '') {
      out.push('');
    }
    for (const [key, value] of added) {
      out.push(`${key}=${serializeValue(value ?? '')}`);
    }
  }

  // Se garantiza el salto final: sin el, el siguiente `echo VAR=x >>` pega
  // la variable nueva a la ultima linea.
  const text = out.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}
