/** Manejadores IPC del motor de plugins. */

import {
  IPC,
  ok,
  type PluginRunResult,
  type PluginState,
} from '../../../shared/contracts.js';
import {
  createPluginTemplate,
  listPlugins,
  reloadPlugins,
  runPluginCommand,
  setPluginEnabled,
} from '../../services/plugins/plugin-service.js';
import { handle } from '../registry.js';

export function registerPluginHandlers(): void {
  handle<[], readonly PluginState[]>(IPC.PLUGIN_LIST, () => ok(listPlugins()));

  handle<[], readonly PluginState[]>(IPC.PLUGIN_RELOAD, async () => ok(await reloadPlugins()));

  handle<[string], PluginRunResult>(IPC.PLUGIN_RUN, async (commandId) =>
    ok(await runPluginCommand(commandId)),
  );

  handle<[string, boolean], readonly PluginState[]>(
    IPC.PLUGIN_SET_ENABLED,
    (pluginId, enabled) => ok(setPluginEnabled(pluginId, enabled === true)),
  );

  handle<[], string>(IPC.PLUGIN_SCAFFOLD_TEMPLATE, async () => ok(await createPluginTemplate()));
}
