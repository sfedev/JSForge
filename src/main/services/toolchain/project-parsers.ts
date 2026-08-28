/**
 * Parsers propios de los archivos de configuracion del proyecto.
 *
 * No se importa `typescript` ni ningun cargador de configuracion: el IDE debe
 * abrir un proyecto ajeno sin ejecutar su codigo. `vite.config.ts` y
 * `next.config.js` se leen con analisis textual acotado, nunca evaluandolos.
 */

import path from 'node:path';

import type {
  DetectedFramework,
  FrameworkId,
  PackageJsonSummary,
  ProjectManifest,
  ScriptEntry,
  TsConfigSummary,
} from '../../../shared/contracts.js';
import { exists, readTextIfExists } from '../fs-service.js';
import { parseJsonTolerant } from './json-tolerant.js';

/* -------------------------------------------------------------------------- */
/*  package.json                                                               */
/* -------------------------------------------------------------------------- */

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

export async function readPackageJson(
  relativePath = 'package.json',
): Promise<{ summary: PackageJsonSummary | null; warnings: string[] }> {
  const text = await readTextIfExists(relativePath);
  if (text === null) {
    return { summary: null, warnings: [] };
  }
  const parsed = parseJsonTolerant<Record<string, unknown>>(text);
  const warnings = [...parsed.warnings];
  if (parsed.error !== undefined) {
    warnings.push(`${relativePath}: ${parsed.error.message}`);
  }
  if (parsed.value === null) {
    return { summary: null, warnings };
  }

  const raw = parsed.value;
  const workspacesRaw = raw['workspaces'];
  let workspaces: string[] | undefined;
  if (Array.isArray(workspacesRaw)) {
    workspaces = workspacesRaw.filter((entry): entry is string => typeof entry === 'string');
  } else if (typeof workspacesRaw === 'object' && workspacesRaw !== null) {
    // Formato de Yarn clasico: { packages: [...] }
    const packages = (workspacesRaw as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      workspaces = packages.filter((entry): entry is string => typeof entry === 'string');
    }
  }

  const type = raw['type'];
  const summary: PackageJsonSummary = {
    path: relativePath,
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
    ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
    ...(typeof raw['packageManager'] === 'string' ? { packageManager: raw['packageManager'] } : {}),
    ...(type === 'module' || type === 'commonjs' ? { type } : {}),
    scripts: asStringRecord(raw['scripts']),
    dependencies: asStringRecord(raw['dependencies']),
    devDependencies: asStringRecord(raw['devDependencies']),
    ...(workspaces === undefined ? {} : { workspaces }),
  };
  return { summary, warnings };
}

/* -------------------------------------------------------------------------- */
/*  tsconfig.json                                                              */
/* -------------------------------------------------------------------------- */

/** Profundidad maxima al seguir `extends`; evita ciclos. */
const MAX_EXTENDS_DEPTH = 8;

export async function readTsConfig(
  relativePath = 'tsconfig.json',
): Promise<{ summary: TsConfigSummary | null; warnings: string[] }> {
  const warnings: string[] = [];
  const merged: Record<string, unknown> = {};
  let current: string | null = relativePath;
  let rootExtends: string | undefined;

  for (let depth = 0; depth < MAX_EXTENDS_DEPTH && current !== null; depth += 1) {
    const text: string | null = await readTextIfExists(current);
    if (text === null) {
      if (depth === 0) {
        return { summary: null, warnings };
      }
      warnings.push(`No se pudo leer el tsconfig heredado: ${current}`);
      break;
    }
    const parsed = parseJsonTolerant<Record<string, unknown>>(text);
    warnings.push(...parsed.warnings.map((warning) => `${current}: ${warning}`));
    if (parsed.error !== undefined) {
      warnings.push(`${current}: ${parsed.error.message}`);
      break;
    }
    const value = parsed.value ?? {};
    const options = value['compilerOptions'];

    // Las opciones del archivo hijo ganan sobre las heredadas.
    if (typeof options === 'object' && options !== null) {
      for (const [key, entry] of Object.entries(options)) {
        if (!(key in merged)) {
          merged[key] = entry;
        }
      }
    }

    const parent = value['extends'];
    if (depth === 0 && typeof parent === 'string') {
      rootExtends = parent;
    }
    if (typeof parent !== 'string') {
      break;
    }
    // Solo se siguen rutas relativas; un `extends` a un paquete de
    // node_modules no se resuelve para no depender del arbol instalado.
    if (!parent.startsWith('.')) {
      warnings.push(`No se resolvio el tsconfig heredado del paquete "${parent}".`);
      break;
    }
    const base = path.posix.dirname(current);
    const candidate = path.posix.normalize(path.posix.join(base, parent));
    current = candidate.endsWith('.json') ? candidate : `${candidate}.json`;
  }

  const pathsRaw = merged['paths'];
  const paths: Record<string, string[]> = {};
  if (typeof pathsRaw === 'object' && pathsRaw !== null) {
    for (const [key, entry] of Object.entries(pathsRaw)) {
      if (Array.isArray(entry)) {
        paths[key] = entry.filter((item): item is string => typeof item === 'string');
      }
    }
  }

  const summary: TsConfigSummary = {
    path: relativePath,
    strict: merged['strict'] === true,
    ...(typeof merged['target'] === 'string' ? { target: merged['target'] } : {}),
    ...(typeof merged['module'] === 'string' ? { module: merged['module'] } : {}),
    ...(typeof merged['jsx'] === 'string' ? { jsx: merged['jsx'] } : {}),
    ...(typeof merged['baseUrl'] === 'string' ? { baseUrl: merged['baseUrl'] } : {}),
    paths,
    ...(rootExtends === undefined ? {} : { extends: rootExtends }),
  };
  return { summary, warnings };
}

/* -------------------------------------------------------------------------- */
/*  Configuraciones de bundler (analisis textual, sin ejecutar)                */
/* -------------------------------------------------------------------------- */

export interface BundlerConfigHints {
  readonly file: string;
  /** Puerto declarado en `server.port` / `devServer.port`, si aparece. */
  readonly port?: number;
  readonly base?: string;
  readonly outDir?: string;
  readonly plugins: readonly string[];
}

const VITE_CONFIG_NAMES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
];
const NEXT_CONFIG_NAMES = ['next.config.ts', 'next.config.js', 'next.config.mjs'];

/**
 * Extrae pistas de una configuracion de bundler leyendo el texto.
 * Es deliberadamente conservador: si no reconoce el patron, no inventa nada.
 */
export function parseBundlerConfig(file: string, source: string): BundlerConfigHints {
  const portMatch = /\bport\s*:\s*(\d{2,5})/.exec(source);
  const baseMatch = /\bbase\s*:\s*['"]([^'"]+)['"]/.exec(source);
  const outDirMatch = /\boutDir\s*:\s*['"]([^'"]+)['"]/.exec(source);

  const plugins: string[] = [];
  const importPattern = /import\s+(?:[\w{},*\s]+\s+from\s+)?['"]([^'"]+)['"]/g;
  let importMatch = importPattern.exec(source);
  while (importMatch !== null) {
    const moduleName = importMatch[1];
    if (moduleName !== undefined && !moduleName.startsWith('.') && moduleName !== 'vite') {
      plugins.push(moduleName);
    }
    importMatch = importPattern.exec(source);
  }

  const port = portMatch?.[1] === undefined ? undefined : Number.parseInt(portMatch[1], 10);
  return {
    file,
    ...(port === undefined || Number.isNaN(port) ? {} : { port }),
    ...(baseMatch?.[1] === undefined ? {} : { base: baseMatch[1] }),
    ...(outDirMatch?.[1] === undefined ? {} : { outDir: outDirMatch[1] }),
    plugins,
  };
}

export async function readBundlerConfig(): Promise<BundlerConfigHints | null> {
  for (const candidate of [...VITE_CONFIG_NAMES, ...NEXT_CONFIG_NAMES]) {
    const source = await readTextIfExists(candidate);
    if (source !== null) {
      return parseBundlerConfig(candidate, source);
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Deteccion de frameworks                                                    */
/* -------------------------------------------------------------------------- */

interface FrameworkRule {
  readonly id: FrameworkId;
  readonly label: string;
  /** Paquetes cuya presencia en dependencias delata el framework. */
  readonly packages: readonly string[];
  /** Archivos cuya existencia tambien lo delata. */
  readonly files?: readonly string[];
}

const FRAMEWORK_RULES: readonly FrameworkRule[] = [
  { id: 'next', label: 'Next.js', packages: ['next'], files: ['next.config.js', 'next.config.ts', 'next.config.mjs'] },
  { id: 'nuxt', label: 'Nuxt', packages: ['nuxt'], files: ['nuxt.config.ts'] },
  { id: 'sveltekit', label: 'SvelteKit', packages: ['@sveltejs/kit'], files: ['svelte.config.js'] },
  { id: 'angular', label: 'Angular', packages: ['@angular/core'], files: ['angular.json'] },
  { id: 'react', label: 'React', packages: ['react'] },
  { id: 'vue', label: 'Vue 3', packages: ['vue'] },
  { id: 'svelte', label: 'Svelte', packages: ['svelte'] },
  { id: 'vite', label: 'Vite', packages: ['vite'], files: VITE_CONFIG_NAMES },
  { id: 'nestjs', label: 'NestJS', packages: ['@nestjs/core'], files: ['nest-cli.json'] },
  { id: 'express', label: 'Express', packages: ['express'] },
  { id: 'fastify', label: 'Fastify', packages: ['fastify'] },
  { id: 'prisma', label: 'Prisma', packages: ['prisma', '@prisma/client'], files: ['prisma/schema.prisma'] },
  { id: 'typeorm', label: 'TypeORM', packages: ['typeorm'] },
  { id: 'drizzle', label: 'Drizzle', packages: ['drizzle-orm'], files: ['drizzle.config.ts'] },
  { id: 'tailwind', label: 'TailwindCSS', packages: ['tailwindcss'], files: ['tailwind.config.js', 'tailwind.config.ts'] },
  { id: 'vitest', label: 'Vitest', packages: ['vitest'], files: ['vitest.config.ts'] },
  { id: 'jest', label: 'Jest', packages: ['jest'], files: ['jest.config.js', 'jest.config.ts'] },
  { id: 'playwright', label: 'Playwright', packages: ['@playwright/test'], files: ['playwright.config.ts'] },
  { id: 'nx', label: 'Nx', packages: ['nx'], files: ['nx.json'] },
  { id: 'turborepo', label: 'Turborepo', packages: ['turbo'], files: ['turbo.json'] },
];

/** Archivos de configuracion que el IDE muestra agrupados en el explorador. */
const KNOWN_CONFIG_FILES: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'dotforge.config.json',
  'dotforge.json',
  '.dotforge',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  'prettier.config.js',
  'biome.json',
  'biome.jsonc',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
  '.env.example',
  'nx.json',
  'turbo.json',
  'angular.json',
  'nest-cli.json',
];

export async function detectFrameworks(
  packageJson: PackageJsonSummary | null,
): Promise<readonly DetectedFramework[]> {
  const dependencies = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  const detected: DetectedFramework[] = [];

  for (const rule of FRAMEWORK_RULES) {
    const packageName = rule.packages.find((name) => dependencies[name] !== undefined);
    if (packageName !== undefined) {
      const version = dependencies[packageName];
      detected.push({
        id: rule.id,
        label: rule.label,
        ...(version === undefined ? {} : { version }),
        evidence: packageJson?.path ?? 'package.json',
      });
      continue;
    }
    for (const file of rule.files ?? []) {
      if (await exists(file)) {
        detected.push({ id: rule.id, label: rule.label, evidence: file });
        break;
      }
    }
  }
  return detected;
}

/* -------------------------------------------------------------------------- */
/*  Manifiesto agregado                                                        */
/* -------------------------------------------------------------------------- */

export async function readProjectManifest(): Promise<ProjectManifest> {
  const [{ summary: packageJson, warnings: pkgWarnings }, { summary: tsconfig, warnings: tsWarnings }] =
    await Promise.all([readPackageJson(), readTsConfig()]);

  const frameworks = await detectFrameworks(packageJson);

  const configFiles: string[] = [];
  await Promise.all(
    KNOWN_CONFIG_FILES.map(async (file) => {
      if (await exists(file)) {
        configFiles.push(file);
      }
    }),
  );
  configFiles.sort();

  return {
    ...(packageJson === null ? {} : { packageJson }),
    ...(tsconfig === null ? {} : { tsconfig }),
    frameworks,
    configFiles,
    warnings: [...pkgWarnings, ...tsWarnings],
  };
}

/** Scripts del paquete raiz y de los paquetes del monorepo. */
export async function readScripts(): Promise<readonly ScriptEntry[]> {
  const { summary } = await readPackageJson();
  const entries: ScriptEntry[] = [];
  if (summary === null) {
    return entries;
  }
  for (const [name, command] of Object.entries(summary.scripts)) {
    entries.push({ name, command });
  }

  // Monorepo: se leen los package.json de los paquetes declarados. Solo se
  // expanden globs de un nivel (`packages/*`), que es el caso habitual.
  for (const pattern of summary.workspaces ?? []) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      entries.push(...(await readWorkspaceScripts(pattern)));
      continue;
    }
    const base = pattern.slice(0, star).replace(/\/$/, '');
    const { readDirectory } = await import('../fs-service.js');
    try {
      const children = await readDirectory(base);
      for (const child of children) {
        if (child.kind === 'directory') {
          entries.push(...(await readWorkspaceScripts(child.path)));
        }
      }
    } catch {
      // El patron puede apuntar a una carpeta que aun no existe.
    }
  }
  return entries;
}

async function readWorkspaceScripts(directory: string): Promise<ScriptEntry[]> {
  const { summary } = await readPackageJson(`${directory}/package.json`);
  if (summary === null) {
    return [];
  }
  return Object.entries(summary.scripts).map(([name, command]) => ({
    name,
    command,
    workspace: summary.name ?? directory,
  }));
}
