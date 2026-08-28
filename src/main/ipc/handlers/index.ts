/**
 * Punto unico de registro de manejadores IPC.
 *
 * Se invoca una sola vez tras `app.whenReady()` y antes de crear la ventana,
 * de modo que el renderer nunca encuentre un canal sin manejador.
 */

import { registerCoreHandlers } from './core-handlers.js';

export function registerAllHandlers(): void {
  registerCoreHandlers();
}
