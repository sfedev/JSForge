/**
 * Shell del IDE: construye la rejilla y expone los puntos de montaje.
 *
 * No contiene logica de dominio; cada vista se monta despues sobre el
 * elemento que le corresponde. Esto mantiene el arranque en un solo pase de
 * layout, que es lo que hace que la ventana aparezca ya dibujada.
 */

import { h, svgIcon } from './core/dom.js';
import { ICONS, type IconName } from './core/icons.js';
import type { PanelView, SidebarView } from './core/store.js';

export interface ShellMounts {
  readonly root: HTMLElement;
  readonly titlebarTitle: HTMLElement;
  readonly titlebarMenu: HTMLElement;
  readonly titlebarActions: HTMLElement;
  readonly activitybar: HTMLElement;
  readonly activitybarBottom: HTMLElement;
  readonly sidebarTitle: HTMLElement;
  readonly sidebarActions: HTMLElement;
  readonly sidebarContent: HTMLElement;
  readonly editorTabs: HTMLElement;
  readonly editorSurface: HTMLElement;
  readonly editorEmpty: HTMLElement;
  readonly center: HTMLElement;
  readonly panel: HTMLElement;
  readonly panelTabs: HTMLElement;
  readonly panelActions: HTMLElement;
  readonly panelContent: HTMLElement;
  readonly aux: HTMLElement;
  readonly statusbarLeft: HTMLElement;
  readonly statusbarRight: HTMLElement;
  readonly overlays: HTMLElement;
  readonly toasts: HTMLElement;
}

export interface ActivityItem {
  readonly id: SidebarView;
  readonly label: string;
  readonly icon: IconName;
  readonly shortcut?: string;
}

export const ACTIVITY_ITEMS: readonly ActivityItem[] = [
  { id: 'explorer', label: 'Explorador', icon: 'files', shortcut: 'Ctrl+Shift+E' },
  { id: 'search', label: 'Buscar', icon: 'search', shortcut: 'Ctrl+Shift+F' },
  { id: 'git', label: 'Control de fuentes', icon: 'git', shortcut: 'Ctrl+Shift+G' },
  { id: 'pipelines', label: 'Pipelines DotForge', icon: 'pipeline', shortcut: 'Ctrl+Shift+P' },
  { id: 'services', label: 'Servicios y datos', icon: 'database' },
  { id: 'http', label: 'Cliente HTTP', icon: 'http' },
  { id: 'metrics', label: 'Metricas', icon: 'metrics' },
  { id: 'debug', label: 'Depuracion', icon: 'debug', shortcut: 'Ctrl+Shift+D' },
  { id: 'spec', label: 'Contratos y API', icon: 'contract' },
  { id: 'testing', label: 'Pruebas', icon: 'flask', shortcut: 'Ctrl+Shift+T' },
  { id: 'vault', label: 'Entorno y secretos', icon: 'lock' },
];

export const PANEL_ITEMS: readonly { id: PanelView; label: string }[] = [
  { id: 'output', label: 'Salida' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'problems', label: 'Problemas' },
  { id: 'http', label: 'Respuesta HTTP' },
  { id: 'metrics', label: 'Metricas' },
  { id: 'debug', label: 'Depuracion' },
  { id: 'spec', label: 'Contratos' },
  { id: 'testing', label: 'Pruebas' },
];

function iconButton(
  className: string,
  icon: IconName,
  label: string,
  attributes: Record<string, string> = {},
): HTMLButtonElement {
  const button = h('button', { class: className, type: 'button', title: label, 'aria-label': label, ...attributes });
  button.appendChild(svgIcon(ICONS[icon]));
  return button;
}

export function buildShell(root: HTMLElement): ShellMounts {
  const titlebarTitle = h('div', { class: 'titlebar__title' }, 'ForgeJS IDE');
  const titlebarMenu = h('div', { class: 'titlebar__menu' });
  const titlebarActions = h('div', { class: 'titlebar__actions' });

  const brand = h(
    'div',
    { class: 'titlebar__brand' },
    (() => {
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mark.setAttribute('viewBox', '0 0 24 24');
      mark.setAttribute('width', '16');
      mark.setAttribute('height', '16');
      mark.setAttribute('fill', 'none');
      mark.setAttribute('stroke', 'currentColor');
      mark.setAttribute('stroke-width', '2');
      mark.setAttribute('stroke-linejoin', 'round');
      mark.setAttribute('aria-hidden', 'true');
      const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      triangle.setAttribute('d', 'M4 20L12 4l8 16z');
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      bar.setAttribute('d', 'M8.5 15h7');
      mark.append(triangle, bar);
      return mark;
    })(),
    'ForgeJS',
  );

  const titlebar = h('header', { class: 'titlebar' }, brand, titlebarMenu, titlebarTitle, titlebarActions);

  /* --- Barra de actividad --- */
  const activitybar = h('nav', { class: 'activitybar', 'aria-label': 'Vistas principales' });
  const activitybarBottom = h('div', { class: 'activitybar__bottom' });
  activitybar.append(h('div', { class: 'activitybar__top' }), h('div', { class: 'activitybar__spacer' }), activitybarBottom);

  /* --- Barra lateral --- */
  const sidebarTitle = h('span', {}, 'Explorador');
  const sidebarActions = h('div', { class: 'sidebar__header-actions' });
  const sidebarContent = h('div', { class: 'sidebar__content' });
  const sidebar = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Barra lateral' },
    h('div', { class: 'sidebar__header' }, sidebarTitle, sidebarActions),
    sidebarContent,
  );

  /* --- Editor --- */
  const editorTabs = h('div', { class: 'editor-area__tabs', role: 'tablist' });
  const editorMonaco = h('div', { class: 'editor-area__monaco' });
  // El contenido lo rellena `editor-area` al montarse, porque necesita
  // lanzar comandos y reaccionar a si hay carpeta abierta o no.
  const editorEmpty = h('div', { class: 'editor-area__empty' });
  const editorSurface = h('div', { class: 'editor-area__surface' }, editorMonaco, editorEmpty);
  const editorArea = h('section', { class: 'editor-area' }, editorTabs, editorSurface);

  /* --- Panel inferior --- */
  const panelTabs = h('div', { class: 'panel__tabs', role: 'tablist' });
  const panelActions = h('div', { class: 'panel__actions' });
  const panelContent = h('div', { class: 'panel__content' });
  const panelResizer = h('div', { class: 'panel__resizer', 'data-role': 'panel-resizer' });
  panelTabs.append(h('div', { class: 'panel__spacer' }), panelActions);
  const panel = h(
    'section',
    { class: 'panel', 'aria-label': 'Panel inferior' },
    panelResizer,
    panelTabs,
    panelContent,
  );

  const center = h('div', { class: 'center', 'data-panel': 'visible' }, editorArea, panel);

  /* --- Panel auxiliar (Forge AI) --- */
  const aux = h('aside', { class: 'aux', 'aria-label': 'Forge AI' });

  const body = h('div', { class: 'shell__body' }, activitybar, sidebar, center, aux);

  /* --- Barra de estado --- */
  const statusbarLeft = h('div', { class: 'statusbar__left', style: 'display:flex;gap:2px;align-items:center' });
  const statusbarRight = h('div', { class: 'statusbar__right', style: 'display:flex;gap:2px;align-items:center' });
  const statusbar = h(
    'footer',
    { class: 'statusbar' },
    statusbarLeft,
    h('div', { class: 'statusbar__spacer' }),
    statusbarRight,
  );

  const shell = h('div', { class: 'shell', 'data-sidebar': 'visible', 'data-aux': 'visible' }, titlebar, body, statusbar);

  const overlays = h('div', { class: 'overlays' });
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });

  root.dataset['booting'] = 'false';
  root.replaceChildren(shell, overlays, toasts);

  return {
    root: shell,
    titlebarTitle,
    titlebarMenu,
    titlebarActions,
    activitybar: activitybar.firstElementChild as HTMLElement,
    activitybarBottom,
    sidebarTitle,
    sidebarActions,
    sidebarContent,
    editorTabs,
    editorSurface: editorMonaco,
    editorEmpty,
    center,
    panel,
    panelTabs,
    panelActions,
    panelContent,
    aux,
    statusbarLeft,
    statusbarRight,
    overlays,
    toasts,
  };
}

export { iconButton };
