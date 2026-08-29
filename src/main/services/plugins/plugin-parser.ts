/**
 * Lectura y validacion de `.forge/plugin.ts`.
 *
 * El archivo es un manifiesto DECLARATIVO en TypeScript: describe que
 * comandos, formateadores y pasos de construccion aporta el plugin, pero no
 * contiene logica que haya que ejecutar. Se lee con el analizador de
 * literales, nunca con `eval` ni `Function`.
 *
 * Es una decision de diseno, no una limitacion accidental. Un motor que
 * ejecutara el archivo tendria que crear un proceso (descartado) o evaluarlo
 * en el proceso principal, que es donde viven las claves descifradas y el
 * acceso al disco sin restricciones. Un manifiesto de datos da el 90% del
 * valor sin abrir esa puerta.
 *
 * La validacion es estricta y acumula TODOS los problemas antes de rendirse:
 * decir «el comando 3 no declara accion» de golpe es mas util que fallar en
 * el primero y obligar a repetir el ciclo.
 */

import type {
  PluginAction,
  PluginCommand,
  PluginDefinition,
  PluginFormatter,
  PluginScaffoldHook,
  PluginWatcher,
} from '../../../shared/contracts.js';
import {
  findCallArgument,
  parseObjectLiteral,
  LiteralParseError,
  type LiteralValue,
} from './object-literal.js';

/** Nombre de la funcion envoltorio que se espera en el manifiesto. */
const FACTORY = 'definePlugin';

export interface PluginParseResult {
  readonly definition: PluginDefinition | null;
  readonly errors: readonly string[];
}

type Record_ = { [key: string]: LiteralValue };

function isRecord(value: LiteralValue): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: LiteralValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: LiteralValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/* -------------------------------------------------------------------------- */
/*  Acciones                                                                   */
/* -------------------------------------------------------------------------- */

/** Tareas admitidas. Cada una es un verbo cerrado, no codigo arbitrario. */
const TASKS = new Set(['shell', 'command', 'write', 'open']);

function parseAction(raw: LiteralValue, where: string, errors: string[]): PluginAction | null {
  if (!isRecord(raw)) {
    errors.push(`${where}: la accion debe ser un objeto.`);
    return null;
  }
  const task = asString(raw['task']);
  if (task === null || !TASKS.has(task)) {
    errors.push(
      `${where}: "task" debe ser uno de ${[...TASKS].join(', ')}; se encontro ${String(raw['task'])}.`,
    );
    return null;
  }

  switch (task) {
    case 'shell': {
      const command = asString(raw['command']);
      if (command === null || command.trim() === '') {
        errors.push(`${where}: una tarea "shell" necesita "command".`);
        return null;
      }
      const cwd = asString(raw['cwd']);
      const label = asString(raw['label']);
      return {
        task: 'shell',
        command,
        args: asStringArray(raw['args']),
        ...(cwd === null ? {} : { cwd }),
        ...(label === null ? {} : { label }),
      };
    }

    case 'command': {
      const id = asString(raw['id']);
      if (id === null || id.trim() === '') {
        errors.push(`${where}: una tarea "command" necesita "id".`);
        return null;
      }
      return { task: 'command', id, args: asStringArray(raw['args']) };
    }

    case 'write': {
      const path = asString(raw['path']);
      const content = asString(raw['content']);
      if (path === null || content === null) {
        errors.push(`${where}: una tarea "write" necesita "path" y "content".`);
        return null;
      }
      // La ruta se valida de verdad con el guardian al ejecutarla; aqui solo
      // se rechaza lo evidentemente fuera de sitio, para avisar antes.
      if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('..')) {
        errors.push(`${where}: "path" debe ser relativo al workspace y sin "..".`);
        return null;
      }
      return { task: 'write', path, content, overwrite: raw['overwrite'] === true };
    }

    default: {
      const path = asString(raw['path']);
      if (path === null) {
        errors.push(`${where}: una tarea "open" necesita "path".`);
        return null;
      }
      const line = raw['line'];
      return {
        task: 'open',
        path,
        ...(typeof line === 'number' ? { line } : {}),
      };
    }
  }
}

function parseActions(raw: LiteralValue | undefined, where: string, errors: string[]): PluginAction[] {
  if (raw === undefined) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const out: PluginAction[] = [];
  list.forEach((entry, index) => {
    const action = parseAction(entry, `${where}[${index}]`, errors);
    if (action !== null) {
      out.push(action);
    }
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Secciones                                                                  */
/* -------------------------------------------------------------------------- */

/** Los ids de comando del plugin se prefijan para no chocar con los del IDE. */
export function namespacedCommandId(pluginId: string, commandId: string): string {
  return commandId.startsWith(`${pluginId}.`) ? commandId : `${pluginId}.${commandId}`;
}

function parseCommands(
  raw: LiteralValue | undefined,
  pluginId: string,
  errors: string[],
): PluginCommand[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    errors.push('"commands" debe ser una lista.');
    return [];
  }

  const out: PluginCommand[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const where = `commands[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${where}: debe ser un objeto.`);
      return;
    }
    const id = asString(entry['id']);
    const title = asString(entry['title']);
    if (id === null || !/^[a-z][\w.-]*$/i.test(id)) {
      errors.push(`${where}: "id" debe ser un identificador simple.`);
      return;
    }
    if (title === null || title.trim() === '') {
      errors.push(`${where}: "title" es obligatorio; es lo que se ve en la paleta.`);
      return;
    }

    const fullId = namespacedCommandId(pluginId, id);
    if (seen.has(fullId)) {
      errors.push(`${where}: el comando "${fullId}" esta declarado dos veces.`);
      return;
    }
    seen.add(fullId);

    const actions = parseActions(entry['run'], `${where}.run`, errors);
    if (actions.length === 0) {
      errors.push(`${where}: no declara ninguna accion en "run".`);
      return;
    }

    const category = asString(entry['category']);
    const keybinding = asString(entry['keybinding']);
    out.push({
      id: fullId,
      title,
      category: category ?? 'Plugin',
      ...(keybinding === null ? {} : { keybinding }),
      actions,
    });
  });

  return out;
}

function parseFormatters(
  raw: LiteralValue | undefined,
  errors: string[],
): PluginFormatter[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    errors.push('"formatters" debe ser una lista.');
    return [];
  }

  const out: PluginFormatter[] = [];
  raw.forEach((entry, index) => {
    const where = `formatters[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${where}: debe ser un objeto.`);
      return;
    }
    const command = asString(entry['command']);
    const languages = asStringArray(entry['languages']);
    if (command === null || command.trim() === '') {
      errors.push(`${where}: "command" es obligatorio.`);
      return;
    }
    if (languages.length === 0) {
      errors.push(`${where}: "languages" debe declarar al menos un lenguaje.`);
      return;
    }
    const args = asStringArray(entry['args']);
    // El formateador recibe el archivo por argumento o por entrada estandar;
    // sin `$FILE` se asume stdin, que es lo que hacen prettier y biome.
    out.push({
      languages,
      command,
      args,
      usesStdin: !args.includes('$FILE'),
    });
  });
  return out;
}

function parseScaffold(
  raw: LiteralValue | undefined,
  errors: string[],
): PluginScaffoldHook[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    errors.push('"scaffold" debe ser una lista.');
    return [];
  }

  const out: PluginScaffoldHook[] = [];
  raw.forEach((entry, index) => {
    const where = `scaffold[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${where}: debe ser un objeto.`);
      return;
    }
    const blueprint = asString(entry['blueprint']);
    const actions = parseActions(entry['afterGenerate'], `${where}.afterGenerate`, errors);
    if (actions.length === 0) {
      errors.push(`${where}: no declara acciones en "afterGenerate".`);
      return;
    }
    out.push({
      // Sin `blueprint` el gancho aplica a todos los blueprints.
      blueprint: blueprint ?? '*',
      actions,
    });
  });
  return out;
}

function parseWatchers(raw: LiteralValue | undefined, errors: string[]): PluginWatcher[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    errors.push('"onSave" debe ser una lista.');
    return [];
  }

  const out: PluginWatcher[] = [];
  raw.forEach((entry, index) => {
    const where = `onSave[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${where}: debe ser un objeto.`);
      return;
    }
    const include = asStringArray(entry['include']);
    if (include.length === 0) {
      errors.push(`${where}: "include" debe declarar al menos un patron.`);
      return;
    }
    const actions = parseActions(entry['run'], `${where}.run`, errors);
    if (actions.length === 0) {
      errors.push(`${where}: no declara acciones en "run".`);
      return;
    }
    out.push({ include, actions });
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Punto de entrada                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Analiza el contenido de `.forge/plugin.ts`.
 *
 * Nunca lanza: devuelve la definicion junto con los errores encontrados, de
 * modo que la interfaz pueda mostrar un plugin parcialmente valido y decir
 * exactamente que le falta.
 */
export function parsePlugin(relativePath: string, source: string): PluginParseResult {
  const errors: string[] = [];

  const start = findCallArgument(source, FACTORY);
  if (start === -1) {
    return {
      definition: null,
      errors: [
        `${relativePath} no llama a ${FACTORY}(). El manifiesto debe exportar ${FACTORY}({ ... }).`,
      ],
    };
  }

  let literal: LiteralValue;
  try {
    literal = parseObjectLiteral(source, start);
  } catch (cause) {
    return {
      definition: null,
      errors: [
        cause instanceof LiteralParseError
          ? `${relativePath}: ${cause.message}`
          : `${relativePath}: no se pudo leer el manifiesto.`,
      ],
    };
  }

  if (!isRecord(literal)) {
    return { definition: null, errors: [`${relativePath}: ${FACTORY}() espera un objeto.`] };
  }

  const id = asString(literal['id']);
  if (id === null || !/^[a-z][\w-]*$/i.test(id)) {
    errors.push('"id" es obligatorio y debe ser un identificador simple.');
  }
  const name = asString(literal['name']);
  if (name === null || name.trim() === '') {
    errors.push('"name" es obligatorio.');
  }

  if (id === null || name === null) {
    return { definition: null, errors };
  }

  const description = asString(literal['description']);
  const definition: PluginDefinition = {
    id,
    name,
    version: asString(literal['version']) ?? '0.0.0',
    ...(description === null ? {} : { description }),
    path: relativePath,
    commands: parseCommands(literal['commands'], id, errors),
    formatters: parseFormatters(literal['formatters'], errors),
    scaffold: parseScaffold(literal['scaffold'], errors),
    watchers: parseWatchers(literal['onSave'], errors),
  };

  const total =
    definition.commands.length +
    definition.formatters.length +
    definition.scaffold.length +
    definition.watchers.length;
  if (total === 0 && errors.length === 0) {
    errors.push('El plugin no aporta ningun comando, formateador ni gancho.');
  }

  return { definition, errors };
}
