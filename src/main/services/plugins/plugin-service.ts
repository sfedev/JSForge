/**
 * Motor de plugins.
 *
 * Descubre los manifiestos de `.forge/`, los valida y ejecuta sus acciones
 * declaradas. NO hay proceso hijo dedicado ni evaluacion del manifiesto: las
 * acciones son verbos cerrados que el IDE ya sabe hacer, y se ejecutan con
 * los mismos servicios (y las mismas restricciones) que cualquier otra
 * accion de la interfaz.
 *
 * En concreto:
 *  - `shell` pasa por el gestor de procesos, que redacta secretos de la
 *    salida, mata el arbol al detener y acota el cwd al workspace.
 *  - `write` pasa por `fs-service`, que valida la ruta con el guardian.
 *  - `command` y `open` se delegan al renderer por el bus de eventos.
 *
 * Un plugin no puede, por tanto, hacer nada que el usuario no pudiera hacer
 * desde la propia interfaz.
 */

import {
  forgeError,
  type PluginAction,
  type PluginDefinition,
  type PluginRunResult,
  type PluginState,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { assertInsideWorkspace } from '../../security/workspace-guard.js';
import { requireWorkspaceRoot } from '../workspace-service.js';
import { exists, globToRegExp, readTextIfExists, writeFile } from '../fs-service.js';
import { startProcess } from '../process/process-manager.js';
import { parsePlugin } from './plugin-parser.js';

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

/** Ubicaciones donde se busca un manifiesto, en orden. */
const MANIFEST_PATHS = [
  '.forge/plugin.ts',
  '.forge/plugin.js',
  '.forge/plugins.ts',
  'forge.plugin.ts',
];

/** Plugins cargados, por id. */
const plugins = new Map<string, PluginState>();

/** Plugins que el usuario desactivo en esta sesion. */
const disabled = new Set<string>();

/* -------------------------------------------------------------------------- */
/*  Carga                                                                      */
/* -------------------------------------------------------------------------- */

/** Relee los manifiestos del workspace. */
export async function reloadPlugins(): Promise<readonly PluginState[]> {
  requireWorkspaceRoot();
  plugins.clear();

  for (const relative of MANIFEST_PATHS) {
    const source = await readTextIfExists(relative);
    if (source === null) {
      continue;
    }
    const { definition, errors } = parsePlugin(relative, source);
    if (definition === null) {
      // Un manifiesto ilegible se publica igualmente con sus errores: si no,
      // el usuario no sabria por que su plugin no aparece.
      emit({
        type: 'notification',
        payload: {
          level: 'warn',
          message: `El plugin de ${relative} no se pudo cargar.`,
          detail: errors[0] ?? 'Manifiesto no valido.',
        },
      });
      continue;
    }
    plugins.set(definition.id, {
      definition,
      enabled: !disabled.has(definition.id),
      errors,
    });
  }

  const states = listPlugins();
  emit({ type: 'plugin/changed', payload: states });
  return states;
}

export function listPlugins(): readonly PluginState[] {
  return [...plugins.values()].sort((a, b) =>
    a.definition.name.localeCompare(b.definition.name, 'es'),
  );
}

export function setPluginEnabled(pluginId: string, enabled: boolean): readonly PluginState[] {
  const state = plugins.get(pluginId);
  if (state === undefined) {
    failure('E_NOT_FOUND', `No hay ningun plugin con el id "${pluginId}".`);
  }
  if (enabled) {
    disabled.delete(pluginId);
  } else {
    disabled.add(pluginId);
  }
  plugins.set(pluginId, { ...state, enabled });

  const states = listPlugins();
  emit({ type: 'plugin/changed', payload: states });
  return states;
}

/** Comandos aportados por los plugins activos. */
export function activeCommands(): readonly { pluginId: string; command: PluginDefinition['commands'][number] }[] {
  const out: { pluginId: string; command: PluginDefinition['commands'][number] }[] = [];
  for (const state of plugins.values()) {
    if (!state.enabled) {
      continue;
    }
    for (const command of state.definition.commands) {
      out.push({ pluginId: state.definition.id, command });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Ejecucion de acciones                                                      */
/* -------------------------------------------------------------------------- */

/** Contador para dar identificadores unicos a los procesos de plugin. */
let runCounter = 0;

/**
 * Ejecuta una accion.
 *
 * Devuelve una descripcion de lo hecho y, si lanzo un proceso, su id. Las
 * acciones se encadenan en orden: si una falla, se detiene la cadena, porque
 * el resto suele depender de ella.
 */
async function performAction(
  pluginId: string,
  action: PluginAction,
): Promise<{ description: string; processId?: string }> {
  const root = requireWorkspaceRoot();

  switch (action.task) {
    case 'shell': {
      runCounter += 1;
      const id = `plugin:${pluginId}:${runCounter}`;
      // El cwd pasa por el guardian igual que el de cualquier tarea.
      const cwd = action.cwd === undefined ? undefined : assertInsideWorkspace(root, action.cwd).relative;
      const info = await startProcess({
        id,
        label: action.label ?? `${pluginId}: ${action.command}`,
        command: action.command,
        args: action.args,
        ...(cwd === undefined ? {} : { cwd }),
      });
      return {
        description: `Lanzado ${action.command} ${action.args.join(' ')}`.trim(),
        processId: info.id,
      };
    }

    case 'write': {
      const guarded = assertInsideWorkspace(root, action.path);
      if (!action.overwrite && (await exists(guarded.relative))) {
        // Sobrescribir en silencio destruiria trabajo del usuario.
        failure(
          'E_ALREADY_EXISTS',
          `"${guarded.relative}" ya existe.`,
          'Declara "overwrite: true" si el plugin debe reemplazarlo.',
        );
      }
      await writeFile({ path: guarded.relative, content: action.content });
      return { description: `Escrito ${guarded.relative}` };
    }

    case 'command':
      // Los comandos del IDE viven en el renderer: se delega por el bus.
      emit({
        type: 'ui/command',
        payload: { command: action.id, args: action.args },
      });
      return { description: `Invocado el comando ${action.id}` };

    default: {
      const guarded = assertInsideWorkspace(root, action.path);
      emit({
        type: 'ui/command',
        payload: {
          command: 'editor.revealLine',
          args: { path: guarded.relative, line: action.line ?? 1 },
        },
      });
      return { description: `Abierto ${guarded.relative}` };
    }
  }
}

/** Ejecuta un comando declarado por un plugin. */
export async function runPluginCommand(commandId: string): Promise<PluginRunResult> {
  const entry = activeCommands().find(({ command }) => command.id === commandId);
  if (entry === undefined) {
    failure(
      'E_NOT_FOUND',
      `No hay ningun comando de plugin con el id "${commandId}".`,
      'Puede que el plugin este desactivado o que el manifiesto haya cambiado.',
    );
  }

  const performed: string[] = [];
  const processIds: string[] = [];

  for (const action of entry.command.actions) {
    const result = await performAction(entry.pluginId, action);
    performed.push(result.description);
    if (result.processId !== undefined) {
      processIds.push(result.processId);
    }
  }

  return { commandId, performed, processIds };
}

/* -------------------------------------------------------------------------- */
/*  Ganchos                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ejecuta los ganchos posteriores a una generacion de DotForge.
 *
 * Los fallos se notifican pero NO se propagan: el proyecto ya esta generado
 * y hacer fracasar la operacion entera por un gancho de plugin seria peor
 * que avisar y seguir.
 */
export async function runScaffoldHooks(blueprintId: string): Promise<readonly string[]> {
  const performed: string[] = [];

  for (const state of plugins.values()) {
    if (!state.enabled) {
      continue;
    }
    for (const hook of state.definition.scaffold) {
      if (hook.blueprint !== '*' && hook.blueprint !== blueprintId) {
        continue;
      }
      for (const action of hook.actions) {
        try {
          const result = await performAction(state.definition.id, action);
          performed.push(result.description);
        } catch (cause) {
          emit({
            type: 'notification',
            payload: {
              level: 'warn',
              message: `Un gancho de "${state.definition.name}" fallo.`,
              detail: cause instanceof Error ? cause.message : String(cause),
            },
          });
        }
      }
    }
  }
  return performed;
}

/**
 * Ganchos de guardado que aplican a una ruta.
 *
 * Se resuelve con `globToRegExp` de `fs-service`, el mismo motor de patrones
 * que usa la busqueda: dos sintaxis distintas para el usuario serian una
 * fuente segura de confusion.
 */
export function watchersFor(relativePath: string): readonly PluginAction[] {
  const actions: PluginAction[] = [];
  for (const state of plugins.values()) {
    if (!state.enabled) {
      continue;
    }
    for (const watcher of state.definition.watchers) {
      if (watcher.include.some((pattern) => globToRegExp(pattern).test(relativePath))) {
        actions.push(...watcher.actions);
      }
    }
  }
  return actions;
}

export async function runSaveHooks(relativePath: string): Promise<readonly string[]> {
  const performed: string[] = [];
  for (const action of watchersFor(relativePath)) {
    try {
      const result = await performAction('onSave', action);
      performed.push(result.description);
    } catch (cause) {
      emit({
        type: 'notification',
        payload: {
          level: 'warn',
          message: 'Un gancho de guardado fallo.',
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      });
    }
  }
  return performed;
}

/** Formateador aportado por un plugin para un lenguaje, si lo hay. */
export function formatterFor(languageId: string): PluginDefinition['formatters'][number] | null {
  for (const state of plugins.values()) {
    if (!state.enabled) {
      continue;
    }
    const formatter = state.definition.formatters.find((entry) =>
      entry.languages.includes(languageId),
    );
    if (formatter !== undefined) {
      return formatter;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Plantilla                                                                  */
/* -------------------------------------------------------------------------- */

/** Manifiesto de ejemplo, comentado, para arrancar un plugin nuevo. */
export function pluginTemplate(): string {
  return [
    '/**',
    ' * Plugin de ForgeJS IDE.',
    ' *',
    ' * Este archivo es un manifiesto DECLARATIVO: el IDE lo lee, nunca lo',
    ' * ejecuta. Por eso solo admite datos literales, sin llamadas ni',
    ' * variables. A cambio, un plugin no puede hacer nada que tu no pudieras',
    ' * hacer desde la propia interfaz.',
    ' */',
    '',
    "import { definePlugin } from 'forgejs-ide';",
    '',
    'export default definePlugin({',
    "  id: 'mi-equipo',",
    "  name: 'Herramientas del equipo',",
    "  version: '1.0.0',",
    "  description: 'Comandos internos del proyecto.',",
    '',
    '  // Aparecen en la paleta de comandos (Ctrl+Shift+P).',
    '  commands: [',
    '    {',
    "      id: 'migrar',",
    "      title: 'Base de datos: aplicar migraciones',",
    "      category: 'Base de datos',",
    '      run: [',
    "        { task: 'shell', command: 'npm', args: ['run', 'db:migrate'] },",
    '      ],',
    '    },',
    '  ],',
    '',
    '  // Formateadores propios para lenguajes que el IDE no cubre.',
    '  formatters: [',
    '    {',
    "      languages: ['sql'],",
    "      command: 'sql-formatter',",
    "      args: ['--fix', '$FILE'],",
    '    },',
    '  ],',
    '',
    '  // Pasos posteriores a generar un proyecto con DotForge.',
    '  scaffold: [',
    '    {',
    "      blueprint: '*',",
    '      afterGenerate: [',
    "        { task: 'shell', command: 'npm', args: ['run', 'lint', '--', '--fix'] },",
    '      ],',
    '    },',
    '  ],',
    '',
    '  // Acciones al guardar los archivos que casen con el patron.',
    '  onSave: [',
    '    {',
    "      include: ['src/**/*.sql'],",
    "      run: [{ task: 'command', id: 'editor.format', args: [] }],",
    '    },',
    '  ],',
    '});',
    '',
  ].join('\n');
}

/** Crea `.forge/plugin.ts` a partir de la plantilla. */
export async function createPluginTemplate(): Promise<string> {
  const root = requireWorkspaceRoot();
  const target = MANIFEST_PATHS[0] ?? '.forge/plugin.ts';
  const guarded = assertInsideWorkspace(root, target);

  if (await exists(guarded.relative)) {
    failure('E_ALREADY_EXISTS', `"${guarded.relative}" ya existe.`);
  }
  await writeFile({ path: guarded.relative, content: pluginTemplate() });
  await reloadPlugins();
  return guarded.relative;
}

/** Olvida los plugins al cerrar el workspace. */
export function disposePlugins(): void {
  plugins.clear();
  disabled.clear();
}
