/**
 * Almacen de claves API.
 *
 * Las claves se cifran con `safeStorage` de Electron, que delega en DPAPI en
 * Windows, en el Llavero en macOS y en el almacen de secretos del escritorio
 * en Linux. El archivo resultante contiene solo bytes cifrados en base64.
 *
 * Reglas:
 *  - Si el cifrado del sistema no esta disponible, NO se guarda nada en
 *    claro: es preferible pedir la clave cada sesion a dejarla legible.
 *  - Las claves nunca salen del proceso principal: el renderer solo puede
 *    preguntar si existen.
 */

import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { AiProviderId } from '../../../shared/contracts.js';

interface CredentialFile {
  readonly version: 1;
  /** proveedor -> clave cifrada en base64. */
  readonly keys: Record<string, string>;
}

let cache: CredentialFile | null = null;

function credentialsPath(): string {
  return path.join(app.getPath('userData'), 'credentials.json');
}

/** true si el sistema operativo ofrece cifrado utilizable. */
export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function load(): CredentialFile {
  if (cache !== null) {
    return cache;
  }
  try {
    const raw = readFileSync(credentialsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CredentialFile>;
    cache =
      parsed.version === 1 && typeof parsed.keys === 'object' && parsed.keys !== null
        ? { version: 1, keys: { ...parsed.keys } }
        : { version: 1, keys: {} };
  } catch {
    cache = { version: 1, keys: {} };
  }
  return cache;
}

function persist(file: CredentialFile): void {
  const target = credentialsPath();
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    // Solo el propietario puede leer el archivo (ignorado en Windows, donde
    // manda la ACL heredada de userData).
    mode: 0o600,
  });
  renameSync(temporary, target);
  cache = file;
}

export function hasApiKey(provider: AiProviderId): boolean {
  const stored = load().keys[provider];
  return typeof stored === 'string' && stored !== '';
}

/**
 * Guarda una clave cifrada. Devuelve `false` si el sistema no puede cifrar,
 * en cuyo caso NO se escribe nada.
 */
export function setApiKey(provider: AiProviderId, apiKey: string): boolean {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return false;
  }
  if (!isSecureStorageAvailable()) {
    return false;
  }
  const encrypted = safeStorage.encryptString(apiKey.trim()).toString('base64');
  const current = load();
  persist({ version: 1, keys: { ...current.keys, [provider]: encrypted } });
  return true;
}

export function deleteApiKey(provider: AiProviderId): true {
  const current = load();
  if (current.keys[provider] === undefined) {
    return true;
  }
  const keys = { ...current.keys };
  delete keys[provider];
  persist({ version: 1, keys });
  return true;
}

/**
 * Descifra la clave. SOLO debe usarse dentro del proceso principal y al
 * construir la cabecera de autenticacion; el valor no debe registrarse ni
 * devolverse por IPC.
 */
export function getApiKey(provider: AiProviderId): string | null {
  const stored = load().keys[provider];
  if (typeof stored !== 'string' || stored === '') {
    return null;
  }
  if (!isSecureStorageAvailable()) {
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // La clave se cifro con otro usuario o en otra maquina: se descarta.
    deleteApiKey(provider);
    return null;
  }
}

/** Borra el archivo completo; usado en pruebas manuales y al restablecer. */
export function clearAllCredentials(): void {
  const target = credentialsPath();
  if (existsSync(target)) {
    rmSync(target, { force: true });
  }
  cache = { version: 1, keys: {} };
}
