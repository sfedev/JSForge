/**
 * Forge Vault: lectura y escritura de archivos `.env` y almacen de secretos.
 *
 * Politica de exposicion, identica a la del resto del IDE:
 *
 *  - Los valores secretos se ENMASCARAN antes de cruzar el IPC. El renderer
 *    no recibe una credencial salvo que el usuario pulse «revelar» sobre una
 *    clave concreta.
 *  - Al guardar, un valor puede promocionarse al almacen cifrado del sistema
 *    y salir del archivo en texto plano. Esa es la razon de ser del modulo.
 *
 * La escritura CONSERVA comentarios y orden: en un `.env`, los comentarios
 * son la unica documentacion de para que sirve cada clave, y regenerar el
 * archivo desde un mapa los perderia.
 */

import {
  forgeError,
  type VaultEdit,
  type VaultFileView,
  type VaultVariable,
  type VaultView,
  type VaultWriteRequest,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { getWorkspaceRoot, requireWorkspaceRoot } from '../workspace-service.js';
import { exists, readTextIfExists, writeFile } from '../fs-service.js';
import { isSecretKey, maskValue, parseEnvFile } from '../process/env-service.js';
import {
  analyzeEnvironment,
  applyEnvEdits,
  formatFor,
  type EnvFileSnapshot,
} from './env-validate.js';
import {
  deleteSecret,
  getSecret,
  isSecureStorageAvailable,
  listEntries,
  setSecret,
} from './secret-store.js';

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

/** Archivos que el vault gestiona, en el orden en que se muestran. */
const ENV_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.test',
  '.env.production',
];

const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template'];

/** Solo se admiten los archivos conocidos: no es un editor de texto generico. */
function assertManagedFile(relative: string): void {
  if (![...ENV_FILES, ...EXAMPLE_FILES].includes(relative)) {
    failure(
      'E_INVALID_ARGUMENT',
      `"${relative}" no es un archivo de entorno gestionado por el vault.`,
      `Archivos admitidos: ${[...ENV_FILES, ...EXAMPLE_FILES].join(', ')}.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Lectura                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Comentario que precede a una clave y su linea.
 *
 * Se recorre el archivo hacia atras desde la definicion: las lineas de
 * comentario contiguas justo encima son su documentacion.
 */
function annotate(source: string): Map<string, { line: number; comment?: string }> {
  const out = new Map<string, { line: number; comment?: string }>();
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equals = withoutExport.indexOf('=');
    if (equals === -1) {
      continue;
    }
    const key = withoutExport.slice(0, equals).trim();

    const comments: string[] = [];
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = (lines[cursor] ?? '').trim();
      if (!previous.startsWith('#')) {
        break;
      }
      comments.unshift(previous.replace(/^#+\s?/, ''));
    }
    const comment = comments.join(' ').trim();
    out.set(key, { line: index + 1, ...(comment === '' ? {} : { comment }) });
  }
  return out;
}

async function readFileView(relative: string, isExample: boolean): Promise<VaultFileView | null> {
  const source = await readTextIfExists(relative);
  if (source === null) {
    return null;
  }
  const parsed = parseEnvFile(source);
  const annotations = annotate(source);

  const variables: VaultVariable[] = [];
  for (const [key, value] of parsed) {
    // En el archivo de ejemplo nada es secreto: por definicion no contiene
    // valores reales, y enmascararlo escondería justo lo que documenta.
    const secret = !isExample && isSecretKey(key);
    const annotation = annotations.get(key);
    variables.push({
      key,
      value: secret ? maskValue(value) : value,
      secret,
      format: formatFor(key),
      line: annotation?.line ?? 1,
      ...(annotation?.comment === undefined ? {} : { comment: annotation.comment }),
    });
  }

  return { path: relative, isExample, variables };
}

/** Vista completa del vault: archivos, avisos y claves del almacen. */
export async function readVault(): Promise<VaultView> {
  const root = requireWorkspaceRoot();

  const files: VaultFileView[] = [];
  const snapshots: EnvFileSnapshot[] = [];

  for (const relative of ENV_FILES) {
    const view = await readFileView(relative, false);
    if (view !== null) {
      files.push(view);
      const source = await readTextIfExists(relative);
      snapshots.push({ path: relative, variables: parseEnvFile(source ?? '') });
    }
  }

  let example: EnvFileSnapshot | null = null;
  for (const relative of EXAMPLE_FILES) {
    const view = await readFileView(relative, true);
    if (view !== null) {
      files.push(view);
      const source = await readTextIfExists(relative);
      example = { path: relative, variables: parseEnvFile(source ?? '') };
      break;
    }
  }

  return {
    files,
    issues: analyzeEnvironment(snapshots, example),
    vaultKeys: listEntries(root).map((entry) => entry.key),
    secureStorageAvailable: isSecureStorageAvailable(),
  };
}

/** Revela el valor real de UNA clave, bajo peticion explicita. */
export async function revealValue(relative: string, key: string): Promise<string> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, relative);
  assertManagedFile(guarded.relative);

  const source = await readTextIfExists(guarded.relative);
  if (source === null) {
    return '';
  }
  return parseEnvFile(source).get(key) ?? '';
}

/* -------------------------------------------------------------------------- */
/*  Escritura                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Aplica los cambios de la tabla a un archivo `.env`.
 *
 * Crea el archivo si no existia: anadir la primera variable a un proyecto
 * recien clonado es el caso mas frecuente.
 */
export async function writeVault(request: VaultWriteRequest): Promise<VaultView> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, request.path);
  assertManagedFile(guarded.relative);

  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    failure('E_INVALID_ARGUMENT', 'No se indico ningun cambio que aplicar.');
  }
  for (const edit of request.edits) {
    if (typeof edit.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(edit.key)) {
      failure(
        'E_INVALID_ARGUMENT',
        `"${String(edit.key)}" no es un nombre de variable valido.`,
        'Se admiten letras, digitos, guion bajo y punto, sin empezar por digito.',
      );
    }
  }

  const source = (await exists(guarded.relative)) ? await readTextIfExists(guarded.relative) : '';
  const edits = new Map<string, string | null>(
    request.edits.map((edit: VaultEdit) => [edit.key, edit.value]),
  );

  const next = applyEnvEdits(source ?? '', edits);
  await writeFile({ path: guarded.relative, content: next });

  const view = await readVault();
  emit({ type: 'vault/changed', payload: view });
  return view;
}

/* -------------------------------------------------------------------------- */
/*  Almacen cifrado                                                            */
/* -------------------------------------------------------------------------- */

export function vaultSecrets(): readonly string[] {
  return listEntries(requireWorkspaceRoot()).map((entry) => entry.key);
}

/**
 * Pares clave/valor del almacen, ya descifrados, para inyectarlos en el
 * entorno de los procesos que lanza el IDE.
 *
 * Lo consume `env-service` a traves del proveedor que registra `main.ts`;
 * no hay ningun canal IPC que lo exponga.
 */
export function vaultEnvEntries(): readonly (readonly [string, string])[] {
  const root = getWorkspaceRoot();
  if (root === null) {
    return [];
  }
  const pairs: (readonly [string, string])[] = [];
  for (const entry of listEntries(root)) {
    const value = getSecret(root, entry.key);
    if (value !== null) {
      pairs.push([entry.key, value]);
    }
  }
  return pairs;
}

/**
 * Guarda un valor en el almacen cifrado del sistema.
 *
 * Si el sistema no puede cifrar, falla en lugar de guardar en claro: el
 * usuario creeria que su credencial esta protegida cuando no lo estaria.
 */
export function storeSecret(key: string, value: string): true {
  const root = requireWorkspaceRoot();
  if (typeof key !== 'string' || key.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'El secreto no declara ninguna clave.');
  }
  if (!setSecret(root, key, value)) {
    failure(
      'E_NOT_AVAILABLE',
      'El sistema no ofrece cifrado: no se ha guardado nada.',
      'Guardar el valor en claro seria peor que no guardarlo.',
    );
  }
  return true;
}

export function removeSecret(key: string): true {
  return deleteSecret(requireWorkspaceRoot(), key);
}

export function readSecret(key: string): string {
  const value = getSecret(requireWorkspaceRoot(), key);
  if (value === null) {
    failure('E_NOT_FOUND', `No hay ningun secreto guardado con la clave "${key}".`);
  }
  return value;
}

/**
 * Mueve una variable del archivo al almacen cifrado.
 *
 * El valor se guarda cifrado y la linea DESAPARECE del `.env`, que es lo que
 * convierte esto en una mejora real de seguridad y no en una copia mas.
 */
export async function promoteToVault(relative: string, key: string): Promise<VaultView> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, relative);
  assertManagedFile(guarded.relative);

  if (!isSecureStorageAvailable()) {
    failure(
      'E_NOT_AVAILABLE',
      'El sistema no ofrece cifrado: no se puede promover el secreto.',
      'La variable se deja intacta en el archivo.',
    );
  }

  const source = await readTextIfExists(guarded.relative);
  if (source === null) {
    failure('E_NOT_FOUND', `No se encontro "${guarded.relative}".`);
  }
  const value = parseEnvFile(source).get(key);
  if (value === undefined) {
    failure('E_NOT_FOUND', `"${key}" no existe en ${guarded.relative}.`);
  }

  // Primero se cifra y solo despues se borra del archivo: al reves, un fallo
  // al guardar dejaria el valor perdido para siempre.
  if (!setSecret(root, key, value)) {
    failure('E_NOT_AVAILABLE', 'No se pudo cifrar el valor; el archivo no se ha tocado.');
  }

  const next = applyEnvEdits(source, new Map([[key, null]]));
  await writeFile({ path: guarded.relative, content: next });

  const view = await readVault();
  emit({ type: 'vault/changed', payload: view });
  return view;
}

/* -------------------------------------------------------------------------- */
/*  Sincronizacion con el ejemplo                                              */
/* -------------------------------------------------------------------------- */

/**
 * Escribe en `.env.example` las claves que existan en los `.env` reales,
 * SIN sus valores.
 *
 * Es lo que mantiene el ejemplo util: documenta que hace falta configurar sin
 * filtrar ni una credencial. Los valores nuevos se dejan vacios a proposito.
 */
export async function syncExample(): Promise<VaultView> {
  const root = requireWorkspaceRoot();
  const target = EXAMPLE_FILES[0] ?? '.env.example';
  assertInsideWorkspace(root, target);

  const declared = new Map<string, string>();
  for (const relative of ENV_FILES) {
    const source = await readTextIfExists(relative);
    if (source === null) {
      continue;
    }
    for (const [key, value] of parseEnvFile(source)) {
      // Solo se copia el valor si NO es sensible; si lo es, queda vacio.
      declared.set(key, isSecretKey(key) ? '' : value);
    }
  }

  if (declared.size === 0) {
    failure('E_NOT_FOUND', 'No hay ningun archivo .env del que extraer claves.');
  }

  const existing = (await readTextIfExists(target)) ?? '';
  const present = parseEnvFile(existing);
  const edits = new Map<string, string | null>();
  for (const [key, value] of declared) {
    if (!present.has(key)) {
      edits.set(key, value);
    }
  }

  if (edits.size > 0) {
    await writeFile({ path: target, content: applyEnvEdits(existing, edits) });
  }

  const view = await readVault();
  emit({ type: 'vault/changed', payload: view });
  return view;
}
