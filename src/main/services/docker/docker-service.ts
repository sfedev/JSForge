/**
 * Control de contenedores mediante la CLI de Docker.
 *
 * Se usa `docker compose` (subcomando moderno) con reserva a `docker-compose`
 * para instalaciones antiguas. Los nombres de servicio se validan antes de
 * pasarlos, y los argumentos viajan siempre como lista.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { forgeError, type ContainerInfo } from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { requireWorkspaceRoot } from '../workspace-service.js';

const run = promisify(execFile);

const DOCKER_TIMEOUT_MS = 120_000;

let composeCommand: { command: string; prefix: string[] } | null | undefined;

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

async function tryRun(command: string, args: readonly string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await run(command, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      timeout: DOCKER_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return String(stdout);
  } catch {
    return null;
  }
}

export async function isDockerAvailable(): Promise<boolean> {
  return (await tryRun('docker', ['version', '--format', '{{.Server.Version}}'])) !== null;
}

/** Resuelve una sola vez la forma disponible de compose. */
async function resolveCompose(): Promise<{ command: string; prefix: string[] } | null> {
  if (composeCommand !== undefined) {
    return composeCommand;
  }
  if ((await tryRun('docker', ['compose', 'version'])) !== null) {
    composeCommand = { command: 'docker', prefix: ['compose'] };
  } else if ((await tryRun('docker-compose', ['version'])) !== null) {
    composeCommand = { command: 'docker-compose', prefix: [] };
  } else {
    composeCommand = null;
  }
  return composeCommand;
}

/** Un nombre de servicio de compose no lleva espacios ni empieza por guion. */
function assertServiceName(name: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    failure('E_INVALID_ARGUMENT', `Nombre de servicio no valido: ${String(name)}`);
  }
  return name;
}

async function compose(
  relativePath: string,
  args: readonly string[],
  services: readonly string[],
): Promise<true> {
  const resolved = await resolveCompose();
  if (resolved === null) {
    failure('E_NOT_AVAILABLE', 'Docker Compose no esta disponible en este sistema.');
  }
  const root = requireWorkspaceRoot();
  const guarded = assertInsideWorkspace(root, relativePath);
  const names = services.map((name) => assertServiceName(name));

  try {
    await run(
      resolved.command,
      [...resolved.prefix, '--file', guarded.absolute, ...args, ...names],
      {
        cwd: root,
        timeout: DOCKER_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
  } catch (cause) {
    const error = cause as { stderr?: string };
    failure('E_PROCESS_FAILED', 'El comando de Docker Compose fallo.', (error.stderr ?? String(cause)).trim());
  }
  await refreshContainers();
  return true;
}

export async function composeUp(relativePath: string, services: readonly string[]): Promise<true> {
  return compose(relativePath, ['up', '--detach'], services);
}

export async function composeDown(relativePath: string, services: readonly string[]): Promise<true> {
  // `stop` solo para los servicios indicados; `down` completo si no hay lista.
  return services.length === 0
    ? compose(relativePath, ['down'], [])
    : compose(relativePath, ['stop'], services);
}

/** Contenedores en ejecucion, con el formato de tabla de `docker ps`. */
export async function listContainers(): Promise<readonly ContainerInfo[]> {
  const format = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}';
  const output = await tryRun('docker', ['ps', '--all', '--format', format]);
  if (output === null) {
    return [];
  }
  const containers: ContainerInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    const [id = '', name = '', image = '', state = '', status = '', ports = ''] = line.split('\t');
    containers.push({ id, name, image, state, status, ports });
  }
  return containers;
}

export async function refreshContainers(): Promise<readonly ContainerInfo[]> {
  const containers = await listContainers();
  emit({ type: 'docker/changed', payload: containers });
  return containers;
}
