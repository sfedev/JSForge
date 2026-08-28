/**
 * Puente entre los eventos del proceso principal y el store del renderer.
 *
 * Es el unico suscriptor de `window.forge.on`: cada evento se traduce a una
 * mutacion del store, y las vistas reaccionan al store. Asi ninguna vista
 * necesita conocer el protocolo IPC.
 */

import type { ForgeEvent } from '../../shared/contracts.js';
import { appendLogs, pushMetrics, store, upsertProcess } from './store.js';
import { toast } from './toasts.js';
import { runCommand } from './commands.js';

export function registerEventBridge(): () => void {
  return window.forge.on((event: ForgeEvent) => {
    switch (event.type) {
      case 'window/state':
        document.body.dataset['maximized'] = String(event.payload.maximized);
        document.body.dataset['focused'] = String(event.payload.focused);
        break;

      case 'workspace/changed':
        store.patch({
          workspace: event.payload,
          ...(event.payload === null
            ? { manifest: null, project: null, git: null, documents: [], activeDocument: null }
            : {}),
        });
        break;

      case 'fs/changed':
        // El explorador y el estado de Git se refrescan de forma agrupada.
        void runCommand('explorer.refreshQuiet');
        void runCommand('git.refreshQuiet');
        break;

      case 'dotforge/changed':
        store.patch({ manifest: event.payload });
        break;

      case 'process/state':
        upsertProcess(event.payload);
        break;

      case 'process/logs':
        appendLogs(event.payload);
        break;

      case 'lsp/state': {
        const next = store.state.lsp.filter((entry) => entry.id !== event.payload.id);
        next.push(event.payload);
        store.patch({ lsp: next });
        break;
      }

      case 'lsp/notification':
        void runCommand('lsp.handleNotification', event.payload);
        break;

      case 'ai/stream':
        void runCommand('ai.handleStream', event.payload);
        break;

      case 'git/changed':
        store.patch({ git: event.payload });
        break;

      case 'pty/data':
        void runCommand('terminal.handleData', event.payload);
        break;

      case 'pty/exit':
        void runCommand('terminal.handleExit', event.payload);
        break;

      case 'metrics/sample':
        pushMetrics(event.payload);
        break;

      case 'updater/state':
        store.patch({ updater: event.payload });
        break;

      case 'docker/changed':
        void runCommand('services.handleContainers', event.payload);
        break;

      case 'ui/command':
        void runCommand(event.payload.command, event.payload.args);
        break;

      case 'notification':
        toast(event.payload.level, event.payload.message, event.payload.detail);
        break;

      default: {
        // Union exhaustiva: si se anade un evento nuevo, esto deja de compilar.
        const unreachable: never = event;
        console.warn('[forge] evento no manejado', unreachable);
      }
    }
  });
}
