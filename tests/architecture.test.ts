/**
 * Guardias estaticas de arquitectura.
 *
 * Comprueban por analisis del arbol de fuentes invariantes que no se pueden
 * expresar con el sistema de tipos y que, cuando se rompen, fallan en
 * ejecucion y no al compilar. Cada una existe porque el fallo que previene
 * ya ocurrio o costaria mucho de diagnosticar.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Se ancla al directorio del proyecto y no a `import.meta.url`: las pruebas
// corren ya empaquetadas en `dist/tests`.
const SRC = path.resolve(process.cwd(), 'src');

interface SourceFile {
  readonly path: string;
  readonly source: string;
}

function collect(directory: string): SourceFile[] {
  const found: SourceFile[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collect(full));
    } else if (entry.endsWith('.ts')) {
      found.push({
        path: path.relative(SRC, full).split(path.sep).join('/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  }
  return found;
}

const FILES = collect(SRC);

function read(relative: string): string {
  const file = FILES.find((entry) => entry.path === relative);
  assert.ok(file !== undefined, `no se encontro src/${relative}`);
  return file.source;
}

/**
 * Especificadores importados por un archivo.
 *
 * `mode: 'value'` descarta los `import type`, que TypeScript borra al
 * compilar y por tanto NO crean dependencia en tiempo de ejecucion. La
 * distincion es justo la que importa aqui: `import type { BrowserWindow }
 * from 'electron'` es inocuo, mientras que `import { app } from 'electron'`
 * arrastra el binario entero.
 */
function importsOf(source: string, mode: 'all' | 'value' = 'all'): string[] {
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*import\s+(type\s+)?([^;]*?)from\s*['"]([^'"]+)['"]/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const isTypeOnly = match[1] !== undefined;
    if (mode === 'value' && isTypeOnly) {
      continue;
    }
    // Un import mixto (`import { type A, b }`) sigue siendo de valor si
    // alguno de sus nombres no lleva `type`.
    if (mode === 'value' && !isTypeOnly) {
      const names = match[2] ?? '';
      const inner = /\{([\s\S]*)\}/.exec(names)?.[1];
      if (
        inner !== undefined &&
        inner
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
          .every((entry) => entry.startsWith('type '))
      ) {
        continue;
      }
    }
    found.push(match[3] ?? '');
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/*  Contratos compartidos                                                      */
/* -------------------------------------------------------------------------- */

test('contracts.ts no importa nada: se compila en los tres bundles', () => {
  // Cualquier import lo ataria a un proceso concreto y romperia el preload
  // o el renderer, que no tienen Node.
  const imports = importsOf(read('shared/contracts.ts'));
  assert.deepEqual(imports, []);
});

test('forge-api.ts solo importa tipos de contracts', () => {
  const imports = importsOf(read('shared/forge-api.ts'));
  assert.deepEqual(imports, ['./contracts.js']);
});

/* -------------------------------------------------------------------------- */
/*  Aislamiento de Electron                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Modulos del proceso principal que deben poder analizarse SIN Electron.
 *
 * Son los que la suite de pruebas importa para ejercitar sus analizadores.
 * Cuando uno de ellos empieza a importar `electron` —aunque sea de forma
 * indirecta y bienintencionada—, la suite entera deja de arrancar con un
 * `SyntaxError` de modulo CommonJS que no dice nada del problema real.
 */
const ELECTRON_FREE = [
  'main/services/process/env-service.ts',
  'main/services/process/log-parser.ts',
  'main/services/docker/compose-parser.ts',
  'main/services/db/schema-inspector.ts',
  'main/services/http/http-file-parser.ts',
  'main/services/lsp/framing.ts',
  'main/services/git/porcelain-parser.ts',
  'main/services/metrics/cpu-time.ts',
  'main/services/updater/version.ts',
  'main/debugger/ws-frame.ts',
  'main/debugger/source-map.ts',
  'main/debugger/heap-trend.ts',
  'main/services/spec/openapi-parser.ts',
  'main/services/spec/codegen.ts',
  'main/services/spec/ts-shape.ts',
  'main/services/spec/contract-audit.ts',
  'main/services/testing/test-parser.ts',
  'main/services/testing/result-parser.ts',
  'main/services/testing/coverage.ts',
  'main/services/testing/runner-detect.ts',
  'main/services/vault/env-validate.ts',
  'main/services/plugins/object-literal.ts',
  'main/services/plugins/plugin-parser.ts',
];

test('los modulos analizables no arrastran electron, ni directa ni indirectamente', () => {
  /** Resuelve un import relativo a su ruta dentro de `src/`. */
  const resolve = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith('.')) {
      return null;
    }
    const target = path
      .join(path.dirname(from), specifier)
      .split(path.sep)
      .join('/')
      .replace(/\.js$/, '.ts');
    return FILES.some((file) => file.path === target) ? target : null;
  };

  const offenders: string[] = [];

  for (const entry of ELECTRON_FREE) {
    const seen = new Set<string>();
    const queue = [entry];
    const trail = new Map<string, string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || seen.has(current)) {
        continue;
      }
      seen.add(current);

      const file = FILES.find((candidate) => candidate.path === current);
      if (file === undefined) {
        continue;
      }
      for (const specifier of importsOf(file.source, 'value')) {
        if (specifier === 'electron') {
          // Se reconstruye la cadena para que el mensaje sea util.
          const chain = [current];
          let cursor = current;
          while (trail.has(cursor)) {
            cursor = trail.get(cursor) ?? '';
            chain.unshift(cursor);
          }
          offenders.push(`${entry} -> ${chain.join(' -> ')} -> electron`);
          continue;
        }
        const next = resolve(current, specifier);
        if (next !== null && !seen.has(next)) {
          trail.set(next, current);
          queue.push(next);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'inyecta la dependencia en lugar de importarla (ver setVaultSecretProvider)',
  );
});

/* -------------------------------------------------------------------------- */
/*  Frontera IPC                                                               */
/* -------------------------------------------------------------------------- */

/** Nombres de canal declarados en `IPC`. */
function declaredChannels(): string[] {
  const source = read('shared/contracts.ts');
  const block = /export const IPC = \{([\s\S]*?)\n\} as const;/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*'([^']+)'/gm)].map(
    (match) => match[1] ?? '',
  );
}

test('todo canal declarado tiene un manejador registrado', () => {
  // El registro avisa por consola al arrancar, pero eso solo se ve si
  // alguien esta mirando. Aqui falla la compilacion de la suite.
  const handlers = FILES.filter((file) => file.path.startsWith('main/ipc/handlers/'))
    .map((file) => file.source)
    .join('\n');

  const missing = declaredChannels().filter(
    (channel) => !new RegExp(`IPC\\.${channel}\\b`).test(handlers),
  );
  assert.deepEqual(missing, [], `canales sin manejador: ${missing.join(', ')}`);
});

test('todo canal declarado se expone en el preload', () => {
  const preload = read('main/preload.ts');
  const missing = declaredChannels().filter(
    (channel) => !new RegExp(`IPC\\.${channel}\\b`).test(preload),
  );
  assert.deepEqual(missing, [], `canales sin envoltorio en el preload: ${missing.join(', ')}`);
});

test('el preload nunca expone ipcRenderer al renderer', () => {
  const preload = read('main/preload.ts');
  // Se usa dentro, pero solo puede publicarse la API concreta.
  const exposed = /exposeInMainWorld\(\s*'[^']*'\s*,\s*(\w+)\s*\)/.exec(preload)?.[1];
  assert.equal(exposed, 'api', 'contextBridge solo debe publicar el objeto `api`');
  assert.doesNotMatch(
    preload,
    /exposeInMainWorld\([^)]*ipcRenderer/,
    'ipcRenderer jamas cruza el puente',
  );
});

test('el preload usa canales literales de IPC, nunca cadenas sueltas', () => {
  // Si el renderer pudiera elegir el nombre del canal, el puente dejaria de
  // ser una superficie cerrada.
  const preload = read('main/preload.ts');
  const body = preload.slice(preload.indexOf('const api: ForgeApi'));
  const literalCalls = [...body.matchAll(/\bcall(?:<[^>]*>)?\(\s*(['"])/g)];
  assert.deepEqual(
    literalCalls.map((match) => match[0]),
    [],
    'toda llamada debe pasar por IPC.<CANAL>, no por una cadena literal',
  );
});

/* -------------------------------------------------------------------------- */
/*  Aislamiento del renderer                                                   */
/* -------------------------------------------------------------------------- */

test('el renderer no importa modulos del proceso principal', () => {
  // Solo `shared/` es comun. Importar un servicio del main arrastraria Node
  // a un bundle que se ejecuta con sandbox.
  const offenders = FILES.filter(
    (file) =>
      file.path.startsWith('renderer/') &&
      importsOf(file.source).some((specifier) => specifier.includes('/main/')),
  );
  assert.deepEqual(
    offenders.map((file) => file.path),
    [],
  );
});

test('el renderer accede al sistema solo a traves de window.forge', () => {
  const offenders = FILES.filter(
    (file) =>
      file.path.startsWith('renderer/') &&
      importsOf(file.source).some(
        (specifier) => specifier === 'electron' || specifier.startsWith('node:'),
      ),
  );
  assert.deepEqual(
    offenders.map((file) => file.path),
    [],
  );
});

/* -------------------------------------------------------------------------- */
/*  Acoplamiento de patrones                                                   */
/* -------------------------------------------------------------------------- */

test('los manejadores IPC devuelven Result: ninguna excepcion cruza la frontera', () => {
  const handlers = FILES.filter(
    (file) => file.path.startsWith('main/ipc/handlers/') && file.path !== 'main/ipc/handlers/index.ts',
  );
  for (const file of handlers) {
    // `handle()` obliga por tipos, pero el registro tambien debe importarse
    // del registro central y no reimplementarse.
    assert.match(
      file.source,
      /from '\.\.\/registry\.js'/,
      `${file.path} debe registrar con handle() del registro central`,
    );
    assert.doesNotMatch(
      file.source,
      /ipcMain\.handle\(/,
      `${file.path} no debe saltarse el registro llamando a ipcMain directamente`,
    );
  }
});

test('los servicios etiquetan sus errores de dominio con .forge', () => {
  // Es lo que conserva el codigo semantico al cruzar el IPC; sin la
  // etiqueta, `toForgeError` degrada todo a E_UNKNOWN.
  const withFailure = FILES.filter(
    (file) =>
      file.path.startsWith('main/') &&
      /function failure\(/.test(file.source),
  );
  assert.ok(withFailure.length > 0, 'se esperaba encontrar ayudantes `failure`');
  for (const file of withFailure) {
    assert.match(
      file.source,
      /error\.forge = forgeError\(/,
      `${file.path} define failure() sin etiquetar el error con .forge`,
    );
  }
});

test('el acceso directo al sistema de archivos esta acotado a una lista conocida', () => {
  /*
   * Trinquete deliberado. Toda ruta que venga del renderer debe pasar por
   * `assertInsideWorkspace()`, y la forma de garantizarlo es que los
   * servicios lean y escriban a traves de `fs-service`, que ya lo hace.
   *
   * Los modulos de esta lista tocan el disco directamente por motivos que no
   * involucran rutas del renderer: el guardian mismo, el almacen de
   * credenciales, el protocolo de la app, los ajustes… Anadir uno nuevo debe
   * ser una decision consciente, no un descuido.
   */
  const ALLOWED = new Set([
    'main/security/app-protocol.ts',
    'main/security/workspace-guard.ts',
    'main/services/ai/credentials.ts',
    'main/services/dotforge/generator/index.ts',
    'main/services/format/format-service.ts',
    'main/services/fs-service.ts',
    'main/services/lsp/lsp-manager.ts',
    'main/services/settings-service.ts',
    'main/services/terminal/pty-service.ts',
    'main/services/updater/updater-service.ts',
    'main/services/vault/secret-store.ts',
    'main/services/workspace-service.ts',
  ]);

  const offenders = FILES.filter(
    (file) =>
      file.path.startsWith('main/') &&
      !ALLOWED.has(file.path) &&
      importsOf(file.source, 'value').some((specifier) => specifier.startsWith('node:fs')),
  );

  assert.deepEqual(
    offenders.map((file) => file.path),
    [],
    'usa los ayudantes de fs-service, que ya validan la ruta con el guardian',
  );
});

test('el guardian resuelve enlaces simbolicos antes de comparar', () => {
  // Comparar con `startsWith` sobre cadenas deja pasar un enlace que apunta
  // fuera del workspace. Es el fallo clasico de este tipo de guardian.
  const guard = read('main/security/workspace-guard.ts');
  assert.match(guard, /realpath/i, 'el guardian debe resolver la ruta real');
});
