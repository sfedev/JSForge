/**
 * Registro y ejecucion del generador de arquitecturas DotForge.
 *
 * El flujo es siempre el mismo:
 *  1. Se valida la peticion y se resuelve el destino.
 *  2. El blueprint construye el arbol de archivos EN MEMORIA.
 *  3. Se comprueba que el destino este vacio.
 *  4. Se escribe todo de una pasada.
 *
 * Separar la construccion de la escritura es lo que hace posible una
 * ejecucion en seco de verdad y evita dejar carpetas a medio generar.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  forgeError,
  type Blueprint,
  type GenerateRequest,
  type GenerateResult,
  type GeneratedFile,
  type PackageManagerId,
} from '../../../../shared/contracts.js';
import { isInside, resolveWorkspaceRoot } from '../../../security/workspace-guard.js';
import { BACKEND_BLUEPRINTS } from './backend.js';
import { FRONTEND_BLUEPRINTS, FULLSTACK_NEXT } from './frontend.js';
import { MONOREPO_BLUEPRINTS } from './monorepo.js';
import { createContext, type BlueprintDefinition, type FileMap } from './types.js';

const BLUEPRINTS: readonly BlueprintDefinition[] = [
  ...FRONTEND_BLUEPRINTS,
  ...BACKEND_BLUEPRINTS,
  FULLSTACK_NEXT,
  ...MONOREPO_BLUEPRINTS,
];

const VALID_MANAGERS: readonly PackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** Archivos que no impiden generar en una carpeta ya existente. */
const HARMLESS_ENTRIES = new Set(['.git', '.gitkeep', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

/** Catalogo publico, sin las funciones de construccion. */
export function listBlueprints(): readonly Blueprint[] {
  return BLUEPRINTS.map((blueprint) => ({
    id: blueprint.id,
    label: blueprint.label,
    category: blueprint.category,
    description: blueprint.description,
    tags: blueprint.tags,
    options: blueprint.options,
  }));
}

export function findBlueprint(id: string): BlueprintDefinition | undefined {
  return BLUEPRINTS.find((blueprint) => blueprint.id === id);
}

/* -------------------------------------------------------------------------- */
/*  Validacion                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * El destino del scaffolding es la unica ruta absoluta que acepta el IDE,
 * porque por definicion cae fuera del workspace abierto. Aun asi se
 * comprueba que sea una ruta plausible y que no apunte a una raiz.
 */
function resolveTarget(targetDir: string): string {
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'No se indico el directorio destino.');
  }
  if (!path.isAbsolute(targetDir)) {
    failure('E_INVALID_ARGUMENT', 'El directorio destino debe ser una ruta absoluta.');
  }
  const resolved = path.resolve(targetDir);
  const parent = path.dirname(resolved);
  if (parent === resolved) {
    failure('E_INVALID_ARGUMENT', 'No se puede generar un proyecto en la raiz del volumen.');
  }
  return resolved;
}

/** Comprueba que el destino no exista o este practicamente vacio. */
async function assertEmptyTarget(target: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw cause;
  }
  const blocking = entries.filter((entry) => !HARMLESS_ENTRIES.has(entry));
  if (blocking.length > 0) {
    failure(
      'E_ALREADY_EXISTS',
      'El directorio destino no esta vacio.',
      `Contiene ${blocking.length} elementos, entre ellos "${blocking[0] ?? ''}".`,
    );
  }
}

/** Ninguna ruta generada puede escapar del destino. */
function assertSafePaths(files: FileMap, target: string): void {
  for (const relative of files.keys()) {
    if (relative.includes('\0') || path.isAbsolute(relative)) {
      failure('E_INVALID_ARGUMENT', `Ruta generada no valida: ${relative}`);
    }
    const absolute = path.resolve(target, relative);
    if (!isInside(target, absolute)) {
      failure('E_INVALID_ARGUMENT', `La plantilla intenta escribir fuera del destino: ${relative}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Ejecucion                                                                  */
/* -------------------------------------------------------------------------- */

export async function generate(request: GenerateRequest): Promise<GenerateResult> {
  const blueprint = findBlueprint(request?.blueprintId ?? '');
  if (blueprint === undefined) {
    failure('E_NOT_FOUND', `Blueprint desconocido: ${String(request?.blueprintId)}`);
  }
  if (typeof request.projectName !== 'string' || request.projectName.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'El nombre del proyecto esta vacio.');
  }
  const packageManager = VALID_MANAGERS.includes(request.packageManager)
    ? request.packageManager
    : 'npm';

  const target = resolveTarget(request.targetDir);

  // Los valores por defecto del blueprint se aplican aqui, no en la interfaz:
  // asi el asistente visual y la CLI generan exactamente lo mismo cuando el
  // llamante no especifica una opcion.
  const defaults: Record<string, string | boolean> = {};
  for (const option of blueprint.options) {
    defaults[option.id] = option.default;
  }
  const context = createContext({
    ...request,
    packageManager,
    options: { ...defaults, ...(request.options ?? {}) },
  });

  const files = blueprint.build(context);
  assertSafePaths(files, target);

  const generated: GeneratedFile[] = [...files.entries()]
    .map(([relative, content]) => ({
      path: relative,
      bytes: Buffer.byteLength(content, 'utf8'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const dryRun = request.dryRun === true;
  if (!dryRun) {
    await assertEmptyTarget(target);
    // La raiz se crea con `recursive` por si el padre tampoco existe.
    await fs.mkdir(target, { recursive: true });

    for (const [relative, content] of files) {
      const absolute = path.resolve(target, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, 'utf8');
    }
  }

  return {
    targetDir: resolveWorkspaceRoot(target),
    blueprintId: blueprint.id,
    files: generated,
    nextSteps: blueprint.nextSteps(context),
    dryRun,
  };
}

/**
 * Entrada equivalente para la CLI (`--json`): recibe la peticion serializada
 * y devuelve el resultado como JSON, sin tocar la interfaz.
 */
export async function generateFromJson(payload: string): Promise<string> {
  let request: GenerateRequest;
  try {
    request = JSON.parse(payload) as GenerateRequest;
  } catch (cause) {
    failure(
      'E_PARSE',
      'La peticion de generacion no es JSON valido.',
      cause instanceof Error ? cause.message : undefined,
    );
  }
  return `${JSON.stringify(await generate(request), null, 2)}\n`;
}
