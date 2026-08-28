/**
 * Servicios y datos.
 *
 * Reune los servicios de docker-compose (levantar y detener), los
 * contenedores en ejecucion y el inspector visual del esquema declarado
 * (Prisma, TypeORM o Drizzle).
 */

import { h, svgIcon } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import type {
  ComposeFileView,
  ContainerInfo,
  DbSchemaView,
  DotForgeServiceKind,
} from '../../shared/contracts.js';

let container: HTMLElement;
let compose: ComposeFileView | null = null;
let containers: readonly ContainerInfo[] = [];
let schema: DbSchemaView | null = null;
let dockerAvailable = false;

const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

const KIND_LABEL: Readonly<Record<DotForgeServiceKind, string>> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mongo: 'MongoDB',
  redis: 'Redis',
  mailhog: 'Correo de pruebas',
  other: 'Servicio',
};

export function registerServicesView(): void {
  registerSidebarView('services', mount);

  defineCommands([
    {
      id: 'services.refresh',
      title: 'Servicios: actualizar',
      category: 'Servicios',
      run: () => refresh(),
    },
    {
      id: 'services.handleContainers',
      title: 'Servicios: recibir contenedores',
      category: 'Servicios',
      run: (argument) => {
        containers = (argument as readonly ContainerInfo[]) ?? [];
        render();
      },
    },
    {
      id: 'services.upAll',
      title: 'Servicios: levantar todos',
      category: 'Servicios',
      enabled: () => compose !== null,
      run: () => composeAction('up', []),
    },
    {
      id: 'services.downAll',
      title: 'Servicios: detener todos',
      category: 'Servicios',
      enabled: () => compose !== null,
      run: () => composeAction('down', []),
    },
  ]);
}

function mount(context: SidebarViewContext): void {
  container = h('div', {});
  context.container.replaceChildren(container);

  const actions: [string, keyof typeof ICONS, string][] = [
    ['services.upAll', 'run', 'Levantar todos los servicios'],
    ['services.downAll', 'stop', 'Detener todos los servicios'],
    ['services.refresh', 'refresh', 'Actualizar'],
  ];
  for (const [commandId, icon, label] of actions) {
    const button = h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label });
    button.appendChild(svgIcon(ICONS[icon], 13));
    button.addEventListener('click', () => void runCommand(commandId));
    context.actions.appendChild(button);
  }

  store.subscribe(['workspace'], () => void refresh());
  void refresh();
  render();
}

async function refresh(): Promise<void> {
  if (store.state.workspace === null) {
    compose = null;
    containers = [];
    schema = null;
    render();
    return;
  }

  const available = await window.forge.docker.available();
  dockerAvailable = available.ok && available.value;

  compose = null;
  for (const candidate of COMPOSE_CANDIDATES) {
    const parsed = await window.forge.docker.parseCompose(candidate);
    if (parsed.ok && parsed.value.services.length > 0) {
      compose = parsed.value;
      break;
    }
  }

  if (dockerAvailable) {
    const list = await window.forge.docker.ps();
    containers = list.ok ? list.value : [];
  } else {
    containers = [];
  }

  const inspected = await window.forge.db.schema();
  schema = inspected.ok ? inspected.value : null;

  render();
}

async function composeAction(action: 'up' | 'down', services: readonly string[]): Promise<void> {
  if (compose === null) {
    return;
  }
  if (!dockerAvailable) {
    toast('warn', 'Docker no esta disponible en este sistema.');
    return;
  }
  const result =
    action === 'up'
      ? await window.forge.docker.up(compose.path, services)
      : await window.forge.docker.down(compose.path, services);

  if (!result.ok) {
    toastError(
      action === 'up' ? 'No se pudieron levantar los servicios.' : 'No se pudieron detener los servicios.',
      result.error,
    );
    return;
  }
  toast('info', action === 'up' ? 'Servicios levantados.' : 'Servicios detenidos.');
  await refresh();
}

/** Estado del contenedor asociado a un servicio de compose, si existe. */
function containerFor(serviceName: string): ContainerInfo | undefined {
  return containers.find(
    (entry) => entry.name === serviceName || entry.name.includes(`-${serviceName}-`) || entry.name.endsWith(`_${serviceName}_1`),
  );
}

function section(title: string, count: number, body: HTMLElement, collapsed = false): HTMLElement {
  const element = h('div', { class: 'section', 'data-collapsed': String(collapsed) });
  const header = h('div', { class: 'section__header' }, title);
  header.appendChild(h('span', { class: 'section__count' }, String(count)));
  header.addEventListener('click', () => {
    element.dataset['collapsed'] = element.dataset['collapsed'] === 'true' ? 'false' : 'true';
  });
  element.append(header, h('div', { class: 'section__body' }, body));
  return element;
}

function render(): void {
  if (container === undefined) {
    return;
  }
  container.replaceChildren();

  if (store.state.workspace === null) {
    container.appendChild(h('div', { class: 'empty-note' }, 'Abre una carpeta para ver sus servicios.'));
    return;
  }

  if (!dockerAvailable) {
    container.appendChild(
      h(
        'div',
        { style: 'padding:8px' },
        h('span', { class: 'chip', 'data-tone': 'error' }, 'Docker no disponible'),
      ),
    );
  }

  /* --- Servicios de compose --- */
  if (compose !== null) {
    const body = h('div', {});
    for (const service of compose.services) {
      const running = containerFor(service.name);
      const isUp = running?.state === 'running';

      const row = h('div', { class: 'list-row', title: service.image ?? service.name });
      row.appendChild(h('span', { class: 'pill-tab__dot', 'data-status': isUp ? 'ready' : 'idle' }));
      row.appendChild(h('span', { class: 'list-row__label' }, service.name));
      row.appendChild(
        h(
          'span',
          { class: 'list-row__hint' },
          service.ports.length > 0
            ? service.ports.map((port) => `${port.host}:${port.container}`).join(' ')
            : KIND_LABEL[service.kind],
        ),
      );

      const actions = h('div', { class: 'list-row__actions' });
      const toggle = h('button', {
        class: 'icon-btn',
        type: 'button',
        title: isUp ? 'Detener' : 'Levantar',
      });
      toggle.appendChild(svgIcon(isUp ? ICONS.stop : ICONS.run, 12));
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        void composeAction(isUp ? 'down' : 'up', [service.name]);
      });
      actions.appendChild(toggle);

      const firstPort = service.ports[0];
      if (firstPort !== undefined && isUp) {
        const open = h('button', { class: 'icon-btn', type: 'button', title: 'Abrir en el navegador' });
        open.appendChild(svgIcon(ICONS.http, 12));
        open.addEventListener('click', (event) => {
          event.stopPropagation();
          void window.forge.app.openExternal(`http://localhost:${firstPort.host}`);
        });
        actions.appendChild(open);
      }

      row.appendChild(actions);
      body.appendChild(row);
    }
    for (const warning of compose.warnings) {
      body.appendChild(h('div', { class: 'list-row__hint', style: 'padding:4px 8px' }, warning));
    }
    container.appendChild(section(`Compose · ${compose.path}`, compose.services.length, body));
  } else {
    container.appendChild(
      h('div', { class: 'empty-note' }, 'No se encontro ningun docker-compose en la raiz del proyecto.'),
    );
  }

  /* --- Contenedores --- */
  if (containers.length > 0) {
    const body = h('div', {});
    for (const info of containers) {
      const row = h('div', { class: 'list-row', title: `${info.image}  ·  ${info.status}` });
      row.appendChild(
        h('span', { class: 'pill-tab__dot', 'data-status': info.state === 'running' ? 'ready' : 'idle' }),
      );
      row.appendChild(h('span', { class: 'list-row__label' }, info.name));
      row.appendChild(h('span', { class: 'list-row__hint' }, info.status));
      body.appendChild(row);
    }
    container.appendChild(section('Contenedores', containers.length, body, true));
  }

  /* --- Esquema de datos --- */
  if (schema !== null) {
    const body = h('div', {});
    for (const model of schema.models) {
      const modelBlock = h('div', { class: 'section', 'data-collapsed': 'true' });
      const header = h('div', { class: 'section__header' });
      header.appendChild(svgIcon(ICONS.database, 12));
      header.appendChild(h('span', {}, model.name));
      header.appendChild(h('span', { class: 'section__count' }, String(model.columns.length)));
      header.addEventListener('click', () => {
        modelBlock.dataset['collapsed'] = modelBlock.dataset['collapsed'] === 'true' ? 'false' : 'true';
      });
      header.addEventListener('dblclick', () => {
        void runCommand('editor.revealLine', { path: model.file, line: model.line });
      });

      const columnsBody = h('div', { class: 'section__body' });
      for (const column of model.columns) {
        const row = h('div', { class: 'list-row', title: column.relation === undefined ? column.type : `Relacion con ${column.relation}` });
        row.appendChild(
          h(
            'span',
            { style: 'width:14px;text-align:center;color:var(--accent-300)' },
            column.primary ? '🔑' : column.relation !== undefined ? '→' : '',
          ),
        );
        row.appendChild(h('span', { class: 'list-row__label', style: 'font-family:var(--font-mono)' }, column.name));
        row.appendChild(
          h(
            'span',
            { class: 'list-row__hint', style: 'font-family:var(--font-mono)' },
            `${column.type}${column.nullable ? '?' : ''}${column.unique ? ' · unico' : ''}`,
          ),
        );
        columnsBody.appendChild(row);
      }
      modelBlock.append(header, columnsBody);
      body.appendChild(modelBlock);
    }

    for (const enumeration of schema.enums) {
      const row = h('div', { class: 'list-row', title: enumeration.values.join(', ') });
      row.appendChild(h('span', { class: 'list-row__label' }, `enum ${enumeration.name}`));
      row.appendChild(h('span', { class: 'list-row__hint' }, enumeration.values.join(', ')));
      body.appendChild(row);
    }

    container.appendChild(
      section(
        `Esquema · ${schema.source}${schema.provider === undefined ? '' : ` (${schema.provider})`}`,
        schema.models.length,
        body,
      ),
    );
  }
}
