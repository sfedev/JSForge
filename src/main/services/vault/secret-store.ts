/**
 * Almacen cifrado de secretos de desarrollo.
 *
 * Sigue exactamente la misma politica que el almacen de claves API
 * (`ai/credentials.ts`), y por las mismas razones:
 *
 *  - Se cifra con `safeStorage`, que delega en DPAPI en Windows, en el
 *    Llavero en macOS y en el almacen del escritorio en Linux.
 *  - Si el sistema NO puede cifrar, no se guarda nada. Escribir un secreto
 *    en claro «para que al menos funcione» es peor que no guardarlo: el
 *    usuario creeria que esta protegido.
 *  - Los valores no salen del proceso principal. El renderer puede saber que
 *    claves existen y pedir revelar UNA concreta, nunca listarlas con sus
 *    valores.
 *
 * El almacen se separa por workspace: dos proyectos distintos no comparten
 * credenciales, y borrar uno no toca al otro.
 */

import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { VaultEntry } from '../../../shared/contracts.js';

interface VaultFile {
  readonly version: 1;
  /** clave -> valor cifrado en base64. */
  readonly secrets: Record<string, string>;
  /** clave -> instante de la ultima escritura. */
  readonly updatedAt: Record<string, number>;
}

const EMPTY: VaultFile = { version: 1, secrets: {}, updatedAt: {} };

/** Cache por workspace; se invalida al cambiar de proyecto. */
const cache = new Map<string, VaultFile>();

/**
 * Nombre del archivo derivado de la ruta del workspace.
 *
 * Se usa un hash y no la ruta: una ruta puede contener caracteres que no
 * valen en un nombre de archivo, y ademas asi el nombre no revela en que
 * carpeta trabaja el usuario a quien mire el directorio de datos.
 */
function vaultPath(workspaceRoot: string): string {
  const id = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'vaults', `${id}.json`);
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function load(workspaceRoot: string): VaultFile {
  const cached = cache.get(workspaceRoot);
  if (cached !== undefined) {
    return cached;
  }
  let file: VaultFile = EMPTY;
  try {
    const parsed = JSON.parse(readFileSync(vaultPath(workspaceRoot), 'utf8')) as Partial<VaultFile>;
    if (parsed.version === 1 && typeof parsed.secrets === 'object' && parsed.secrets !== null) {
      file = {
        version: 1,
        secrets: { ...parsed.secrets },
        updatedAt: { ...(parsed.updatedAt ?? {}) },
      };
    }
  } catch {
    // Archivo ausente o corrupto: se empieza de cero en lugar de fallar.
    file = EMPTY;
  }
  cache.set(workspaceRoot, file);
  return file;
}

function persist(workspaceRoot: string, file: VaultFile): void {
  const target = vaultPath(workspaceRoot);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    // Solo el propietario. En Windows manda la ACL heredada de userData.
    mode: 0o600,
  });
  // Escritura atomica: un corte a mitad no deja el almacen a medias.
  renameSync(temporary, target);
  cache.set(workspaceRoot, file);
}

/* -------------------------------------------------------------------------- */
/*  Operaciones                                                                */
/* -------------------------------------------------------------------------- */

/** Claves guardadas, SIN sus valores. */
export function listEntries(workspaceRoot: string): readonly VaultEntry[] {
  const file = load(workspaceRoot);
  return Object.keys(file.secrets)
    .sort()
    .map((key) => ({
      key,
      updatedAt: file.updatedAt[key] ?? 0,
    }));
}

export function hasSecret(workspaceRoot: string, key: string): boolean {
  const stored = load(workspaceRoot).secrets[key];
  return typeof stored === 'string' && stored !== '';
}

/**
 * Guarda un secreto cifrado.
 * Devuelve `false` si el sistema no puede cifrar; en ese caso NO se escribe.
 */
export function setSecret(workspaceRoot: string, key: string, value: string): boolean {
  if (typeof key !== 'string' || key.trim() === '') {
    return false;
  }
  if (!isSecureStorageAvailable()) {
    return false;
  }
  const encrypted = safeStorage.encryptString(value).toString('base64');
  const current = load(workspaceRoot);
  persist(workspaceRoot, {
    version: 1,
    secrets: { ...current.secrets, [key]: encrypted },
    updatedAt: { ...current.updatedAt, [key]: Date.now() },
  });
  return true;
}

export function deleteSecret(workspaceRoot: string, key: string): true {
  const current = load(workspaceRoot);
  if (current.secrets[key] === undefined) {
    return true;
  }
  const secrets = { ...current.secrets };
  const updatedAt = { ...current.updatedAt };
  delete secrets[key];
  delete updatedAt[key];
  persist(workspaceRoot, { version: 1, secrets, updatedAt });
  return true;
}

/**
 * Descifra UN secreto concreto.
 *
 * Solo debe llamarse cuando el usuario lo pide explicitamente, y el valor no
 * debe registrarse en ningun log.
 */
export function getSecret(workspaceRoot: string, key: string): string | null {
  const stored = load(workspaceRoot).secrets[key];
  if (typeof stored !== 'string' || stored === '') {
    return null;
  }
  if (!isSecureStorageAvailable()) {
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // Cifrado con otro usuario o en otra maquina: el valor es irrecuperable,
    // asi que se retira en lugar de dejar basura que siempre fallara.
    deleteSecret(workspaceRoot, key);
    return null;
  }
}

/** Borra el almacen entero de un workspace. */
export function clearVault(workspaceRoot: string): true {
  const target = vaultPath(workspaceRoot);
  if (existsSync(target)) {
    rmSync(target, { force: true });
  }
  cache.delete(workspaceRoot);
  return true;
}

/** Olvida las caches; se llama al cerrar el workspace. */
export function resetVaultCache(): void {
  cache.clear();
}
