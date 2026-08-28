/**
 * Creacion de la ventana principal.
 *
 * `webPreferences` fija las tres garantias no negociables del renderer:
 * `contextIsolation: true`, `nodeIntegration: false` y `sandbox: true`.
 * Con sandbox activo el preload se ejecuta en un contexto restringido y solo
 * puede usar `contextBridge` e `ipcRenderer`, que es exactamente lo que
 * necesita el puente.
 */

import { BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';

import type { WindowState } from '../shared/contracts.js';
import { APP_INDEX_URL } from './security/app-protocol.js';
import { applyWindowHardening } from './security/window-hardening.js';
import { bindEventTarget, emit, unbindEventTarget } from './ipc/event-bus.js';

const MIN_WIDTH = 940;
const MIN_HEIGHT = 620;

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function windowState(): WindowState {
  const window = getMainWindow();
  if (window === null) {
    return { maximized: false, fullScreen: false, focused: false };
  }
  return {
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    focused: window.isFocused(),
  };
}

function pushState(): void {
  emit({ type: 'window/state', payload: windowState() });
}

export function createMainWindow(): BrowserWindow {
  const existing = getMainWindow();
  if (existing !== null) {
    existing.focus();
    return existing;
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0f16' : '#f6f7fb',
    // Barra de titulo propia: el shell del IDE dibuja sus controles.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: {
            color: '#0d0f16',
            symbolColor: '#c9cee0',
            height: 34,
          },
        }
      : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      // El renderer no necesita spellcheck y ahorra memoria residente.
      spellcheck: false,
      // Mantiene la UI viva cuando la ventana esta en segundo plano
      // (los logs y el streaming de IA siguen pintandose).
      backgroundThrottling: false,
    },
  });

  applyWindowHardening(window);
  bindEventTarget(window);

  window.once('ready-to-show', () => {
    window.show();
    pushState();
  });

  window.on('maximize', pushState);
  window.on('unmaximize', pushState);
  window.on('enter-full-screen', pushState);
  window.on('leave-full-screen', pushState);
  window.on('focus', pushState);
  window.on('blur', pushState);

  window.on('closed', () => {
    // Desatar el bus aqui evita que el apagado ordenado intente emitir
    // eventos hacia una ventana ya destruida.
    unbindEventTarget();
    mainWindow = null;
  });

  void window.loadURL(APP_INDEX_URL);

  mainWindow = window;
  return window;
}
