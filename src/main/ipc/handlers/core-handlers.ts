/**
 * Manejadores IPC del nucleo: aplicacion, ventana, workspace y preferencias.
 */

import { app, dialog, shell } from 'electron';

import {
  IPC,
  fail,
  ok,
  type AppInfo,
  type ForgeSettings,
  type WindowState,
  type WorkspaceInfo,
} from '../../../shared/contracts.js';
import { isSafeExternalUrl } from '../../security/window-hardening.js';
import {
  getSettings,
  pushRecentWorkspace,
  setSettings,
} from '../../services/settings-service.js';
import {
  closeWorkspace,
  getWorkspace,
  openWorkspace,
  setChangeThrottle,
  startWatching,
  stopWatching,
} from '../../services/workspace-service.js';
import { getMainWindow, windowState } from '../../window.js';
import { handle } from '../registry.js';

export function registerCoreHandlers(): void {
  /* ---------------------------------------------------------------------- */
  /*  Aplicacion                                                            */
  /* ---------------------------------------------------------------------- */

  handle<[], AppInfo>(IPC.APP_INFO, () =>
    ok({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? 'desconocida',
      chrome: process.versions.chrome ?? 'desconocida',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      userDataPath: app.getPath('userData'),
    }),
  );

  handle<[string], true>(IPC.APP_OPEN_EXTERNAL, async (url) => {
    if (typeof url !== 'string' || !isSafeExternalUrl(url)) {
      return fail('E_INVALID_ARGUMENT', 'Solo se permiten enlaces http, https o mailto.');
    }
    await shell.openExternal(url);
    return ok(true);
  });

  /* ---------------------------------------------------------------------- */
  /*  Ventana                                                               */
  /* ---------------------------------------------------------------------- */

  handle<[], true>(IPC.WINDOW_MINIMIZE, () => {
    getMainWindow()?.minimize();
    return ok(true);
  });

  handle<[], true>(IPC.WINDOW_TOGGLE_MAXIMIZE, () => {
    const window = getMainWindow();
    if (window === null) {
      return ok(true);
    }
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return ok(true);
  });

  handle<[], true>(IPC.WINDOW_CLOSE, () => {
    getMainWindow()?.close();
    return ok(true);
  });

  handle<[], WindowState>(IPC.WINDOW_STATE, () => ok(windowState()));

  /* ---------------------------------------------------------------------- */
  /*  Workspace                                                             */
  /* ---------------------------------------------------------------------- */

  handle<[], WorkspaceInfo | null>(IPC.WORKSPACE_PICK, async () => {
    const window = getMainWindow();
    const options = {
      title: 'Abrir carpeta de proyecto',
      properties: ['openDirectory', 'createDirectory'] as const,
    };
    const result =
      window === null
        ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
        : await dialog.showOpenDialog(window, {
            ...options,
            properties: [...options.properties],
          });
    const picked = result.filePaths[0];
    if (result.canceled || picked === undefined) {
      return ok(null);
    }
    const info = openWorkspace(picked);
    pushRecentWorkspace(info.root);
    startWatching();
    return ok(info);
  });

  handle<[string], WorkspaceInfo>(IPC.WORKSPACE_OPEN, (absolutePath) => {
    const info = openWorkspace(absolutePath);
    pushRecentWorkspace(info.root);
    startWatching();
    return ok(info);
  });

  handle<[], true>(IPC.WORKSPACE_CLOSE, () => {
    closeWorkspace();
    return ok(true);
  });

  handle<[], WorkspaceInfo | null>(IPC.WORKSPACE_CURRENT, () => ok(getWorkspace()));

  handle<[], readonly string[]>(IPC.WORKSPACE_RECENT, () =>
    ok(getSettings().recentWorkspaces),
  );

  /**
   * Selector de carpeta sin efectos secundarios: no abre el workspace ni
   * toca el historial reciente. El asistente de scaffolding lo necesita para
   * elegir el destino de un proyecto nuevo sin cambiar el proyecto abierto.
   */
  handle<[string | null], string | null>(IPC.DIALOG_PICK_DIRECTORY, async (title) => {
    const window = getMainWindow();
    const options = {
      title: typeof title === 'string' && title !== '' ? title : 'Elegir carpeta',
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    const picked = result.filePaths[0];
    return ok(result.canceled || picked === undefined ? null : picked);
  });

  /* ---------------------------------------------------------------------- */
  /*  Preferencias                                                          */
  /* ---------------------------------------------------------------------- */

  handle<[], ForgeSettings>(IPC.SETTINGS_GET, () => ok(getSettings()));

  handle<[Partial<ForgeSettings>], ForgeSettings>(IPC.SETTINGS_SET, (patch) => {
    const next = setSettings(patch);
    setChangeThrottle(next.logThrottleMs);
    return ok(next);
  });

  /* ---------------------------------------------------------------------- */
  /*  Vigilancia del arbol                                                  */
  /* ---------------------------------------------------------------------- */

  handle<[], true>(IPC.FS_WATCH_START, () => {
    startWatching();
    return ok(true);
  });

  handle<[], true>(IPC.FS_WATCH_STOP, () => {
    stopWatching();
    return ok(true);
  });
}
