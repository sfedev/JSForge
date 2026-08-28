/**
 * Contenedor de la barra lateral.
 *
 * Cada vista se registra con `registerSidebarView` y se monta de forma
 * perezosa la primera vez que se selecciona: abrir el IDE no construye el
 * arbol de Git ni el inspector de esquemas si el usuario no los mira.
 */

import { h } from '../core/dom.js';
import { store, type SidebarView } from '../core/store.js';
import { ACTIVITY_ITEMS, type ShellMounts } from '../shell.js';

export interface SidebarViewContext {
  /** Contenedor donde la vista pinta su contenido. */
  readonly container: HTMLElement;
  /** Zona de acciones de la cabecera (iconos a la derecha del titulo). */
  readonly actions: HTMLElement;
}

export type SidebarViewFactory = (context: SidebarViewContext) => void;

const factories = new Map<SidebarView, SidebarViewFactory>();

export function registerSidebarView(id: SidebarView, factory: SidebarViewFactory): void {
  factories.set(id, factory);
}

export function mountSidebar(mounts: ShellMounts): void {
  const containers = new Map<SidebarView, HTMLElement>();
  const actionBars = new Map<SidebarView, HTMLElement>();
  const mounted = new Set<SidebarView>();

  for (const item of ACTIVITY_ITEMS) {
    const container = h('div', { class: 'sidebar__view', style: 'display:none' });
    const actions = h('div', { style: 'display:none;gap:2px;align-items:center' });
    containers.set(item.id, container);
    actionBars.set(item.id, actions);
    mounts.sidebarContent.appendChild(container);
    mounts.sidebarActions.appendChild(actions);
  }

  const render = (): void => {
    const active = store.state.sidebarView;
    const item = ACTIVITY_ITEMS.find((entry) => entry.id === active);
    mounts.sidebarTitle.textContent = item?.label ?? '';

    for (const [id, container] of containers) {
      const isActive = id === active;
      container.style.display = isActive ? 'block' : 'none';
      const actions = actionBars.get(id);
      if (actions !== undefined) {
        actions.style.display = isActive ? 'flex' : 'none';
      }
      if (isActive && !mounted.has(id)) {
        const factory = factories.get(id);
        if (factory !== undefined) {
          mounted.add(id);
          try {
            factory({ container, actions: actions ?? container });
          } catch (cause) {
            console.error(`[forge] no se pudo montar la vista ${id}`, cause);
            container.replaceChildren(
              h('div', { class: 'empty-note' }, 'Esta vista no se pudo cargar.'),
            );
          }
        } else {
          container.replaceChildren(
            h('div', { class: 'empty-note' }, 'Vista no disponible en esta version.'),
          );
        }
      }
    }
  };

  store.subscribe(['sidebarView'], render);
  render();
}
