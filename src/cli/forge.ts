/**
 * CLI headless del generador DotForge.
 *
 * Permite invocar el mismo motor que usa el asistente visual desde un script
 * de CI o desde la terminal, sin arrancar Electron:
 *
 *   forge list --json
 *   forge new react-vite --name "Mi App" --dir ./mi-app --pm pnpm
 *   forge new express-hexagonal --dir ./api --json '{"orm":"drizzle"}' --dry-run
 *   echo '{"blueprintId":"nx", ...}' | forge generate --json
 *
 * Con `--json` la salida es JSON puro en stdout y los mensajes humanos van a
 * stderr, para que se pueda encadenar con `jq` sin filtrar nada.
 */

import { generate, listBlueprints } from '../main/services/dotforge/generator/index.js';
import type { GenerateRequest, PackageManagerId } from '../shared/contracts.js';

const MANAGERS: readonly PackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun'];

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const body = argument.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[body] = true;
    } else {
      flags[body] = next;
      index += 1;
    }
  }

  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

const USAGE = [
  'forge — generador de arquitecturas DotForge',
  '',
  'Uso:',
  '  forge list [--json]',
  '  forge new <blueprint> --dir <ruta> [--name <nombre>] [--pm npm|pnpm|yarn|bun]',
  '                        [--json <opciones>] [--dry-run]',
  '  forge generate --json            lee la peticion completa de stdin',
  '',
  'Opciones:',
  '  --dir       carpeta destino (absoluta o relativa al directorio actual)',
  '  --name      nombre del proyecto; por defecto, el de la carpeta',
  '  --pm        gestor de paquetes (npm por defecto)',
  '  --json      en `list`, salida JSON; en `new`, opciones del blueprint',
  '  --dry-run   calcula el plan sin escribir nada',
  '',
].join('\n');

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const wantsJson = flags['json'] !== undefined;

  /* --- list --- */
  if (command === 'list') {
    const blueprints = listBlueprints();
    if (wantsJson) {
      process.stdout.write(`${JSON.stringify(blueprints, null, 2)}\n`);
      return 0;
    }
    for (const blueprint of blueprints) {
      process.stdout.write(`${blueprint.id.padEnd(22)} ${blueprint.category.padEnd(10)} ${blueprint.label}\n`);
      process.stdout.write(`${' '.repeat(22)} ${blueprint.description}\n`);
    }
    return 0;
  }

  /* --- generate (peticion completa por stdin) --- */
  if (command === 'generate') {
    const payload = await readStdin();
    if (payload.trim() === '') {
      process.stderr.write('Se esperaba una peticion JSON por la entrada estandar.\n');
      return 2;
    }
    let request: GenerateRequest;
    try {
      request = JSON.parse(payload) as GenerateRequest;
    } catch (cause) {
      process.stderr.write(`La peticion no es JSON valido: ${String(cause)}\n`);
      return 2;
    }
    const result = await generate(request);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  /* --- new --- */
  if (command === 'new') {
    const blueprintId = positional[0];
    if (blueprintId === undefined) {
      process.stderr.write('Falta el identificador del blueprint. Prueba `forge list`.\n');
      return 2;
    }
    const dir = flags['dir'];
    if (typeof dir !== 'string' || dir === '') {
      process.stderr.write('Falta --dir con la carpeta destino.\n');
      return 2;
    }

    const { resolve, basename } = await import('node:path');
    const targetDir = resolve(process.cwd(), dir);
    const name = typeof flags['name'] === 'string' ? flags['name'] : basename(targetDir);

    const manager = typeof flags['pm'] === 'string' ? flags['pm'] : 'npm';
    if (!MANAGERS.includes(manager as PackageManagerId)) {
      process.stderr.write(`Gestor de paquetes desconocido: ${manager}\n`);
      return 2;
    }

    let options: Record<string, string | boolean> = {};
    if (typeof flags['json'] === 'string' && flags['json'] !== '') {
      try {
        options = JSON.parse(flags['json']) as Record<string, string | boolean>;
      } catch (cause) {
        process.stderr.write(`Las opciones no son JSON valido: ${String(cause)}\n`);
        return 2;
      }
    }

    const result = await generate({
      blueprintId,
      targetDir,
      projectName: name,
      packageManager: manager as PackageManagerId,
      options,
      dryRun: flags['dry-run'] === true,
    });

    if (typeof flags['json'] === 'string' || flags['json'] === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    const verbo = result.dryRun ? 'Se generarian' : 'Generados';
    process.stdout.write(`${verbo} ${result.files.length} archivos en ${result.targetDir}\n\n`);
    for (const step of result.nextSteps) {
      process.stdout.write(`  ${step}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }

  process.stdout.write(USAGE);
  return command === 'help' || command === '--help' ? 0 : 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    // Los errores de dominio llevan `.forge` con su codigo semantico.
    const forge = (cause as { forge?: { code: string; message: string; detail?: string } }).forge;
    if (forge !== undefined) {
      process.stderr.write(`[${forge.code}] ${forge.message}\n`);
      if (forge.detail !== undefined) {
        process.stderr.write(`${forge.detail}\n`);
      }
    } else {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
    process.exitCode = 1;
  });
