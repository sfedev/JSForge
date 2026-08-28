/**
 * Barra de estado.
 *
 * Muestra rama de Git, estado de los servidores de lenguaje, procesos vivos,
 * posicion del cursor y el aviso no intrusivo de actualizacion disponible.
 */

import { h, svgIcon } from '../core/dom.js';
import { ICONS, type IconName } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import type { ShellMounts } from '../shell.js';

interface StatusItemOptions {
  readonly icon?: IconName;
  readonly title: string;
  readonly commandId?: string;
  readonly tone?: 'accent' | 'error' | 'warning';
}

function statusItem(options: StatusItemOptions): {
  element: HTMLButtonElement;
  setText(text: string): void;
  setTone(tone?: 'accent' | 'error' | 'warning'): void;
  setVisible(visible: boolean): void;
} {
  const label = h('span', {});
  const element = h('button', {
    class: 'chrome-btn',
    type: 'button',
    title: options.title,
    'aria-label': options.title,
  });
  if (options.icon !== undefined) {
    element.appendChild(svgIcon(ICONS[options.icon], 13));
  }
  element.appendChild(label);
  if (options.tone !== undefined) {
    element.dataset['tone'] = options.tone;
  }
  if (options.commandId !== undefined) {
    element.addEventListener('click', () => void runCommand(options.commandId as string));
  }
  return {
    element,
    setText: (text: string) => {
      label.textContent = text;
    },
    setTone: (tone) => {
      if (tone === undefined) {
        delete element.dataset['tone'];
      } else {
        element.dataset['tone'] = tone;
      }
    },
    setVisible: (visible: boolean) => {
      element.style.display = visible ? '' : 'none';
    },
  };
}

/** Posicion del cursor publicada por el area de edicion. */
let cursorText = '';
const cursorListeners = new Set<(text: string) => void>();

export function setCursorStatus(line: number, column: number, selection: number): void {
  cursorText =
    selection > 0
      ? `Ln ${line}, Col ${column} (${selection} sel.)`
      : `Ln ${line}, Col ${column}`;
  for (const listener of cursorListeners) {
    listener(cursorText);
  }
}

export function mountStatusBar(mounts: ShellMounts): void {
  const branch = statusItem({ icon: 'branch', title: 'Rama actual — clic para cambiar', commandId: 'git.switchBranch' });
  const sync = statusItem({ icon: 'refresh', title: 'Cambios pendientes', commandId: 'sidebar.git' });
  const processes = statusItem({ icon: 'run', title: 'Procesos en ejecucion', commandId: 'panel.output' });
  const problems = statusItem({ icon: 'warning', title: 'Problemas del proyecto', commandId: 'panel.problems' });
  mounts.statusbarLeft.append(branch.element, sync.element, processes.element, problems.element);

  const lsp = statusItem({ icon: 'layers', title: 'Servidores de lenguaje', commandId: 'lsp.showStatus' });
  const cursor = statusItem({ title: 'Posicion del cursor', commandId: 'editor.goToLine' });
  const encoding = statusItem({ title: 'Fin de linea del documento activo' });
  const language = statusItem({ title: 'Lenguaje del documento activo' });
  const update = statusItem({ icon: 'download', title: 'Actualizacion disponible', commandId: 'updater.show', tone: 'accent' });
  mounts.statusbarRight.append(lsp.element, cursor.element, encoding.element, language.element, update.element);

  cursorListeners.add((text) => cursor.setText(text));
  cursor.setText('Ln 1, Col 1');

  const render = (): void => {
    const state = store.state;

    const git = state.git;
    if (git === null || !git.isRepo) {
      branch.setVisible(false);
      sync.setVisible(false);
    } else {
      branch.setVisible(true);
      branch.setText(git.detached ? `${git.branch ?? 'HEAD'} (separada)` : (git.branch ?? 'HEAD'));
      const pending =
        git.staged.length + git.unstaged.length + git.untracked.length + git.conflicted.length;
      sync.setVisible(true);
      const arrows = [
        git.behind > 0 ? `↓${git.behind}` : '',
        git.ahead > 0 ? `↑${git.ahead}` : '',
      ]
        .filter((part) => part !== '')
        .join(' ');
      sync.setText(arrows === '' ? `${pending} cambios` : `${arrows} · ${pending} cambios`);
      sync.setTone(git.conflicted.length > 0 ? 'error' : undefined);
    }

    const running = state.processes.filter(
      (info) => info.status === 'running' || info.status === 'ready' || info.status === 'starting',
    );
    processes.setVisible(running.length > 0);
    processes.setText(`${running.length} en ejecucion`);

    const failed = state.processes.filter((info) => info.status === 'failed').length;
    problems.setVisible(failed > 0);
    problems.setText(`${failed} con error`);
    problems.setTone(failed > 0 ? 'error' : undefined);

    const servers = state.lsp.filter((entry) => entry.status === 'running');
    const failing = state.lsp.filter((entry) => entry.status === 'failed');
    lsp.setVisible(state.lsp.length > 0);
    lsp.setText(
      failing.length > 0 ? `LSP ${servers.length}/${state.lsp.length}` : `LSP ${servers.length}`,
    );
    lsp.setTone(failing.length > 0 ? 'warning' : undefined);

    const document = state.documents.find((entry) => entry.path === state.activeDocument);
    encoding.setVisible(document !== undefined);
    language.setVisible(document !== undefined);
    if (document !== undefined) {
      encoding.setText(`UTF-8${document.bom ? ' con BOM' : ''} · ${document.eol.toUpperCase()}`);
      language.setText(document.languageId);
    }

    const updater = state.updater;
    const hasUpdate =
      updater !== null && (updater.phase === 'available' || updater.phase === 'ready');
    update.setVisible(hasUpdate);
    if (updater !== null && hasUpdate) {
      update.setText(
        updater.phase === 'ready'
          ? `Reiniciar para actualizar a ${updater.available?.version ?? ''}`
          : `Actualizacion ${updater.available?.version ?? ''} disponible`,
      );
    }
  };

  store.subscribe(
    ['git', 'processes', 'lsp', 'documents', 'activeDocument', 'updater'],
    render,
  );
  render();

  defineCommands([
    {
      id: 'lsp.showStatus',
      title: 'Mostrar el estado de los servidores de lenguaje',
      category: 'Lenguaje',
      run: () => void runCommand('palette.open', 'LSP '),
    },
  ]);
}
