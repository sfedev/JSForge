/**
 * Punto de entrada del renderer.
 *
 * El renderer se ejecuta con `contextIsolation` y `sandbox` activos: no hay
 * `require`, ni `process`, ni acceso a Node. Todo pasa por `window.forge`.
 */

import { buildShell, type ShellMounts } from './shell.js';
import { store } from './core/store.js';
import { mountToasts, toast } from './core/toasts.js';
import { query } from './core/dom.js';
import { registerEventBridge } from './core/event-bridge.js';
import { mountActivityBar } from './views/activity-bar.js';
import { mountStatusBar } from './views/status-bar.js';
import { mountTitleBar } from './views/title-bar.js';
import { mountSidebar } from './views/sidebar.js';
import { mountPanel } from './views/panel.js';
import { mountEditorArea } from './views/editor-area.js';
import { mountAiPanel } from './views/ai-panel.js';
import { registerCommands, runCommand } from './core/commands.js';
import { mountCommandPalette } from './views/command-palette.js';
import { registerKeybindings } from './core/keybindings.js';

async function boot(): Promise<void> {
  const root = query<HTMLElement>('#forge-root');

  // Preferencias primero: el tema debe aplicarse antes del primer pintado.
  const settingsResult = await window.forge.settings.get();
  if (settingsResult.ok) {
    store.patch({ settings: settingsResult.value });
    applyTheme(settingsResult.value.theme, settingsResult.value.fontFamily, settingsResult.value.fontSize);
  }

  const mounts: ShellMounts = buildShell(root);
  mountToasts(mounts.toasts);

  registerCommands();
  registerEventBridge();

  mountTitleBar(mounts);
  mountActivityBar(mounts);
  mountSidebar(mounts);
  mountEditorArea(mounts);
  mountPanel(mounts);
  mountAiPanel(mounts);
  mountStatusBar(mounts);
  mountCommandPalette(mounts);
  registerKeybindings();

  store.patch({ booted: true });

  // Reabre el ultimo workspace, si sigue existiendo.
  const current = await window.forge.workspace.current();
  if (current.ok && current.value !== null) {
    store.patch({ workspace: current.value });
    await runCommand('workspace.refresh');
  } else {
    const recent = await window.forge.workspace.recent();
    if (recent.ok && recent.value.length > 0) {
      const last = recent.value[0];
      if (last !== undefined) {
        const opened = await window.forge.workspace.open(last);
        if (opened.ok) {
          store.patch({ workspace: opened.value });
          await runCommand('workspace.refresh');
        }
      }
    }
  }
}

/** Aplica tema y tipografia al elemento raiz del documento. */
export function applyTheme(theme: string, fontFamily: string, fontSize: number): void {
  document.documentElement.dataset['theme'] = theme;
  document.documentElement.style.setProperty('--font-mono', fontFamily);
  document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
}

boot().catch((cause: unknown) => {
  console.error('[forge] fallo el arranque del renderer', cause);
  toast('error', 'No se pudo iniciar la interfaz.', cause instanceof Error ? cause.message : String(cause));
});
