/**
 * Gestor de variables de entorno.
 *
 * Lee los archivos `.env` del workspace y los perfiles declarados en
 * DotForge. Los valores sensibles se enmascaran ANTES de cruzar la frontera
 * IPC: el renderer nunca recibe un secreto salvo que el usuario pulse
 * explicitamente "revelar" sobre una clave concreta.
 */

import type { DotForgeEnvironment, EnvFileView, EnvVariableView } from '../../../shared/contracts.js';
import { readTextIfExists } from '../fs-service.js';
import { readManifest } from '../dotforge/config-service.js';

/** Nombres que casi siempre contienen credenciales. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /\bpwd\b/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /credential/i,
  /\bauth\b/i,
  /session/i,
  /cookie/i,
  /signature/i,
  /dsn$/i,
  /_url$/i, // Las URL de conexion suelen llevar usuario y contrasena.
];

const DEFAULT_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

export function isSecretKey(key: string, declared: readonly string[] = []): boolean {
  if (declared.some((entry) => entry.toLowerCase() === key.toLowerCase())) {
    return true;
  }
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Enmascara conservando el primer y el ultimo caracter cuando el valor es
 * suficientemente largo: ayuda a distinguir dos claves sin revelarlas.
 */
export function maskValue(value: string): string {
  if (value === '') {
    return '';
  }
  if (value.length <= 4) {
    return '•'.repeat(value.length);
  }
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(value.length - 4, 16))}${value.slice(-2)}`;
}

/**
 * Analiza un archivo `.env`.
 *
 * Soporta `export VAR=valor`, comillas simples y dobles, comentarios de
 * linea completa y al final de una linea sin comillas, y valores vacios.
 * Las secuencias `\n` dentro de comillas dobles se expanden, como en dotenv.
 */
export function parseEnvFile(source: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equals = withoutExport.indexOf('=');
    if (equals === -1) {
      continue;
    }
    const key = withoutExport.slice(0, equals).trim();
    if (key === '' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      continue;
    }

    let value = withoutExport.slice(equals + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Sin comillas, un `#` inicia un comentario al final de la linea.
      const hash = value.indexOf(' #');
      if (hash !== -1) {
        value = value.slice(0, hash).trim();
      }
    }
    out.set(key, value);
  }
  return out;
}

/** Archivos `.env` a considerar para el entorno indicado. */
async function filesForEnvironment(environmentId?: string | null): Promise<{
  files: readonly string[];
  environment: DotForgeEnvironment | undefined;
}> {
  const manifest = await readManifest();
  const environments = manifest.config.environments ?? {};
  const environment =
    environmentId === undefined || environmentId === null
      ? undefined
      : environments[environmentId];

  if (environment?.envFiles !== undefined && environment.envFiles.length > 0) {
    return { files: environment.envFiles, environment };
  }
  return { files: DEFAULT_ENV_FILES, environment };
}

/** Vista enmascarada de las variables, lista para el renderer. */
export async function readEnvironmentView(
  environmentId?: string | null,
): Promise<readonly EnvFileView[]> {
  const { files, environment } = await filesForEnvironment(environmentId);
  const declaredSecrets = environment?.secrets ?? [];
  const views: EnvFileView[] = [];

  for (const file of files) {
    const source = await readTextIfExists(file);
    if (source === null) {
      continue;
    }
    const parsed = parseEnvFile(source);
    const variables: EnvVariableView[] = [];
    for (const [key, value] of parsed) {
      const secret = isSecretKey(key, declaredSecrets);
      variables.push({
        key,
        value: secret ? maskValue(value) : value,
        secret,
        source: file,
      });
    }
    views.push({ path: file, variables });
  }

  // Variables declaradas directamente en el manifiesto (sin archivo).
  if (environment?.variables !== undefined && Object.keys(environment.variables).length > 0) {
    const variables: EnvVariableView[] = Object.entries(environment.variables).map(
      ([key, value]) => {
        const secret = isSecretKey(key, declaredSecrets);
        return {
          key,
          value: secret ? maskValue(value) : value,
          secret,
          source: 'dotforge.config.json',
        };
      },
    );
    views.push({ path: 'dotforge.config.json', variables });
  }

  return views;
}

/** Revela el valor real de UNA clave concreta, bajo peticion explicita. */
export async function revealVariable(file: string, key: string): Promise<string> {
  if (file === 'dotforge.config.json') {
    const manifest = await readManifest();
    for (const environment of Object.values(manifest.config.environments ?? {})) {
      const value = environment.variables?.[key];
      if (value !== undefined) {
        return value;
      }
    }
    return '';
  }
  const source = await readTextIfExists(file);
  if (source === null) {
    return '';
  }
  return parseEnvFile(source).get(key) ?? '';
}

/**
 * Entorno efectivo para lanzar un proceso: el del sistema, mas los archivos
 * `.env` del perfil, mas las variables declaradas en el manifiesto.
 */
export async function resolveProcessEnv(
  environmentId?: string | null,
  overrides: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> {
  const { files, environment } = await filesForEnvironment(environmentId);
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  for (const file of files) {
    const source = await readTextIfExists(file);
    if (source === null) {
      continue;
    }
    for (const [key, value] of parseEnvFile(source)) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(environment?.variables ?? {})) {
    result[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value;
  }

  // Los procesos de desarrollo se comportan mejor sin color ANSI, que el
  // visor de registros tendria que limpiar linea a linea.
  result['FORCE_COLOR'] = '0';
  result['NO_COLOR'] = '1';
  return result;
}

/** Claves consideradas secretas en el entorno actual, para el enmascarado. */
export async function secretKeys(environmentId?: string | null): Promise<Set<string>> {
  const { files, environment } = await filesForEnvironment(environmentId);
  const declared = environment?.secrets ?? [];
  const keys = new Set<string>();

  for (const file of files) {
    const source = await readTextIfExists(file);
    if (source === null) {
      continue;
    }
    for (const key of parseEnvFile(source).keys()) {
      if (isSecretKey(key, declared)) {
        keys.add(key);
      }
    }
  }
  for (const key of Object.keys(environment?.variables ?? {})) {
    if (isSecretKey(key, declared)) {
      keys.add(key);
    }
  }
  return keys;
}
