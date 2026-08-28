/**
 * Preferencias persistentes del IDE.
 *
 * Se guardan en `userData/settings.json` con escritura atomica (fichero
 * temporal + rename) para que un cierre abrupto no deje el archivo truncado.
 * La lectura es tolerante: cualquier clave desconocida o de tipo incorrecto
 * se descarta y se sustituye por el valor por defecto.
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_SETTINGS, type ForgeSettings } from '../../shared/contracts.js';

const MAX_RECENT = 12;

let cached: ForgeSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString<K extends keyof ForgeSettings>(
  raw: Record<string, unknown>,
  key: K,
  allowed?: readonly string[],
): Partial<ForgeSettings> {
  const value = raw[key as string];
  if (typeof value !== 'string') {
    return {};
  }
  if (allowed !== undefined && !allowed.includes(value)) {
    return {};
  }
  return { [key]: value } as Partial<ForgeSettings>;
}

function pickBoolean<K extends keyof ForgeSettings>(
  raw: Record<string, unknown>,
  key: K,
): Partial<ForgeSettings> {
  const value = raw[key as string];
  return typeof value === 'boolean' ? ({ [key]: value } as Partial<ForgeSettings>) : {};
}

function pickNumber<K extends keyof ForgeSettings>(
  raw: Record<string, unknown>,
  key: K,
  min: number,
  max: number,
): Partial<ForgeSettings> {
  const value = raw[key as string];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {};
  }
  const clamped = Math.min(max, Math.max(min, Math.round(value)));
  return { [key]: clamped } as Partial<ForgeSettings>;
}

/** Valida un objeto arbitrario contra la forma de `ForgeSettings`. */
export function sanitizeSettings(raw: unknown): Partial<ForgeSettings> {
  if (!isPlainObject(raw)) {
    return {};
  }
  const recentRaw = raw['recentWorkspaces'];
  const recent = Array.isArray(recentRaw)
    ? recentRaw.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT)
    : undefined;

  return {
    ...pickString(raw, 'theme', ['forge-dark', 'forge-light', 'forge-high-contrast']),
    ...pickString(raw, 'fontFamily'),
    ...pickNumber(raw, 'fontSize', 8, 40),
    ...pickNumber(raw, 'tabSize', 1, 8),
    ...pickBoolean(raw, 'formatOnSave'),
    ...pickString(raw, 'formatter', ['prettier', 'biome', 'none']),
    ...pickBoolean(raw, 'minimap'),
    ...pickBoolean(raw, 'wordWrap'),
    ...pickBoolean(raw, 'semanticHighlighting'),
    ...pickString(raw, 'updateChannel', ['stable', 'beta', 'nightly']),
    ...pickBoolean(raw, 'autoInstallUpdates'),
    ...pickBoolean(raw, 'aiEnabled'),
    ...pickString(raw, 'aiProvider', ['anthropic', 'openai', 'ollama']),
    ...pickString(raw, 'aiModel'),
    ...pickString(raw, 'terminalProfile'),
    ...pickNumber(raw, 'logThrottleMs', 50, 5000),
    ...(recent === undefined ? {} : { recentWorkspaces: recent }),
  };
}

export function getSettings(): ForgeSettings {
  if (cached !== null) {
    return cached;
  }
  let parsed: unknown = null;
  try {
    const text = readFileSync(settingsPath(), 'utf8').replace(/^\uFEFF/, '');
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  cached = { ...DEFAULT_SETTINGS, ...sanitizeSettings(parsed) };
  return cached;
}

export function setSettings(patch: unknown): ForgeSettings {
  const next: ForgeSettings = { ...getSettings(), ...sanitizeSettings(patch) };
  cached = next;
  persist(next);
  return next;
}

/** Anade un workspace al historial reciente, sin duplicados y acotado. */
export function pushRecentWorkspace(absolutePath: string): ForgeSettings {
  const current = getSettings();
  const deduped = [
    absolutePath,
    ...current.recentWorkspaces.filter((entry) => entry !== absolutePath),
  ].slice(0, MAX_RECENT);
  return setSettings({ recentWorkspaces: deduped });
}

function persist(settings: ForgeSettings): void {
  const target = settingsPath();
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
  } catch (cause) {
    console.error('[forge] no se pudieron guardar las preferencias', cause);
  }
}

/** Solo para pruebas: descarta la cache en memoria. */
export function resetSettingsCache(): void {
  cached = null;
}
