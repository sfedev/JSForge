/** Barra de titulo: menu compacto, titulo del workspace y controles de ventana. */

import { h, svgIcon } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toastError } from '../core/toasts.js';
import type { ShellMounts } from '../shell.js';

const MENU: readonly { label: string; commandId: string }[] = [
  { label: 'Archivo', commandId: 'menu.file' },
  { label: 'Ver', commandId: 'menu.view' },
  { label: 'Ejecutar', commandId: 'menu.run' },
  { label: 'Ayuda', commandId: 'menu.help' },
];

export function mountTitleBar(mounts: ShellMounts): void {
  for (const entry of MENU) {
    const button = h('button', { class: 'chrome-btn', type: 'button' }, entry.label);
    button.addEventListener('click', () => void runCommand(entry.commandId));
    mounts.titlebarMenu.appendChild(button);
  }

  const paletteButton = h(
    'button',
    { class: 'chrome-btn', type: 'button', title: 'Paleta de comandos (Ctrl+Shift+P)' },
  );
  paletteButton.append(svgIcon(ICONS.search, 13), 'Comandos');
  paletteButton.addEventListener('click', () => void runCommand('palette.open'));
  mounts.titlebarActions.appendChild(paletteButton);

  // En Windows y Linux la ventana usa `titleBarOverlay`/`hidden`; los
  // controles nativos se dibujan encima a la derecha, por eso aqui solo se
  // anaden controles propios en macOS, donde el semaforo va a la izquierda.
  if (navigator.platform.toLowerCase().includes('mac')) {
    const minimize = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Minimizar' });
    minimize.appendChild(svgIcon(ICONS.minus, 14));
    minimize.addEventListener('click', () => void window.forge.window.minimize());

    const maximize = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Maximizar' });
    maximize.appendChild(svgIcon(ICONS.split, 13));
    maximize.addEventListener('click', () => void window.forge.window.toggleMaximize());

    mounts.titlebarActions.append(minimize, maximize);
  }

  const render = (): void => {
    const workspace = store.state.workspace;
    const active = store.state.activeDocument;
    const parts: string[] = [];
    if (active !== null) {
      parts.push(active);
    }
    parts.push(workspace === null ? 'Sin carpeta abierta' : workspace.name);
    parts.push('ForgeJS IDE');
    mounts.titlebarTitle.textContent = parts.join(' — ');
    document.title = parts.join(' — ');
  };

  store.subscribe(['workspace', 'activeDocument'], render);
  render();

  defineCommands([
    {
      id: 'workspace.open',
      title: 'Abrir carpeta…',
      category: 'Archivo',
      run: async () => {
        const result = await window.forge.workspace.pick();
        if (!result.ok) {
          toastError('No se pudo abrir la carpeta.', result.error);
          return;
        }
        if (result.value !== null) {
          store.patch({ workspace: result.value });
          await runCommand('workspace.refresh');
        }
      },
    },
    {
      id: 'workspace.close',
      title: 'Cerrar carpeta',
      category: 'Archivo',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        await window.forge.workspace.close();
        store.patch({
          workspace: null,
          manifest: null,
          project: null,
          git: null,
          documents: [],
          activeDocument: null,
        });
      },
    },
    {
      id: 'menu.file',
      title: 'Menu: Archivo',
      category: 'Menu',
      run: () => void runCommand('palette.open', 'Archivo '),
    },
    {
      id: 'menu.view',
      title: 'Menu: Ver',
      category: 'Menu',
      run: () => void runCommand('palette.open', 'Vista '),
    },
    {
      id: 'menu.run',
      title: 'Menu: Ejecutar',
      category: 'Menu',
      run: () => void runCommand('palette.open', 'Ejecutar '),
    },
    {
      id: 'menu.help',
      title: 'Menu: Ayuda',
      category: 'Menu',
      run: () => void runCommand('app.about'),
    },
  ]);
}
