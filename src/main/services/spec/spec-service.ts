/**
 * Servicio de especificaciones: descubrimiento, lectura, generacion de
 * codigo y auditoria de contratos.
 *
 * Es la capa que toca disco y Git. Toda la logica de analisis vive en
 * modulos puros al lado (`openapi-parser`, `codegen`, `ts-shape`,
 * `contract-audit`), de modo que aqui solo queda la fontaneria: rutas por el
 * guardian, lectura de archivos y composicion del informe.
 */

import {
  forgeError,
  type ContractAuditReport,
  type OpenApiDocumentView,
  type SpecGenerateRequest,
  type SpecGenerateResult,
} from '../../../shared/contracts.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { requireWorkspaceRoot } from '../workspace-service.js';
import { exists, findFilesByName, readTextIfExists, writeFile } from '../fs-service.js';
import { fileAtRevision } from '../git/git-service.js';
import { parseOpenApi } from './openapi-parser.js';
import { defaultOutputPath, generate, narrowDocument } from './codegen.js';
import { affectedSymbols, buildReport, compareModules, findDependents } from './contract-audit.js';

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

/** Nombres habituales de una especificacion en la raiz de un proyecto. */
const SPEC_NAMES = [
  'openapi.json',
  'openapi.yaml',
  'openapi.yml',
  'swagger.json',
  'swagger.yaml',
  'swagger.yml',
  'api.json',
  'api.yaml',
];

/** Cota de archivos inspeccionados al auditar; mas seria ruido y lentitud. */
const MAX_AUDIT_FILES = 600;

/* -------------------------------------------------------------------------- */
/*  Descubrimiento                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Busca especificaciones en el workspace.
 *
 * Primero los nombres canonicos en la raiz y en las carpetas habituales;
 * despues, cualquier archivo cuyo nombre contenga «openapi» o «swagger». El
 * orden importa: lo que el usuario espera ver primero es el `openapi.yaml`
 * de la raiz, no uno enterrado en `docs/`.
 */
export async function discoverSpecs(): Promise<readonly string[]> {
  requireWorkspaceRoot();
  const found: string[] = [];

  for (const name of SPEC_NAMES) {
    for (const prefix of ['', 'docs/', 'api/', 'spec/', 'openapi/']) {
      const candidate = `${prefix}${name}`;
      if (await exists(candidate)) {
        found.push(candidate);
      }
    }
  }

  for (const query of ['openapi', 'swagger']) {
    for (const path of await findFilesByName(query, 60)) {
      if (/\.(json|ya?ml)$/i.test(path) && !found.includes(path)) {
        found.push(path);
      }
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/*  Lectura                                                                    */
/* -------------------------------------------------------------------------- */

export async function readSpec(relativePath: string): Promise<OpenApiDocumentView> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, relativePath);
  const source = await readTextIfExists(guarded.relative);
  if (source === null) {
    failure('E_NOT_FOUND', `No se encontro la especificacion "${guarded.relative}".`);
  }
  return parseOpenApi(guarded.relative, source);
}

/* -------------------------------------------------------------------------- */
/*  Generacion                                                                 */
/* -------------------------------------------------------------------------- */

export async function generateFromSpec(
  request: SpecGenerateRequest,
): Promise<SpecGenerateResult> {
  const document = await readSpec(request.specPath);
  const narrowed = narrowDocument(document, request.operationIds);
  const content = generate(narrowed, request.target);

  const target = request.outputPath ?? defaultOutputPath(request.specPath, request.target);
  const root = requireWorkspaceRoot();
  // Aunque la ruta la proponga el IDE, pasa por el guardian: el renderer
  // puede haberla cambiado en el dialogo.
  const guarded = assertInsideWorkspace(root, target);

  if (request.write !== true) {
    return { path: guarded.relative, content, written: false };
  }

  await writeFile({ path: guarded.relative, content });
  return { path: guarded.relative, content, written: true };
}

/* -------------------------------------------------------------------------- */
/*  Auditoria de contratos                                                     */
/* -------------------------------------------------------------------------- */

/** Modulos compartidos que tiene sentido auditar. */
export async function auditTargets(): Promise<readonly string[]> {
  requireWorkspaceRoot();
  // El filtro por nombre viaja al recorrido: acotar despues gastaria el
  // limite en archivos que ni siquiera son candidatos.
  const candidates = await findFilesByName('src/shared/', MAX_AUDIT_FILES);
  return candidates
    .filter((path) => path.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Compara un modulo compartido con su version en Git y lista quien lo
 * consume.
 *
 * La referencia por defecto es `HEAD`: lo que ya esta comprometido es lo que
 * el resto del equipo consume, y por tanto lo que se puede romper.
 */
export async function auditContract(
  relativePath: string,
  revision = 'HEAD',
): Promise<ContractAuditReport> {
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, relativePath);

  const current = await readTextIfExists(guarded.relative);
  if (current === null) {
    failure('E_NOT_FOUND', `No se encontro el modulo "${guarded.relative}".`);
  }

  const previous = await fileAtRevision(revision, guarded.relative);
  if (previous === null) {
    // Un archivo que aun no esta en Git no puede romper a nadie todavia.
    return buildReport(guarded.relative, revision, [], []);
  }

  const changes = compareModules(previous, current);
  if (changes.length === 0) {
    return buildReport(guarded.relative, revision, [], []);
  }

  // La pista del modulo es su nombre sin extension: `contracts` casa con
  // cualquier `from '../../shared/contracts.js'`.
  const fileName = guarded.relative.split('/').pop() ?? guarded.relative;
  const moduleHint = fileName.replace(/\.ts$/, '');

  const sources: { path: string; source: string }[] = [];
  for (const path of await findFilesByName('.ts', MAX_AUDIT_FILES)) {
    if (!path.endsWith('.ts') || path === guarded.relative) {
      continue;
    }
    const source = await readTextIfExists(path);
    if (source !== null) {
      sources.push({ path, source });
    }
  }

  const dependents = findDependents(sources, moduleHint, affectedSymbols(changes));
  return buildReport(guarded.relative, revision, changes, dependents);
}
