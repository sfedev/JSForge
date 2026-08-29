/**
 * Vista de plugins y registro de sus comandos en la paleta.
 *
 * Los comandos de un plugin se registran DINAMICAMENTE al cargarse el
 * manifiesto y se retiran al desactivarlo, de modo que la paleta refleje
 * siempre lo que de verdad se puede ejecutar. Un comando fantasma que falla
 * al invocarse es peor que uno que no aparece.
 *
 * La vista vive en las preferencias y no en la barra lateral: no es algo que
 * se consulte a diario, y la barra de actividad ya tiene siete entradas.
 */

import { h, svgIcon } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { confirmDialog } from '../core/dialogs.js';
import {
  defineCommand,
  defineCommands,
  removeCommand,
  runCommand,
} from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { openFile } from './editor-area.js';
import type { PluginState } from '../../shared/contracts.js';

/** Ids de comando registrados por plugins, para poder retirarlos. */
const registered = new Set<string>();

/**
 * Sincroniza la paleta con los plugins cargados.
 *
 * Se retira TODO lo anterior antes de registrar: es la unica forma de que
 * desactivar un plugin, o quitarle un comando del manifiesto, lo haga
 * desaparecer de verdad.
 */
export function registerPluginCommands(states: readonly PluginState[]): void {
  for (const id of registered) {
    removeCommand(id);
  }
  registered.clear();

  for (const state of states) {
    if (!state.enabled) {
      continue;
    }
    for (const command of state.definition.commands) {
      registered.add(command.id);
      defineCommand({
        id: command.id,
        title: command.title,
        // La categoria lleva el nombre del plugin: en la paleta hay que
        // poder distinguir un comando propio de uno del IDE.
        category: `${command.category} · ${state.definition.name}`,
        ...(command.keybinding === undefined ? {} : { keybinding: command.keybinding }),
        run: async () => {
          const result = await window.forge.plugins.run(command.id);
          if (!result.ok) {
            toastError(`El comando "${command.title}" fallo.`, result.error);
            return;
          }
          const [first] = result.value.performed;
          toast(
            'info',
            command.title,
            result.value.performed.length === 1
              ? first
              : `${result.value.performed.length} acciones ejecutadas.`,
          );
          // Si lanzo procesos, el sitio donde mirar es el panel de salida.
          if (result.value.processIds.length > 0) {
            store.patch({ panelView: 'output', panelVisible: true });
          }
        },
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Panel de preferencias                                                      */
/* -------------------------------------------------------------------------- */

/** Construye la seccion de plugins dentro del dialogo de preferencias. */
export function buildPluginsSection(): HTMLElement {
  const list = h('div', { class: 'list' });
  const container = h(
    'div',
    { class: 'section' },
    h('div', { class: 'section__header' }, 'Plugins del proyecto'),
    h('div', { class: 'section__body' }, list),
  );

  const render = (): void => {
    const states = store.state.plugins;
    if (states.length === 0) {
      list.replaceChildren(
        h(
          'div',
          { class: 'empty-note' },
          'Este proyecto no tiene ningun .forge/plugin.ts.',
        ),
        actionRow(),
      );
      return;
    }
    list.replaceChildren(...states.map((state) => pluginRow(state)), actionRow());
  };

  function actionRow(): HTMLElement {
    const create = h(
      'button',
      { class: 'btn btn--ghost', type: 'button' },
      'Crear un plugin de ejemplo',
    );
    create.addEventListener('click', () => void runCommand('plugins.createTemplate'));

    const reload = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Recargar');
    reload.addEventListener('click', () => void runCommand('plugins.reload'));

    return h('div', { style: 'display:flex;gap:8px;padding:8px' }, create, reload);
  }

  function pluginRow(state: PluginState): HTMLElement {
    const { definition } = state;
    const contributions = [
      definition.commands.length > 0 ? `${definition.commands.length} comandos` : null,
      definition.formatters.length > 0 ? `${definition.formatters.length} formateadores` : null,
      definition.scaffold.length > 0 ? `${definition.scaffold.length} ganchos de scaffold` : null,
      definition.watchers.length > 0 ? `${definition.watchers.length} ganchos de guardado` : null,
    ]
      .filter((entry): entry is string => entry !== null)
      .join(' · ');

    const toggle = h('input', {
      type: 'checkbox',
      'aria-label': `Activar ${definition.name}`,
    }) as HTMLInputElement;
    toggle.checked = state.enabled;
    toggle.addEventListener('change', () => {
      void window.forge.plugins.setEnabled(definition.id, toggle.checked).then((result) => {
        if (!result.ok) {
          toastError('No se pudo cambiar el estado del plugin.', result.error);
          return;
        }
        store.patch({ plugins: [...result.value] });
      });
    });

    const header = h(
      'div',
      { class: 'list-row', title: definition.path },
      toggle,
      h('span', { class: 'list-row__label' }, `${definition.name} v${definition.version}`),
      h('span', { class: 'list-row__hint' }, contributions),
    );
    header.addEventListener('click', (event) => {
      if (event.target !== toggle) {
        void openFile(definition.path);
      }
    });

    const rows: HTMLElement[] = [header];
    if (definition.description !== undefined) {
      rows.push(
        h('div', { class: 'list-row__hint', style: 'padding:0 8px 4px 28px' }, definition.description),
      );
    }

    // Los errores del manifiesto se muestran junto al plugin: es donde el
    // usuario los va a buscar cuando su comando no aparezca.
    for (const error of state.errors) {
      rows.push(
        h(
          'div',
          {
            class: 'list-row__hint',
            style: 'padding:0 8px 2px 28px;color:var(--state-warning)',
          },
          error,
        ),
      );
    }

    return h('div', {}, ...rows);
  }

  store.subscribe(['plugins'], render);
  render();
  return container;
}

/* -------------------------------------------------------------------------- */
/*  Registro                                                                   */
/* -------------------------------------------------------------------------- */

export function registerPluginsView(): void {
  defineCommands([
    {
      id: 'plugins.register',
      title: 'Plugins: sincronizar los comandos',
      category: 'Plugins',
      run: (argument) => {
        const states = argument as readonly PluginState[] | undefined;
        registerPluginCommands(states ?? store.state.plugins);
      },
    },
    {
      id: 'plugins.reload',
      title: 'Plugins: recargar los manifiestos',
      category: 'Plugins',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        const result = await window.forge.plugins.reload();
        if (!result.ok) {
          toastError('No se pudieron recargar los plugins.', result.error);
          return;
        }
        store.patch({ plugins: [...result.value] });
        registerPluginCommands(result.value);

        const withErrors = result.value.filter((state) => state.errors.length > 0);
        if (withErrors.length > 0) {
          toast(
            'warn',
            `${withErrors.length} plugins tienen avisos en su manifiesto.`,
            withErrors[0]?.errors[0],
          );
          return;
        }
        toast('info', `${result.value.length} plugins cargados.`);
      },
    },
    {
      id: 'plugins.createTemplate',
      title: 'Plugins: crear .forge/plugin.ts',
      category: 'Plugins',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        const confirmed = await confirmDialog({
          title: 'Crear un plugin de ejemplo',
          message: 'Se creara .forge/plugin.ts con un manifiesto comentado.',
          detail:
            'El manifiesto es declarativo: el IDE lo lee, nunca lo ejecuta. ' +
            'Un plugin no puede hacer nada que tu no pudieras hacer desde la interfaz.',
          confirmLabel: 'Crear',
        });
        if (!confirmed) {
          return;
        }
        const result = await window.forge.plugins.createTemplate();
        if (!result.ok) {
          toastError('No se pudo crear el plugin.', result.error);
          return;
        }
        await openFile(result.value);
        toast('info', `Creado ${result.value}.`);
      },
    },
  ]);

  // Carga inicial: al abrir un workspace ya puede haber plugins.
  store.subscribe(['workspace'], () => {
    if (store.state.workspace !== null) {
      void runCommand('plugins.reload');
    }
  });
}

/** Icono de la seccion; se usa desde las preferencias. */
export const PLUGINS_ICON = ICONS.layers;
export { svgIcon };
