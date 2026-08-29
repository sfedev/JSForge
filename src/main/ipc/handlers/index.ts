/**
 * Punto unico de registro de manejadores IPC.
 *
 * Se invoca una sola vez tras `app.whenReady()` y antes de crear la ventana,
 * de modo que el renderer nunca encuentre un canal sin manejador.
 */

import { registerAiHandlers } from './ai-handlers.js';
import { registerCoreHandlers } from './core-handlers.js';
import { registerDebugHandlers } from './debug-handlers.js';
import { registerDotForgeHandlers } from './dotforge-handlers.js';
import { registerFsHandlers } from './fs-handlers.js';
import { registerGitHandlers } from './git-handlers.js';
import { registerLspHandlers } from './lsp-handlers.js';
import { registerPluginHandlers } from './plugin-handlers.js';
import { registerSpecHandlers } from './spec-handlers.js';
import { registerTerminalHandlers } from './terminal-handlers.js';
import { registerTestHandlers } from './test-handlers.js';
import { registerToolsHandlers } from './tools-handlers.js';
import { registerVaultHandlers } from './vault-handlers.js';

export function registerAllHandlers(): void {
  registerCoreHandlers();
  registerFsHandlers();
  registerDotForgeHandlers();
  registerGitHandlers();
  registerLspHandlers();
  registerAiHandlers();
  registerTerminalHandlers();
  registerToolsHandlers();
  registerDebugHandlers();
  registerSpecHandlers();
  registerTestHandlers();
  registerVaultHandlers();
  registerPluginHandlers();
}
