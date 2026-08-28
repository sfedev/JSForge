/**
 * Lectura, validacion, sincronizacion y escritura del manifiesto DotForge.
 *
 * El parser es tolerante por diseno: un manifiesto con una clave desconocida
 * o un tipo raro produce avisos, no un fallo. Un IDE que se niega a abrir un
 * proyecto por una coma de mas no sirve para nada.
 *
 * Cuando no hay manifiesto, se deriva uno en memoria a partir de package.json
 * y de los frameworks detectados, de modo que el gestor de pipelines funcione
 * desde el primer segundo sin obligar a crear archivos.
 */

import {
  DOTFORGE_MANIFEST_NAMES,
  DOTFORGE_SCHEMA_VERSION,
  type DotForgeConfig,
  type DotForgeEnvironment,
  type DotForgeManifest,
  type DotForgePipeline,
  type DotForgeService,
  type DotForgeServiceKind,
  type DotForgeTask,
  type LogFormat,
  type PackageManagerId,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { exists, readTextIfExists, writeFile } from '../fs-service.js';
import { parseJsonTolerant } from '../toolchain/json-tolerant.js';
import { parseDeclaredManager } from '../toolchain/package-manager.js';
import { readPackageJson, detectFrameworks } from '../toolchain/project-parsers.js';

const LOG_FORMATS: readonly LogFormat[] = [
  'auto',
  'plain',
  'pino',
  'winston',
  'bunyan',
  'morgan',
  'dotforge',
];

const SERVICE_KINDS: readonly DotForgeServiceKind[] = [
  'postgres',
  'mysql',
  'mongo',
  'redis',
  'mailhog',
  'other',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback?: string): string | undefined {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

function port(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    return undefined;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/*  Normalizacion tolerante                                                    */
/* -------------------------------------------------------------------------- */

function normalizeTask(id: string, raw: unknown, warnings: string[]): DotForgeTask | null {
  if (typeof raw === 'string') {
    // Forma abreviada: `"dev": "next dev"`.
    return { command: raw };
  }
  if (!isRecord(raw)) {
    warnings.push(`La tarea "${id}" se ignoro: se esperaba un objeto o una cadena.`);
    return null;
  }
  const command = stringOr(raw['command']);
  const script = stringOr(raw['script']);
  if (command === undefined && script === undefined) {
    warnings.push(`La tarea "${id}" no declara ni "command" ni "script".`);
    return null;
  }
  const logFormat = stringOr(raw['logFormat']);
  const declaredPort = port(raw['port']);

  return {
    ...(stringOr(raw['label']) === undefined ? {} : { label: stringOr(raw['label']) as string }),
    ...(command === undefined ? {} : { command }),
    ...(script === undefined ? {} : { script }),
    ...(stringArray(raw['args']) === undefined ? {} : { args: stringArray(raw['args']) as string[] }),
    ...(stringOr(raw['cwd']) === undefined ? {} : { cwd: stringOr(raw['cwd']) as string }),
    ...(stringRecord(raw['env']) === undefined ? {} : { env: stringRecord(raw['env']) }),
    ...(declaredPort === undefined ? {} : { port: declaredPort }),
    ...(stringOr(raw['readyPattern']) === undefined
      ? {}
      : { readyPattern: stringOr(raw['readyPattern']) as string }),
    ...(logFormat !== undefined && LOG_FORMATS.includes(logFormat as LogFormat)
      ? { logFormat: logFormat as LogFormat }
      : {}),
    ...(typeof raw['watch'] === 'boolean' ? { watch: raw['watch'] } : {}),
  };
}

function normalizePipeline(id: string, raw: unknown, warnings: string[]): DotForgePipeline | null {
  if (Array.isArray(raw)) {
    // Forma abreviada: `"dev": ["web", "api"]`.
    const tasks = stringArray(raw) ?? [];
    return tasks.length === 0 ? null : { tasks, parallel: true };
  }
  if (!isRecord(raw)) {
    warnings.push(`El pipeline "${id}" se ignoro: se esperaba un objeto o una lista.`);
    return null;
  }
  const tasks = stringArray(raw['tasks']);
  if (tasks === undefined || tasks.length === 0) {
    warnings.push(`El pipeline "${id}" no declara tareas.`);
    return null;
  }
  return {
    ...(stringOr(raw['label']) === undefined ? {} : { label: stringOr(raw['label']) as string }),
    ...(stringOr(raw['description']) === undefined
      ? {}
      : { description: stringOr(raw['description']) as string }),
    tasks,
    parallel: raw['parallel'] !== false,
    ...(stringOr(raw['environment']) === undefined
      ? {}
      : { environment: stringOr(raw['environment']) as string }),
    ...(typeof raw['stopOnError'] === 'boolean' ? { stopOnError: raw['stopOnError'] } : {}),
  };
}

function normalizeEnvironment(id: string, raw: unknown, warnings: string[]): DotForgeEnvironment | null {
  if (!isRecord(raw)) {
    warnings.push(`El entorno "${id}" se ignoro: se esperaba un objeto.`);
    return null;
  }
  return {
    ...(stringOr(raw['label']) === undefined ? {} : { label: stringOr(raw['label']) as string }),
    ...(stringArray(raw['envFiles']) === undefined
      ? {}
      : { envFiles: stringArray(raw['envFiles']) as string[] }),
    ...(stringRecord(raw['variables']) === undefined
      ? {}
      : { variables: stringRecord(raw['variables']) }),
    ...(stringArray(raw['secrets']) === undefined
      ? {}
      : { secrets: stringArray(raw['secrets']) as string[] }),
  };
}

function normalizeService(raw: unknown, warnings: string[]): DotForgeService | null {
  if (!isRecord(raw)) {
    warnings.push('Se ignoro un servicio: se esperaba un objeto.');
    return null;
  }
  const name = stringOr(raw['name']);
  const kind = stringOr(raw['kind']);
  if (name === undefined) {
    warnings.push('Se ignoro un servicio sin nombre.');
    return null;
  }
  const servicePort = port(raw['port']);
  return {
    name,
    kind: SERVICE_KINDS.includes(kind as DotForgeServiceKind) ? (kind as DotForgeServiceKind) : 'other',
    ...(stringOr(raw['composeFile']) === undefined
      ? {}
      : { composeFile: stringOr(raw['composeFile']) as string }),
    ...(stringOr(raw['composeService']) === undefined
      ? {}
      : { composeService: stringOr(raw['composeService']) as string }),
    ...(servicePort === undefined ? {} : { port: servicePort }),
    ...(stringOr(raw['url']) === undefined ? {} : { url: stringOr(raw['url']) as string }),
  };
}

/** Convierte un objeto arbitrario en una `DotForgeConfig` valida. */
export function normalizeConfig(raw: unknown, fallbackName: string): {
  config: DotForgeConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    warnings.push('El manifiesto no es un objeto; se uso una configuracion vacia.');
    return { config: { name: fallbackName, $schemaVersion: DOTFORGE_SCHEMA_VERSION }, warnings };
  }

  const tasks: Record<string, DotForgeTask> = {};
  if (isRecord(raw['tasks'])) {
    for (const [id, entry] of Object.entries(raw['tasks'])) {
      const task = normalizeTask(id, entry, warnings);
      if (task !== null) {
        tasks[id] = task;
      }
    }
  } else if (raw['tasks'] !== undefined) {
    warnings.push('"tasks" debe ser un objeto; se ignoro.');
  }

  const pipelines: Record<string, DotForgePipeline> = {};
  if (isRecord(raw['pipelines'])) {
    for (const [id, entry] of Object.entries(raw['pipelines'])) {
      const pipeline = normalizePipeline(id, entry, warnings);
      if (pipeline !== null) {
        // Un pipeline que referencia tareas inexistentes se acepta pero avisa.
        for (const taskId of pipeline.tasks) {
          if (tasks[taskId] === undefined) {
            warnings.push(`El pipeline "${id}" referencia la tarea desconocida "${taskId}".`);
          }
        }
        pipelines[id] = pipeline;
      }
    }
  }

  const environments: Record<string, DotForgeEnvironment> = {};
  if (isRecord(raw['environments'])) {
    for (const [id, entry] of Object.entries(raw['environments'])) {
      const environment = normalizeEnvironment(id, entry, warnings);
      if (environment !== null) {
        environments[id] = environment;
      }
    }
  }

  const services: DotForgeService[] = [];
  if (Array.isArray(raw['services'])) {
    for (const entry of raw['services']) {
      const service = normalizeService(entry, warnings);
      if (service !== null) {
        services.push(service);
      }
    }
  }

  const runtime = stringOr(raw['runtime']);
  const manager = parseDeclaredManager(stringOr(raw['packageManager']));
  const aiRaw = isRecord(raw['ai']) ? raw['ai'] : undefined;

  const config: DotForgeConfig = {
    $schemaVersion: stringOr(raw['$schemaVersion'], DOTFORGE_SCHEMA_VERSION),
    name: stringOr(raw['name'], fallbackName) ?? fallbackName,
    ...(stringOr(raw['version']) === undefined ? {} : { version: stringOr(raw['version']) as string }),
    ...(stringOr(raw['description']) === undefined
      ? {}
      : { description: stringOr(raw['description']) as string }),
    ...(runtime === 'node' || runtime === 'bun' || runtime === 'deno' ? { runtime } : {}),
    ...(manager === null ? {} : { packageManager: manager }),
    ...(stringOr(raw['preset']) === undefined ? {} : { preset: stringOr(raw['preset']) as string }),
    ...(stringArray(raw['workspaces']) === undefined
      ? {}
      : { workspaces: stringArray(raw['workspaces']) as string[] }),
    ...(Object.keys(tasks).length === 0 ? {} : { tasks }),
    ...(Object.keys(pipelines).length === 0 ? {} : { pipelines }),
    ...(Object.keys(environments).length === 0 ? {} : { environments }),
    ...(services.length === 0 ? {} : { services }),
    ...(aiRaw === undefined
      ? {}
      : {
          ai: {
            ...(stringOr(aiRaw['provider']) === undefined
              ? {}
              : { provider: aiRaw['provider'] as 'anthropic' | 'openai' | 'ollama' }),
            ...(stringOr(aiRaw['model']) === undefined
              ? {}
              : { model: stringOr(aiRaw['model']) as string }),
            ...(stringArray(aiRaw['excludeFromContext']) === undefined
              ? {}
              : { excludeFromContext: stringArray(aiRaw['excludeFromContext']) as string[] }),
          },
        }),
  };

  // Claves desconocidas: no se pierden en silencio.
  const known = new Set([
    '$schema', '$schemaVersion', 'name', 'version', 'description', 'runtime',
    'packageManager', 'preset', 'workspaces', 'tasks', 'pipelines',
    'environments', 'services', 'ai',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      warnings.push(`Clave desconocida en el manifiesto: "${key}".`);
    }
  }

  return { config, warnings };
}

/* -------------------------------------------------------------------------- */
/*  Lectura                                                                    */
/* -------------------------------------------------------------------------- */

let cached: DotForgeManifest | null = null;

export function invalidateDotForgeCache(): void {
  cached = null;
}

export async function readManifest(force = false): Promise<DotForgeManifest> {
  if (cached !== null && !force) {
    return cached;
  }

  for (const name of DOTFORGE_MANIFEST_NAMES) {
    const text = await readTextIfExists(name);
    if (text === null) {
      continue;
    }
    const parsed = parseJsonTolerant<unknown>(text);
    const warnings = [...parsed.warnings];
    if (parsed.error !== undefined) {
      warnings.push(`${name}:${parsed.error.line}:${parsed.error.column} — ${parsed.error.message}`);
    }
    const { config, warnings: normalizationWarnings } = normalizeConfig(
      parsed.value ?? {},
      await inferProjectName(),
    );
    cached = {
      found: true,
      path: name,
      config,
      warnings: [...warnings, ...normalizationWarnings],
      inferred: false,
    };
    return cached;
  }

  cached = await inferManifest();
  return cached;
}

async function inferProjectName(): Promise<string> {
  const { summary } = await readPackageJson();
  return summary?.name ?? 'proyecto';
}

/* -------------------------------------------------------------------------- */
/*  Inferencia (proyecto sin manifiesto)                                       */
/* -------------------------------------------------------------------------- */

/** Puertos por defecto de los andamios habituales del ecosistema. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  next: 3000,
  nuxt: 3000,
  vite: 5173,
  angular: 4200,
  sveltekit: 5173,
  nestjs: 3000,
  express: 3000,
  fastify: 3000,
};

/** Patrones que marcan "servidor listo" en la salida de cada framework. */
const READY_PATTERNS: Readonly<Record<string, string>> = {
  next: 'Ready in|started server on|Local:',
  vite: 'ready in|Local:',
  angular: 'Compiled successfully|Application bundle generation complete',
  nestjs: 'Nest application successfully started',
  express: 'listening on|Server running',
  fastify: 'Server listening at',
};

/**
 * Deriva un manifiesto util a partir de package.json: cada script se convierte
 * en tarea, y los scripts de desarrollo se agrupan en un pipeline "dev".
 */
export async function inferManifest(): Promise<DotForgeManifest> {
  const { summary, warnings } = await readPackageJson();
  const frameworks = await detectFrameworks(summary);
  const frameworkIds = new Set(frameworks.map((framework) => framework.id));

  const tasks: Record<string, DotForgeTask> = {};
  const devTaskIds: string[] = [];

  for (const name of Object.keys(summary?.scripts ?? {})) {
    const isDev = /^(dev|start|serve|watch)(:|$)/.test(name);
    const framework = [...frameworkIds].find((id) => DEFAULT_PORTS[id] !== undefined);
    const inferredPort = isDev && framework !== undefined ? DEFAULT_PORTS[framework] : undefined;
    const readyPattern = isDev && framework !== undefined ? READY_PATTERNS[framework] : undefined;

    tasks[name] = {
      label: name,
      script: name,
      ...(inferredPort === undefined ? {} : { port: inferredPort }),
      ...(readyPattern === undefined ? {} : { readyPattern }),
      ...(isDev ? { watch: true } : {}),
      logFormat: 'auto',
    };
    if (isDev) {
      devTaskIds.push(name);
    }
  }

  const pipelines: Record<string, DotForgePipeline> = {};
  if (devTaskIds.length > 0) {
    pipelines['dev'] = {
      label: 'Dev completo',
      description: 'Todas las tareas de desarrollo detectadas en package.json.',
      tasks: devTaskIds,
      parallel: true,
    };
  }

  const services: DotForgeService[] = [];
  for (const composeFile of ['docker-compose.yml', 'docker-compose.yaml']) {
    if (await exists(composeFile)) {
      services.push({ name: 'docker-compose', kind: 'other', composeFile });
      break;
    }
  }

  const environments: Record<string, DotForgeEnvironment> = {};
  const envFiles: string[] = [];
  for (const candidate of ['.env', '.env.local', '.env.development']) {
    if (await exists(candidate)) {
      envFiles.push(candidate);
    }
  }
  if (envFiles.length > 0) {
    environments['local'] = { label: 'Local', envFiles };
  }

  const manager = parseDeclaredManager(summary?.packageManager);

  return {
    found: false,
    config: {
      $schemaVersion: DOTFORGE_SCHEMA_VERSION,
      name: summary?.name ?? 'proyecto',
      ...(summary?.version === undefined ? {} : { version: summary.version }),
      ...(manager === null ? {} : { packageManager: manager }),
      ...(summary?.workspaces === undefined ? {} : { workspaces: summary.workspaces }),
      ...(Object.keys(tasks).length === 0 ? {} : { tasks }),
      ...(Object.keys(pipelines).length === 0 ? {} : { pipelines }),
      ...(Object.keys(environments).length === 0 ? {} : { environments }),
      ...(services.length === 0 ? {} : { services }),
    },
    warnings: [
      ...warnings,
      'No se encontro manifiesto DotForge; la configuracion se derivo de package.json.',
    ],
    inferred: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  Escritura y sincronizacion                                                 */
/* -------------------------------------------------------------------------- */

const MANIFEST_TARGET = DOTFORGE_MANIFEST_NAMES[0];

export async function writeManifest(raw: unknown): Promise<DotForgeManifest> {
  const { config, warnings } = normalizeConfig(raw, await inferProjectName());
  const payload = {
    $schema: 'https://dotforge.dev/schema/dotforge.config.json',
    ...config,
  };
  await writeFile({
    path: MANIFEST_TARGET,
    content: `${JSON.stringify(payload, null, 2)}\n`,
    eol: 'lf',
  });
  cached = { found: true, path: MANIFEST_TARGET, config, warnings, inferred: false };
  emit({ type: 'dotforge/changed', payload: cached });
  return cached;
}

/**
 * Sincroniza el manifiesto con el estado real del proyecto: anade las tareas
 * de los scripts nuevos y los servicios de docker-compose, sin tocar lo que
 * el usuario ya haya personalizado.
 */
export async function syncManifest(): Promise<DotForgeManifest> {
  const current = await readManifest(true);
  const inferred = await inferManifest();

  const tasks: Record<string, DotForgeTask> = { ...(current.config.tasks ?? {}) };
  for (const [id, task] of Object.entries(inferred.config.tasks ?? {})) {
    if (tasks[id] === undefined) {
      tasks[id] = task;
    }
  }

  const pipelines: Record<string, DotForgePipeline> = { ...(current.config.pipelines ?? {}) };
  for (const [id, pipeline] of Object.entries(inferred.config.pipelines ?? {})) {
    if (pipelines[id] === undefined) {
      pipelines[id] = pipeline;
    }
  }

  const environments: Record<string, DotForgeEnvironment> = {
    ...(inferred.config.environments ?? {}),
    ...(current.config.environments ?? {}),
  };

  const services = [...(current.config.services ?? [])];
  for (const service of inferred.config.services ?? []) {
    if (!services.some((entry) => entry.name === service.name)) {
      services.push(service);
    }
  }

  return writeManifest({
    ...current.config,
    ...(Object.keys(tasks).length === 0 ? {} : { tasks }),
    ...(Object.keys(pipelines).length === 0 ? {} : { pipelines }),
    ...(Object.keys(environments).length === 0 ? {} : { environments }),
    ...(services.length === 0 ? {} : { services }),
  });
}

/** Gestor de paquetes efectivo del proyecto, segun el manifiesto. */
export async function preferredPackageManager(): Promise<PackageManagerId | undefined> {
  const manifest = await readManifest();
  return manifest.config.packageManager;
}
