/**
 * Canales de salida.
 *
 * Un canal por proceso, con su estado, puerto detectado e hipervinculo local.
 * El repintado esta acotado por frame y solo anade las lineas nuevas: un
 * `next dev` con miles de lineas por minuto no debe repintar la lista entera.
 * Las trazas de pila y las URL se convierten en enlaces clicables.
 */

import { h, svgIcon, formatClock, rafThrottle } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { clearLogs, store } from '../core/store.js';
import { toastError } from '../core/toasts.js';
import { registerPanelView, type PanelViewContext } from './panel.js';
import type { LogRecord, ProcessInfo } from '../../shared/contracts.js';

let channelBar: HTMLElement;
let logHost: HTMLElement;
let actionsHost: HTMLElement;

/** Numero de lineas ya pintadas por canal, para pintar solo el incremento. */
const painted = new Map<string, number>();
let autoScroll = true;
let levelFilter: 'all' | 'warn' | 'error' = 'all';

export function registerOutputView(): void {
  registerPanelView('output', mount);

  defineCommands([
    {
      id: 'output.clear',
      title: 'Salida: limpiar el canal',
      category: 'Salida',
      run: () => {
        const active = store.state.activeProcessId;
        if (active !== null) {
          clearLogs(active);
          painted.set(active, 0);
          renderLogs();
        }
      },
    },
    {
      id: 'output.toggleAutoScroll',
      title: 'Salida: alternar el desplazamiento automatico',
      category: 'Salida',
      run: () => {
        autoScroll = !autoScroll;
        renderActions();
      },
    },
  ]);
}

function mount(context: PanelViewContext): void {
  channelBar = h('div', {
    style:
      'display:flex;gap:4px;padding:4px 8px;border-bottom:1px solid var(--border-subtle);overflow-x:auto;flex:0 0 auto',
  });
  logHost = h('div', { class: 'logview' });
  actionsHost = context.actions;

  context.container.replaceChildren(channelBar, logHost);

  logHost.addEventListener('scroll', () => {
    // Si el usuario sube, se desactiva el auto-scroll hasta que vuelva al final.
    const distance = logHost.scrollHeight - logHost.scrollTop - logHost.clientHeight;
    autoScroll = distance < 40;
  });

  store.subscribe(['processes', 'activeProcessId'], () => {
    renderChannels();
    renderActions();
    renderLogs(true);
  });
  store.subscribe(['logs'], throttledRenderLogs);

  renderChannels();
  renderActions();
  renderLogs(true);
}

/* -------------------------------------------------------------------------- */
/*  Canales                                                                    */
/* -------------------------------------------------------------------------- */

function renderChannels(): void {
  const state = store.state;
  channelBar.replaceChildren();

  if (state.processes.length === 0) {
    channelBar.appendChild(
      h('span', { class: 'list-row__hint' }, 'Sin procesos. Lanza un pipeline desde la barra lateral.'),
    );
    return;
  }

  for (const info of state.processes) {
    const isActive = info.id === state.activeProcessId;
    const tab = h('button', {
      class: 'pill-tab',
      type: 'button',
      'data-active': String(isActive),
      title: `${info.command} ${info.args.join(' ')}`,
    });
    tab.appendChild(h('span', { class: 'pill-tab__dot', 'data-status': info.status }));
    tab.appendChild(h('span', {}, info.label));
    if (info.port !== undefined) {
      tab.appendChild(h('span', { style: 'color:var(--text-subtle)' }, `:${info.port}`));
    }
    tab.addEventListener('click', () => store.patch({ activeProcessId: info.id }));
    channelBar.appendChild(tab);
  }
}

function activeProcess(): ProcessInfo | undefined {
  const id = store.state.activeProcessId;
  return id === null ? undefined : store.state.processes.find((info) => info.id === id);
}

function renderActions(): void {
  if (actionsHost === undefined) {
    return;
  }
  actionsHost.replaceChildren();
  const info = activeProcess();

  if (info?.url !== undefined) {
    const open = h('button', { class: 'chrome-btn', type: 'button', 'data-tone': 'accent', title: 'Abrir en el navegador' });
    open.append(svgIcon(ICONS.http, 12), info.url);
    open.addEventListener('click', () => {
      void window.forge.app.openExternal(info.url as string);
    });
    actionsHost.appendChild(open);
  }

  const filter = h('button', { class: 'chrome-btn', type: 'button', title: 'Filtrar por nivel' },
    levelFilter === 'all' ? 'Todos' : levelFilter === 'warn' ? 'Avisos+' : 'Errores');
  filter.addEventListener('click', () => {
    levelFilter = levelFilter === 'all' ? 'warn' : levelFilter === 'warn' ? 'error' : 'all';
    renderActions();
    renderLogs(true);
  });
  actionsHost.appendChild(filter);

  const scrollButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Desplazamiento automatico',
    'data-active': String(autoScroll),
  });
  scrollButton.appendChild(svgIcon(ICONS.chevronDown, 13));
  scrollButton.addEventListener('click', () => void runCommand('output.toggleAutoScroll'));
  actionsHost.appendChild(scrollButton);

  if (info !== undefined) {
    const live = info.status === 'running' || info.status === 'ready' || info.status === 'starting';
    const control = h('button', {
      class: 'icon-btn',
      type: 'button',
      title: live ? 'Detener el proceso' : 'Reiniciar el proceso',
    });
    control.appendChild(svgIcon(live ? ICONS.stop : ICONS.refresh, 13));
    control.addEventListener('click', async () => {
      const result = live
        ? await window.forge.process.stop(info.id)
        : await window.forge.process.restart(info.id);
      if (!result.ok) {
        toastError('La operacion sobre el proceso fallo.', result.error);
      }
    });
    actionsHost.appendChild(control);
  }

  const clear = h('button', { class: 'icon-btn', type: 'button', title: 'Limpiar el canal' });
  clear.appendChild(svgIcon(ICONS.close, 13));
  clear.addEventListener('click', () => void runCommand('output.clear'));
  actionsHost.appendChild(clear);
}

/* -------------------------------------------------------------------------- */
/*  Registros                                                                  */
/* -------------------------------------------------------------------------- */

const LEVEL_ORDER: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

function passesFilter(record: LogRecord): boolean {
  if (levelFilter === 'all') {
    return true;
  }
  const minimum = levelFilter === 'warn' ? LEVEL_ORDER['warn'] : LEVEL_ORDER['error'];
  return (LEVEL_ORDER[record.level] ?? 2) >= (minimum ?? 3);
}

const throttledRenderLogs = rafThrottle(() => renderLogs());

function renderLogs(reset = false): void {
  if (logHost === undefined) {
    return;
  }
  const id = store.state.activeProcessId;
  if (id === null) {
    logHost.replaceChildren(h('div', { class: 'empty-note' }, 'Selecciona un canal de salida.'));
    return;
  }

  const records = store.state.logs.get(id) ?? [];
  if (reset) {
    logHost.replaceChildren();
    painted.set(id, 0);
  }

  let from = painted.get(id) ?? 0;
  // El anillo del store puede haber descartado lineas antiguas: si el buffer
  // encogio, se repinta entero en vez de mostrar un hueco.
  if (from > records.length) {
    logHost.replaceChildren();
    from = 0;
  }

  if (records.length === 0) {
    logHost.replaceChildren(h('div', { class: 'empty-note' }, 'Sin salida todavia.'));
    painted.set(id, 0);
    return;
  }
  if (from === 0) {
    logHost.replaceChildren();
  }

  const fragment = document.createDocumentFragment();
  for (let index = from; index < records.length; index += 1) {
    const record = records[index];
    if (record !== undefined && passesFilter(record)) {
      fragment.appendChild(renderRecord(record));
    }
  }
  logHost.appendChild(fragment);
  painted.set(id, records.length);

  if (autoScroll) {
    logHost.scrollTop = logHost.scrollHeight;
  }
}

/**
 * Pinta una linea troceando el mensaje en fragmentos de texto, enlaces y
 * marcos de pila. Se usa `textContent` en cada trozo: nada de innerHTML sobre
 * salida de proceso.
 */
function renderRecord(record: LogRecord): HTMLElement {
  const line = h('div', { class: 'logline', 'data-level': record.level });
  line.appendChild(h('span', { class: 'logline__time' }, formatClock(record.time)));
  line.appendChild(h('span', { class: 'logline__level' }, record.level));

  const message = h('span', { class: 'logline__message' });
  appendLinkedText(message, record);
  line.appendChild(message);

  if (record.fields !== undefined) {
    const fields = Object.entries(record.fields)
      .slice(0, 6)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    if (fields !== '') {
      line.appendChild(h('span', { class: 'logline__field' }, fields));
    }
  }
  return line;
}

interface Marker {
  readonly start: number;
  readonly end: number;
  readonly kind: 'url' | 'frame';
  readonly value: string;
  readonly line?: number;
}

function appendLinkedText(host: HTMLElement, record: LogRecord): void {
  const text = record.message;
  const markers: Marker[] = [];

  for (const url of record.urls ?? []) {
    let from = text.indexOf(url);
    while (from !== -1) {
      markers.push({ start: from, end: from + url.length, kind: 'url', value: url });
      from = text.indexOf(url, from + url.length);
    }
  }
  for (const frame of record.frames ?? []) {
    if (!frame.inWorkspace) {
      continue;
    }
    // Se busca el texto tal como aparece: puede ser la ruta absoluta o la
    // relativa, asi que se prueban ambas formas.
    const needle = `${frame.path}:${frame.line}`;
    const from = text.indexOf(needle);
    if (from !== -1) {
      markers.push({ start: from, end: from + needle.length, kind: 'frame', value: frame.path, line: frame.line });
      continue;
    }
    const bare = frame.path.split('/').pop();
    if (bare !== undefined) {
      const alternative = `${bare}:${frame.line}`;
      const position = text.indexOf(alternative);
      if (position !== -1) {
        markers.push({
          start: position,
          end: position + alternative.length,
          kind: 'frame',
          value: frame.path,
          line: frame.line,
        });
      }
    }
  }

  markers.sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const marker of markers) {
    if (marker.start < cursor) {
      continue;
    }
    if (marker.start > cursor) {
      host.appendChild(document.createTextNode(text.slice(cursor, marker.start)));
    }
    const label = text.slice(marker.start, marker.end);
    if (marker.kind === 'url') {
      const link = h('span', { class: 'logline__link', role: 'link', tabindex: '0' }, label);
      link.addEventListener('click', () => void window.forge.app.openExternal(marker.value));
      host.appendChild(link);
    } else {
      const link = h('span', { class: 'logline__frame', role: 'link', tabindex: '0' }, label);
      link.addEventListener('click', () => {
        void runCommand('editor.revealLine', { path: marker.value, line: marker.line });
      });
      host.appendChild(link);
    }
    cursor = marker.end;
  }
  if (cursor < text.length) {
    host.appendChild(document.createTextNode(text.slice(cursor)));
  }
}
