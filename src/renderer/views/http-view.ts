/**
 * Cliente HTTP integrado.
 *
 * La barra lateral lista las peticiones del archivo `.http` activo y los
 * endpoints detectados en el codigo ("Probar endpoint" genera la peticion).
 * El panel inferior muestra la respuesta con estado, latencia, cabeceras y
 * cuerpo JSON reindentado.
 */

import { copyToClipboard, h, svgIcon, formatBytes, formatDuration } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { findDocument, store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import { registerPanelView, type PanelViewContext } from './panel.js';
import { getEditor, openFile } from './editor-area.js';
import type {
  HttpEndpointLens,
  HttpRequestSpec,
  HttpResponseView,
} from '../../shared/contracts.js';

let sidebarHost: HTMLElement;
let panelHost: HTMLElement;
let requests: readonly HttpRequestSpec[] = [];
let endpoints: readonly HttpEndpointLens[] = [];
let lastResponse: HttpResponseView | null = null;
let inFlightId: string | null = null;

const HTTP_FILE = 'requests.http';

export function registerHttpView(): void {
  registerSidebarView('http', mountSidebar);
  registerPanelView('http', mountPanel);

  defineCommands([
    {
      id: 'http.refresh',
      title: 'HTTP: analizar el documento activo',
      category: 'HTTP',
      run: () => analyzeActiveDocument(),
    },
    {
      id: 'http.send',
      title: 'HTTP: enviar la peticion',
      category: 'HTTP',
      run: (argument) => {
        const spec = argument as HttpRequestSpec | undefined;
        if (spec !== undefined) {
          void send(spec);
        }
      },
    },
    {
      id: 'http.newFile',
      title: 'HTTP: crear un archivo de peticiones',
      category: 'HTTP',
      enabled: () => store.state.workspace !== null,
      run: () => createHttpFile(),
    },
    {
      id: 'http.testEndpoint',
      title: 'HTTP: probar el endpoint',
      category: 'HTTP',
      run: (argument) => {
        const lens = argument as HttpEndpointLens | undefined;
        if (lens !== undefined) {
          void testEndpoint(lens);
        }
      },
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/*  Barra lateral                                                              */
/* -------------------------------------------------------------------------- */

function mountSidebar(context: SidebarViewContext): void {
  sidebarHost = h('div', {});
  context.container.replaceChildren(sidebarHost);

  const newButton = h('button', { class: 'icon-btn', type: 'button', title: 'Nuevo archivo .http' });
  newButton.appendChild(svgIcon(ICONS.plus, 13));
  newButton.addEventListener('click', () => void runCommand('http.newFile'));

  const refreshButton = h('button', { class: 'icon-btn', type: 'button', title: 'Analizar de nuevo' });
  refreshButton.appendChild(svgIcon(ICONS.refresh, 13));
  refreshButton.addEventListener('click', () => void runCommand('http.refresh'));

  context.actions.append(newButton, refreshButton);

  store.subscribe(['activeDocument'], () => void analyzeActiveDocument());
  void analyzeActiveDocument();
}

/** Analiza el documento activo buscando peticiones o endpoints. */
async function analyzeActiveDocument(): Promise<void> {
  const active = store.state.activeDocument;
  requests = [];
  endpoints = [];

  if (active === null || active.startsWith('forge-diff:')) {
    renderSidebar();
    return;
  }
  const editor = getEditor();
  const content = editor?.getModel()?.getValue() ?? '';
  if (content === '') {
    renderSidebar();
    return;
  }

  if (/\.(http|rest)$/i.test(active)) {
    const parsed = await window.forge.http.parse(content);
    requests = parsed.ok ? parsed.value : [];
  } else if (/\.[cm]?[jt]sx?$/i.test(active)) {
    const detected = await window.forge.http.endpoints(active, content);
    endpoints = detected.ok ? detected.value : [];
  }
  renderSidebar();
}

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'var(--state-info)';
    case 'POST':
      return 'var(--state-success)';
    case 'PUT':
    case 'PATCH':
      return 'var(--state-warning)';
    case 'DELETE':
      return 'var(--state-error)';
    default:
      return 'var(--text-muted)';
  }
}

function renderSidebar(): void {
  if (sidebarHost === undefined) {
    return;
  }
  sidebarHost.replaceChildren();

  if (store.state.workspace === null) {
    sidebarHost.appendChild(h('div', { class: 'empty-note' }, 'Abre una carpeta para usar el cliente HTTP.'));
    return;
  }

  if (requests.length > 0) {
    const header = h('div', { class: 'section__header' }, 'Peticiones del documento');
    header.appendChild(h('span', { class: 'section__count' }, String(requests.length)));
    sidebarHost.appendChild(header);

    for (const request of requests) {
      const row = h('div', { class: 'list-row', title: request.url });
      row.appendChild(
        h(
          'span',
          { style: `color:${methodColor(request.method)};font-weight:600;min-width:52px;font-family:var(--font-mono);font-size:11px` },
          request.method,
        ),
      );
      row.appendChild(h('span', { class: 'list-row__label' }, request.name ?? request.url));

      const actions = h('div', { class: 'list-row__actions' });
      const sendButton = h('button', { class: 'icon-btn', type: 'button', title: 'Enviar' });
      sendButton.appendChild(svgIcon(ICONS.run, 12));
      sendButton.addEventListener('click', (event) => {
        event.stopPropagation();
        void send(request);
      });
      actions.appendChild(sendButton);
      row.appendChild(actions);

      row.addEventListener('click', () => void send(request));
      sidebarHost.appendChild(row);
    }
  }

  if (endpoints.length > 0) {
    const header = h('div', { class: 'section__header' }, 'Endpoints detectados');
    header.appendChild(h('span', { class: 'section__count' }, String(endpoints.length)));
    sidebarHost.appendChild(header);

    for (const lens of endpoints) {
      const row = h('div', { class: 'list-row', title: `${lens.framework} · linea ${lens.line}` });
      row.appendChild(
        h(
          'span',
          { style: `color:${methodColor(lens.method)};font-weight:600;min-width:52px;font-family:var(--font-mono);font-size:11px` },
          lens.method,
        ),
      );
      row.appendChild(h('span', { class: 'list-row__label' }, lens.route));

      const actions = h('div', { class: 'list-row__actions' });
      const testButton = h('button', { class: 'icon-btn', type: 'button', title: 'Probar endpoint' });
      testButton.appendChild(svgIcon(ICONS.http, 12));
      testButton.addEventListener('click', (event) => {
        event.stopPropagation();
        void testEndpoint(lens);
      });
      actions.appendChild(testButton);
      row.appendChild(actions);

      row.addEventListener('click', () => {
        void runCommand('editor.revealLine', { path: lens.path, line: lens.line });
      });
      sidebarHost.appendChild(row);
    }
  }

  if (requests.length === 0 && endpoints.length === 0) {
    const create = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Crear requests.http');
    create.addEventListener('click', () => void runCommand('http.newFile'));
    sidebarHost.appendChild(
      h(
        'div',
        { class: 'empty-note', style: 'display:flex;flex-direction:column;gap:10px;align-items:center' },
        'Abre un archivo .http o un archivo con endpoints Express, NestJS, Fastify o Next.',
        create,
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Acciones                                                                   */
/* -------------------------------------------------------------------------- */

async function send(request: HttpRequestSpec): Promise<void> {
  if (inFlightId !== null) {
    await window.forge.http.cancel(inFlightId);
  }
  inFlightId = request.id;
  store.patch({ panelView: 'http', panelVisible: true });
  renderPanel(null, true);

  const result = await window.forge.http.send(request);
  inFlightId = null;

  if (!result.ok) {
    toastError('La peticion fallo.', result.error);
    renderPanel(null, false);
    return;
  }
  lastResponse = result.value;
  renderPanel(result.value, false);
}

/**
 * Genera la peticion del endpoint en el archivo `.http` y la deja lista.
 * El puerto sale del proceso en ejecucion cuando lo hay.
 */
async function testEndpoint(lens: HttpEndpointLens): Promise<void> {
  const running = store.state.processes.find((info) => info.port !== undefined);
  const port = running?.port ?? 3000;
  const route = lens.route.startsWith('/') ? lens.route : `/${lens.route}`;

  const block = [
    `### ${lens.method} ${route}  (${lens.framework})`,
    `${lens.method} http://localhost:${port}${route.replace(/:(\w+)/g, '1')}`,
    'Content-Type: application/json',
    ...(lens.method === 'GET' || lens.method === 'DELETE' ? [] : ['', '{', '  ', '}']),
    '',
  ].join('\n');

  const existing = await window.forge.fileSystem.readFile(HTTP_FILE);
  const content = existing.ok ? `${existing.value.content.replace(/\s*$/, '')}\n\n${block}` : block;

  const write = existing.ok
    ? await window.forge.fileSystem.writeFile({ path: HTTP_FILE, content })
    : await window.forge.fileSystem.createFile(HTTP_FILE, content);

  if (!write.ok) {
    toastError('No se pudo escribir el archivo de peticiones.', write.error);
    return;
  }

  // Si el archivo ya estaba abierto, se recarga para ver el bloque nuevo.
  if (findDocument(HTTP_FILE) !== undefined) {
    const editor = getEditor();
    editor?.getModel()?.setValue(content);
  }
  await openFile(HTTP_FILE, content.split('\n').length - block.split('\n').length + 1);
  toast('info', 'Peticion generada en requests.http.');
  await analyzeActiveDocument();
}

async function createHttpFile(): Promise<void> {
  const template = [
    '@baseUrl = http://localhost:3000',
    '',
    '### Comprobacion de salud',
    'GET {{baseUrl}}/health',
    '',
    '### Crear un recurso',
    'POST {{baseUrl}}/api/items',
    'Content-Type: application/json',
    '',
    '{',
    '  "nombre": "ejemplo"',
    '}',
    '',
  ].join('\n');

  const result = await window.forge.fileSystem.createFile(HTTP_FILE, template);
  if (!result.ok && result.error.code !== 'E_ALREADY_EXISTS') {
    toastError('No se pudo crear el archivo.', result.error);
    return;
  }
  await openFile(HTTP_FILE);
  await analyzeActiveDocument();
}

/* -------------------------------------------------------------------------- */
/*  Panel de respuesta                                                         */
/* -------------------------------------------------------------------------- */

function mountPanel(context: PanelViewContext): void {
  panelHost = h('div', { style: 'flex:1;min-height:0;overflow:auto;padding:8px' });
  context.container.replaceChildren(panelHost);

  const copyButton = h('button', { class: 'icon-btn', type: 'button', title: 'Copiar el cuerpo' });
  copyButton.appendChild(svgIcon(ICONS.copy, 13));
  copyButton.addEventListener('click', async () => {
    if (lastResponse === null) {
      return;
    }
    const copiado = await copyToClipboard(lastResponse.prettyBody ?? lastResponse.body);
    toast(
      copiado ? 'info' : 'warn',
      copiado ? 'Cuerpo copiado al portapapeles.' : 'No se pudo copiar al portapapeles.',
    );
  });
  context.actions.appendChild(copyButton);

  renderPanel(lastResponse, false);
}

function statusTone(status: number): string {
  if (status >= 500) {
    return 'server';
  }
  if (status >= 400) {
    return 'client';
  }
  if (status >= 300) {
    return 'redirect';
  }
  return 'ok';
}

function renderPanel(response: HttpResponseView | null, pending: boolean): void {
  if (panelHost === undefined) {
    return;
  }
  panelHost.replaceChildren();

  if (pending) {
    panelHost.appendChild(h('div', { class: 'empty-note' }, 'Enviando…'));
    return;
  }
  if (response === null) {
    panelHost.appendChild(
      h('div', { class: 'empty-note' }, 'Envia una peticion para ver aqui la respuesta.'),
    );
    return;
  }

  const summary = h('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap' });
  summary.appendChild(
    h(
      'span',
      { class: 'http-status', 'data-tone': statusTone(response.status) },
      `${response.status} ${response.statusText}`,
    ),
  );
  summary.appendChild(h('span', { class: 'chip' }, formatDuration(response.elapsedMs)));
  summary.appendChild(h('span', { class: 'chip' }, formatBytes(response.size)));
  if (response.contentType !== '') {
    summary.appendChild(h('span', { class: 'chip' }, response.contentType.split(';')[0] ?? ''));
  }
  panelHost.appendChild(summary);

  /* --- Cabeceras --- */
  const headerEntries = Object.entries(response.headers);
  if (headerEntries.length > 0) {
    const details = h('details', { style: 'margin-bottom:8px' });
    details.appendChild(h('summary', { style: 'cursor:pointer;color:var(--text-muted)' }, `Cabeceras (${headerEntries.length})`));
    const table = h('table', { class: 'kv-table' });
    for (const [name, value] of headerEntries) {
      const row = h('tr', {});
      row.append(h('th', {}, name), h('td', {}, value));
      table.appendChild(row);
    }
    details.appendChild(table);
    panelHost.appendChild(details);
  }

  /* --- Cuerpo --- */
  const body = response.prettyBody ?? response.body;
  panelHost.appendChild(
    h(
      'pre',
      {
        style:
          'margin:0;padding:8px;background:var(--surface-0);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);overflow:auto;user-select:text;white-space:pre-wrap;word-break:break-word',
      },
      h('code', {}, body === '' ? '(cuerpo vacio)' : body),
    ),
  );
}
