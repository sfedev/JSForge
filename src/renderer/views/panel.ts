/**
 * Panel inferior: contenedor de canales de salida, terminal, problemas,
 * respuesta HTTP y metricas.
 *
 * Igual que la barra lateral, cada vista se monta de forma perezosa. El
 * divisor superior permite redimensionar el panel arrastrando.
 */

import { h, svgIcon } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands } from '../core/commands.js';
import { store, type PanelView } from '../core/store.js';
import { PANEL_ITEMS, type ShellMounts } from '../shell.js';

export interface PanelViewContext {
  readonly container: HTMLElement;
  readonly actions: HTMLElement;
}

const factories = new Map<PanelView, (context: PanelViewContext) => void>();

export function registerPanelView(
  id: PanelView,
  factory: (context: PanelViewContext) => void,
): void {
  factories.set(id, factory);
}

const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_RATIO = 0.75;

export function mountPanel(mounts: ShellMounts): void {
  const containers = new Map<PanelView, HTMLElement>();
  const actionBars = new Map<PanelView, HTMLElement>();
  const buttons = new Map<PanelView, HTMLButtonElement>();
  const mounted = new Set<PanelView>();

  // Las pestanas se insertan antes del espaciador que ya existe.
  const spacer = mounts.panelTabs.querySelector('.panel__spacer');

  for (const item of PANEL_ITEMS) {
    const button = h(
      'button',
      { class: 'pill-tab', type: 'button', role: 'tab' },
      h('span', {}, item.label),
    );
    button.addEventListener('click', () => selectView(item.id));
    buttons.set(item.id, button);
    mounts.panelTabs.insertBefore(button, spacer);

    const container = h('div', { class: 'panel__view', 'data-active': 'false' });
    const actions = h('div', { style: 'display:none;gap:2px;align-items:center' });
    containers.set(item.id, container);
    actionBars.set(item.id, actions);
    mounts.panelContent.appendChild(container);
    mounts.panelActions.appendChild(actions);
  }

  const collapse = h('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': 'Ocultar el panel',
    title: 'Ocultar el panel (Ctrl+J)',
  });
  collapse.appendChild(svgIcon(ICONS.close, 13));
  collapse.addEventListener('click', () => store.patch({ panelVisible: false }));
  mounts.panelActions.appendChild(collapse);

  function selectView(view: PanelView): void {
    const state = store.state;
    if (state.panelView === view && state.panelVisible) {
      store.patch({ panelVisible: false });
      return;
    }
    store.patch({ panelView: view, panelVisible: true });
  }

  const render = (): void => {
    const state = store.state;
    mounts.center.dataset['panel'] = state.panelVisible ? 'visible' : 'hidden';

    for (const [id, button] of buttons) {
      button.dataset['active'] = String(id === state.panelView && state.panelVisible);
    }
    for (const [id, container] of containers) {
      const isActive = id === state.panelView && state.panelVisible;
      container.dataset['active'] = String(isActive);
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
            console.error(`[forge] no se pudo montar el panel ${id}`, cause);
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

  store.subscribe(['panelView', 'panelVisible'], render);
  render();

  setupResizer(mounts);
  setupTabScrolling(mounts);

  defineCommands([
    ...PANEL_ITEMS.map((item) => ({
      id: `panel.${item.id}`,
      title: `Panel: ${item.label}`,
      category: 'Vista',
      run: () => selectView(item.id),
    })),
    {
      id: 'view.togglePanel',
      title: 'Alternar el panel inferior',
      category: 'Vista',
      run: () => store.patch({ panelVisible: !store.state.panelVisible }),
    },
  ]);
}

/**
 * La rueda del raton desplaza la fila de pestanas en horizontal.
 *
 * Con ocho pestanas, en una ventana estrecha las ultimas no caben. La fila ya
 * se desplaza, pero su barra esta oculta por diseno, asi que la unica forma
 * de llegar a ellas era `Mayus`+rueda, que casi nadie conoce. El navegador no
 * convierte el desplazamiento vertical en horizontal por su cuenta.
 */
function setupTabScrolling(mounts: ShellMounts): void {
  const tabs = mounts.panelTabs;

  tabs.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      // Si no hay nada que desplazar, se deja pasar el evento.
      if (tabs.scrollWidth <= tabs.clientWidth) {
        return;
      }
      // Un raton normal solo emite deltaY; un panel tactil puede dar ambos.
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      tabs.scrollLeft += delta;
    },
    // No es pasivo a proposito: hace falta `preventDefault` para que la
    // rueda no desplace ademas el contenedor de alrededor.
    { passive: false },
  );
}

/** Arrastre vertical del divisor superior del panel. */
function setupResizer(mounts: ShellMounts): void {
  const resizer = mounts.panel.querySelector<HTMLElement>('.panel__resizer');
  if (resizer === null) {
    return;
  }
  let startY = 0;
  let startHeight = 0;

  const onMove = (event: PointerEvent): void => {
    const delta = startY - event.clientY;
    const maximum = window.innerHeight * MAX_PANEL_RATIO;
    const next = Math.min(maximum, Math.max(MIN_PANEL_HEIGHT, startHeight + delta));
    mounts.panel.style.height = `${next}px`;
  };

  const onUp = (): void => {
    resizer.dataset['dragging'] = 'false';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startY = event.clientY;
    startHeight = mounts.panel.getBoundingClientRect().height;
    resizer.dataset['dragging'] = 'true';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
