/**
 * Registro de comandos.
 *
 * Es la superficie unica desde la que actuan la paleta, los atajos de teclado
 * y los botones del shell: cada accion existe una sola vez y se invoca por id.
 */

import { toast, toastError } from './toasts.js';

export interface CommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly keybinding?: string;
  /** Devuelve false para ocultar el comando en la paleta segun el contexto. */
  readonly enabled?: () => boolean;
  readonly run: (argument?: unknown) => void | Promise<void>;
}

const commands = new Map<string, CommandDefinition>();

export function defineCommand(definition: CommandDefinition): void {
  commands.set(definition.id, definition);
}

export function defineCommands(definitions: readonly CommandDefinition[]): void {
  for (const definition of definitions) {
    defineCommand(definition);
  }
}

export function getCommand(id: string): CommandDefinition | undefined {
  return commands.get(id);
}

export function listCommands(): readonly CommandDefinition[] {
  return [...commands.values()]
    .filter((command) => command.enabled === undefined || command.enabled())
    .sort((a, b) =>
      a.category === b.category
        ? a.title.localeCompare(b.title, 'es')
        : a.category.localeCompare(b.category, 'es'),
    );
}

export async function runCommand(id: string, argument?: unknown): Promise<void> {
  const command = commands.get(id);
  if (command === undefined) {
    toast('warn', `Comando desconocido: ${id}`);
    return;
  }
  try {
    await command.run(argument);
  } catch (cause) {
    console.error(`[forge] el comando ${id} fallo`, cause);
    toastError(`El comando "${command.title}" fallo.`, {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Registra los comandos base. Cada vista anade los suyos al montarse, de modo
 * que este modulo no depende de ninguna de ellas.
 */
export function registerCommands(): void {
  defineCommands([
    {
      id: 'app.reload',
      title: 'Recargar la ventana',
      category: 'Aplicacion',
      run: () => {
        window.location.reload();
      },
    },
    {
      id: 'app.about',
      title: 'Acerca de ForgeJS IDE',
      category: 'Aplicacion',
      run: async () => {
        const info = await window.forge.app.info();
        if (!info.ok) {
          toastError('No se pudo leer la informacion de la aplicacion.', info.error);
          return;
        }
        const value = info.value;
        toast(
          'info',
          `ForgeJS IDE ${value.version}`,
          `Electron ${value.electron} · Chromium ${value.chrome} · Node ${value.node} · ${value.platform}-${value.arch}`,
        );
      },
    },
  ]);
}
