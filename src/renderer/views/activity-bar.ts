/** Barra de actividad: cambia la vista de la barra lateral. */

import { h, svgIcon } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store, type SidebarView } from '../core/store.js';
import { ACTIVITY_ITEMS, type ShellMounts } from '../shell.js';

export function mountActivityBar(mounts: ShellMounts): void {
  const buttons = new Map<SidebarView, HTMLButtonElement>();
  const badges = new Map<SidebarView, HTMLElement>();

  for (const item of ACTIVITY_ITEMS) {
    const button = h('button', {
      class: 'activity-btn',
      type: 'button',
      title: item.shortcut === undefined ? item.label : `${item.label} (${item.shortcut})`,
      'aria-label': item.label,
    });
    button.appendChild(svgIcon(ICONS[item.icon], 19));
    button.addEventListener('click', () => selectView(item.id));
    buttons.set(item.id, button);
    mounts.activitybar.appendChild(button);
  }

  const aiButton = h('button', {
    class: 'activity-btn',
    type: 'button',
    title: 'Forge AI (Ctrl+Shift+I)',
    'aria-label': 'Forge AI',
  });
  aiButton.appendChild(svgIcon(ICONS.ai, 19));
  aiButton.addEventListener('click', () => void runCommand('ai.toggle'));

  const settingsButton = h('button', {
    class: 'activity-btn',
    type: 'button',
    title: 'Preferencias',
    'aria-label': 'Preferencias',
  });
  settingsButton.appendChild(svgIcon(ICONS.settings, 19));
  settingsButton.addEventListener('click', () => void runCommand('settings.open'));

  mounts.activitybarBottom.append(aiButton, settingsButton);

  function selectView(view: SidebarView): void {
    const state = store.state;
    // Pulsar la vista ya activa alterna la visibilidad de la barra lateral.
    if (state.sidebarView === view && state.sidebarVisible) {
      store.patch({ sidebarVisible: false });
      return;
    }
    store.patch({ sidebarView: view, sidebarVisible: true });
  }

  /** Contador mostrado sobre el icono (cambios de Git, problemas, etc.). */
  function setBadge(view: SidebarView, count: number): void {
    const button = buttons.get(view);
    if (button === undefined) {
      return;
    }
    let badge = badges.get(view);
    if (count <= 0) {
      badge?.remove();
      badges.delete(view);
      return;
    }
    if (badge === undefined) {
      badge = h('span', { class: 'activity-btn__badge' });
      badges.set(view, badge);
      button.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : String(count);
  }

  const render = (): void => {
    const state = store.state;
    for (const [view, button] of buttons) {
      const active = state.sidebarView === view && state.sidebarVisible;
      button.dataset['active'] = String(active);
    }
    aiButton.dataset['active'] = String(state.auxVisible);
    mounts.root.dataset['sidebar'] = state.sidebarVisible ? 'visible' : 'hidden';
    mounts.root.dataset['aux'] = state.auxVisible ? 'visible' : 'hidden';

    const git = state.git;
    const gitCount =
      git === null
        ? 0
        : git.staged.length + git.unstaged.length + git.untracked.length + git.conflicted.length;
    setBadge('git', gitCount);

    const running = state.processes.filter(
      (info) => info.status === 'running' || info.status === 'ready' || info.status === 'starting',
    ).length;
    setBadge('pipelines', running);
  };

  store.subscribe(['sidebarView', 'sidebarVisible', 'auxVisible', 'git', 'processes'], render);
  render();

  defineCommands([
    ...ACTIVITY_ITEMS.map((item) => ({
      id: `sidebar.${item.id}`,
      title: `Mostrar: ${item.label}`,
      category: 'Vista',
      run: () => selectView(item.id),
    })),
    {
      id: 'view.toggleSidebar',
      title: 'Alternar la barra lateral',
      category: 'Vista',
      run: () => store.patch({ sidebarVisible: !store.state.sidebarVisible }),
    },
    {
      id: 'ai.toggle',
      title: 'Alternar Forge AI',
      category: 'Vista',
      run: () => store.patch({ auxVisible: !store.state.auxVisible }),
    },
    {
      id: 'view.toggleTheme',
      title: 'Cambiar el tema',
      category: 'Vista',
      run: async () => {
        const order = ['forge-dark', 'forge-light', 'forge-high-contrast'] as const;
        const current = store.state.settings.theme;
        const next = order[(order.indexOf(current) + 1) % order.length] ?? 'forge-dark';
        const result = await window.forge.settings.set({ theme: next });
        if (result.ok) {
          store.patch({ settings: result.value });
          document.documentElement.dataset['theme'] = next;
        }
      },
    },
  ]);
}
