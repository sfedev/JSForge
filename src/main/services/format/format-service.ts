/**
 * Formateo de documentos.
 *
 * Prioridad:
 *  1. El formateador que aporte un plugin para ese lenguaje, si lo hay:
 *     el proyecto sabe mejor que el IDE como formatear lo suyo.
 *  2. Biome, si el proyecto lo declara (`biome.json`) y el binario existe.
 *  3. Prettier del propio proyecto (`node_modules/prettier`), para respetar
 *     su version y sus plugins.
 *  4. Prettier embebido en el IDE.
 *
 * La configuracion siempre se resuelve desde el archivo abierto, de modo que
 * un monorepo con varios `.prettierrc` formatea cada paquete con el suyo.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { FormatRequest, FormatResponse, FormatterId } from '../../../shared/contracts.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { exists } from '../fs-service.js';
import { requireWorkspaceRoot } from '../workspace-service.js';
import { formatterFor } from '../plugins/plugin-service.js';

const run = promisify(execFile);

const FORMAT_TIMEOUT_MS = 15_000;

/** Analizador de Prettier por lenguaje de Monaco. */
const PRETTIER_PARSERS: Readonly<Record<string, string>> = {
  typescript: 'typescript',
  javascript: 'babel',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  markdown: 'markdown',
  yaml: 'yaml',
  graphql: 'graphql',
  dotforge: 'json',
};

/* -------------------------------------------------------------------------- */
/*  Resolucion de formateadores                                                */
/* -------------------------------------------------------------------------- */

function workspaceBin(binary: string): string | null {
  const root = requireWorkspaceRoot();
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const suffix of suffixes) {
    const candidate = path.join(root, 'node_modules', '.bin', `${binary}${suffix}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function hasBiomeConfig(): Promise<boolean> {
  return (await exists('biome.json')) || (await exists('biome.jsonc'));
}

/** Carga el Prettier del proyecto; si no lo hay, el del IDE. */
async function loadPrettier(): Promise<PrettierModule | null> {
  const root = requireWorkspaceRoot();
  const local = path.join(root, 'node_modules', 'prettier', 'index.cjs');
  const localMjs = path.join(root, 'node_modules', 'prettier', 'index.mjs');

  for (const candidate of [local, localMjs]) {
    if (existsSync(candidate)) {
      try {
        return (await import(/* webpackIgnore: true */ candidate)) as PrettierModule;
      } catch {
        // Version incompatible: se cae al Prettier del IDE.
      }
    }
  }
  try {
    return (await import('prettier')) as unknown as PrettierModule;
  } catch {
    return null;
  }
}

interface PrettierOptions {
  parser?: string;
  filepath?: string;
  [key: string]: unknown;
}

interface PrettierModule {
  format(source: string, options: PrettierOptions): Promise<string> | string;
  resolveConfig?(filePath: string, options?: { editorconfig?: boolean }): Promise<unknown>;
}

/* -------------------------------------------------------------------------- */
/*  Entrada publica                                                            */
/* -------------------------------------------------------------------------- */

export async function formatDocument(
  request: FormatRequest,
  preferred: FormatterId,
): Promise<FormatResponse> {
  if (preferred === 'none') {
    return { formatter: 'none', content: request.content, changed: false };
  }
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, request.path);

  // Un plugin del proyecto tiene prioridad: si alguien declaro como
  // formatear SQL o Terraform, el IDE no tiene nada mejor que ofrecer.
  const pluginFormatted = await formatWithPlugin(guarded.absolute, request);
  if (pluginFormatted !== null) {
    return {
      formatter: 'plugin',
      content: pluginFormatted,
      changed: pluginFormatted !== request.content,
    };
  }

  const wantsBiome = preferred === 'biome' || (await hasBiomeConfig());
  if (wantsBiome) {
    const formatted = await formatWithBiome(guarded.absolute, request.content);
    if (formatted !== null) {
      return {
        formatter: 'biome',
        content: formatted,
        changed: formatted !== request.content,
      };
    }
  }

  const formatted = await formatWithPrettier(guarded.absolute, request);
  if (formatted !== null) {
    return {
      formatter: 'prettier',
      content: formatted,
      changed: formatted !== request.content,
    };
  }

  // Sin formateador disponible: se devuelve el contenido intacto en lugar de
  // fallar, para que "formatear al guardar" no impida guardar.
  return { formatter: 'none', content: request.content, changed: false };
}

/* -------------------------------------------------------------------------- */
/*  Formateador aportado por un plugin                                         */
/* -------------------------------------------------------------------------- */

/**
 * Formatea con el binario que declare un plugin para ese lenguaje.
 *
 * El contenido se pasa por entrada estandar salvo que los argumentos
 * incluyan `$FILE`, en cuyo caso el formateador edita el archivo en disco y
 * hay que releerlo. Sin `shell`: el comando lo declara el manifiesto y no se
 * interpola en ninguna cadena.
 *
 * Devuelve `null` ante cualquier fallo, para que el resto de la cadena de
 * formateo siga funcionando y "formatear al guardar" no impida guardar.
 */
async function formatWithPlugin(
  absolutePath: string,
  request: FormatRequest,
): Promise<string | null> {
  const formatter = formatterFor(request.languageId);
  if (formatter === null) {
    return null;
  }
  const root = requireWorkspaceRoot();
  const args = formatter.args.map((arg) => (arg === '$FILE' ? absolutePath : arg));

  try {
    if (formatter.usesStdin) {
      const child = run(formatter.command, args, {
        cwd: root,
        timeout: FORMAT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      child.child.stdin?.end(request.content);
      const { stdout } = await child;
      const text = String(stdout);
      // Un formateador que no escribe nada no ha formateado nada.
      return text === '' ? null : text;
    }

    await run(formatter.command, args, {
      cwd: root,
      timeout: FORMAT_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
    });
    // Con `$FILE` el formateador edito el archivo: hay que releerlo.
    const { readFile } = await import('node:fs/promises');
    return await readFile(absolutePath, 'utf8');
  } catch {
    // Binario ausente, error de sintaxis o plazo agotado.
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Biome                                                                      */
/* -------------------------------------------------------------------------- */

async function formatWithBiome(absolutePath: string, content: string): Promise<string | null> {
  const binary = workspaceBin('biome');
  if (binary === null) {
    return null;
  }
  try {
    const child = run(binary, ['format', '--stdin-file-path', absolutePath], {
      cwd: requireWorkspaceRoot(),
      timeout: FORMAT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    child.child.stdin?.end(content);
    const { stdout } = await child;
    const output = String(stdout);
    return output === '' ? null : output;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Prettier                                                                   */
/* -------------------------------------------------------------------------- */

async function formatWithPrettier(
  absolutePath: string,
  request: FormatRequest,
): Promise<string | null> {
  const prettier = await loadPrettier();
  if (prettier === null) {
    return null;
  }

  let config: Record<string, unknown> = {};
  try {
    const resolved = await prettier.resolveConfig?.(absolutePath, { editorconfig: true });
    if (typeof resolved === 'object' && resolved !== null) {
      config = resolved as Record<string, unknown>;
    }
  } catch {
    // Un `.prettierrc` invalido no debe impedir formatear con los valores
    // por defecto.
  }

  const parser = PRETTIER_PARSERS[request.languageId];
  try {
    const output = await prettier.format(request.content, {
      ...config,
      filepath: absolutePath,
      ...(parser === undefined ? {} : { parser }),
    });
    return typeof output === 'string' ? output : null;
  } catch {
    // Codigo con errores de sintaxis: Prettier lanza. No es un fallo del IDE.
    return null;
  }
}
