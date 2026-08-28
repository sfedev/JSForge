/**
 * ForgeJS IDE — proceso principal.
 *
 * Responsabilidades, en este orden estricto:
 *  1. Instancia unica y flags de seguridad del proceso.
 *  2. Registro del esquema privilegiado `forge://` (antes de `whenReady`).
 *  3. Endurecimiento de la sesion por defecto (CSP, permisos, red).
 *  4. Registro de los manejadores IPC.
 *  5. Creacion de la ventana y arranque de servicios en segundo plano.
 *  6. Apagado ordenado: procesos hijos, servidores LSP y PTY.
 */

import { app, session } from 'electron';
import path from 'node:path';

import { setTrustedContents, disposeAll, missingChannels } from './ipc/registry.js';
import { unbindEventTarget } from './ipc/event-bus.js';
import { registerAllHandlers } from './ipc/handlers/index.js';
import { APP_ORIGIN, registerAppProtocol, registerAppScheme } from './security/app-protocol.js';
import { applySessionHardening } from './security/window-hardening.js';
import { getSettings } from './services/settings-service.js';
import { closeWorkspace, setChangeThrottle } from './services/workspace-service.js';
import { disposeAllProcesses } from './services/process/process-manager.js';
import { stopAllServers } from './services/lsp/lsp-manager.js';
import { cancelAllChats } from './services/ai/ai-service.js';
import { disposeAllSessions } from './services/terminal/pty-service.js';
import { disposeMetrics } from './services/metrics/metrics-service.js';
import { cancelAllRequests } from './services/http/http-client.js';
import { initializeUpdater } from './services/updater/updater-service.js';
import { createMainWindow, getMainWindow } from './window.js';

/** Directorio del bundle del renderer servido por `forge://app`. */
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');

/* -------------------------------------------------------------------------- */
/*  1. Instancia unica y flags del proceso                                     */
/* -------------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = getMainWindow();
    if (window !== null) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });

  bootstrap();
}

function bootstrap(): void {
  // Sin cache de disco para codigo remoto: el IDE no carga nada remoto.
  app.enableSandbox();
  app.setAppUserModelId('dev.dotforge.forgejs-ide');

  /* 2. El esquema debe declararse antes de que Chromium se inicialice. */
  registerAppScheme();

  app.on('web-contents-created', (_event, contents) => {
    // Cualquier `webContents` inesperado (devtools extension, etc.) queda
    // sin permisos de navegacion.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  app.whenReady().then(onReady).catch((cause: unknown) => {
    console.error('[forge] fallo el arranque', cause);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (getMainWindow() === null) {
      createMainWindow();
    }
  });

  app.on('before-quit', shutdown);
}

async function onReady(): Promise<void> {
  /* 3. Endurecimiento de la sesion por defecto. */
  applySessionHardening(session.defaultSession);
  registerAppProtocol(RENDERER_ROOT);

  /* 4. Manejadores IPC. */
  registerAllHandlers();

  const settings = getSettings();
  setChangeThrottle(settings.logThrottleMs);
  initializeUpdater();

  /* 5. Ventana. */
  const window = createMainWindow();
  setTrustedContents(window.webContents);

  if (!app.isPackaged) {
    const pending = missingChannels();
    if (pending.length > 0) {
      console.warn(
        `[forge] ${pending.length} canales IPC declarados sin manejador:\n  ${pending.join('\n  ')}`,
      );
    }
    console.info(`[forge] renderer servido desde ${APP_ORIGIN} (${RENDERER_ROOT})`);
  }
}

let shuttingDown = false;

/* 6. Apagado ordenado. */
function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    disposeAllProcesses();
    void stopAllServers();
    cancelAllChats();
    disposeAllSessions();
    disposeMetrics();
    cancelAllRequests();
    closeWorkspace();
  } catch (cause) {
    console.error('[forge] fallo al cerrar el workspace', cause);
  }
  unbindEventTarget();
  disposeAll();
}
