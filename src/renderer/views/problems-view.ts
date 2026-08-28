/**
 * Panel de problemas.
 *
 * Reune en un solo sitio los diagnosticos de todos los modelos abiertos (los
 * publica el cliente LSP como marcadores de Monaco) mas los avisos del
 * manifiesto DotForge y del analisis del proyecto.
 */

import { h, svgIcon, rafThrottle } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { registerPanelView, type PanelViewContext } from './panel.js';
import { getMonaco } from './editor-area.js';

let host: HTMLElement;
let severityFilter: 'all' | 'errors' = 'all';

export function registerProblemsView(): void {
  registerPanelView('problems', mount);

  defineCommands([
    {
      id: 'problems.toggleFilter',
      title: 'Problemas: alternar el filtro de severidad',
      category: 'Vista',
      run: () => {
        severityFilter = severityFilter === 'all' ? 'errors' : 'all';
        render();
      },
    },
  ]);
}

function mount(context: PanelViewContext): void {
  host = h('div', { style: 'flex:1;min-height:0;overflow:auto' });
  context.container.replaceChildren(host);

  const filter = h('button', { class: 'chrome-btn', type: 'button', title: 'Filtrar por severidad' }, 'Todos');
  filter.addEventListener('click', () => {
    void runCommand('problems.toggleFilter');
    filter.textContent = severityFilter === 'all' ? 'Todos' : 'Solo errores';
  });
  context.actions.appendChild(filter);

  const monaco = getMonaco();
  // Los marcadores cambian de forma asincrona segun responden los servidores.
  monaco.editor.onDidChangeMarkers(() => throttledRender());

  store.subscribe(['manifest', 'project', 'documents', 'lsp'], render);
  render();
}

const throttledRender = rafThrottle(() => render());

interface Problem {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly source: string;
}

function collect(): Problem[] {
  const monaco = getMonaco();
  const problems: Problem[] = [];

  for (const marker of monaco.editor.getModelMarkers({})) {
    const uri = marker.resource;
    if (uri.scheme !== 'forge') {
      continue;
    }
    const severity =
      marker.severity === monaco.MarkerSeverity.Error
        ? 'error'
        : marker.severity === monaco.MarkerSeverity.Warning
          ? 'warning'
          : 'info';
    problems.push({
      path: uri.path.replace(/^\//, ''),
      line: marker.startLineNumber,
      column: marker.startColumn,
      severity,
      message: marker.message,
      source: marker.source ?? marker.owner,
    });
  }

  /* --- Avisos del manifiesto y del analisis del proyecto --- */
  const manifest = store.state.manifest;
  if (manifest !== null && manifest.found) {
    for (const warning of manifest.warnings) {
      problems.push({
        path: manifest.path ?? 'dotforge.config.json',
        line: 1,
        column: 1,
        severity: 'warning',
        message: warning,
        source: 'dotforge',
      });
    }
  }
  for (const warning of store.state.project?.warnings ?? []) {
    problems.push({
      path: 'package.json',
      line: 1,
      column: 1,
      severity: 'warning',
      message: warning,
      source: 'proyecto',
    });
  }

  /* --- Servidores de lenguaje caidos --- */
  for (const server of store.state.lsp) {
    if (server.status === 'failed' || server.status === 'unavailable') {
      problems.push({
        path: '(servidores de lenguaje)',
        line: 1,
        column: 1,
        severity: server.status === 'failed' ? 'warning' : 'info',
        message: server.message ?? `El servidor "${server.id}" no esta disponible.`,
        source: 'lsp',
      });
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  return problems.sort((a, b) => {
    if (a.severity !== b.severity) {
      return order[a.severity] - order[b.severity];
    }
    return a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path);
  });
}

function render(): void {
  if (host === undefined) {
    return;
  }
  const problems = collect().filter(
    (problem) => severityFilter === 'all' || problem.severity === 'error',
  );

  host.replaceChildren();
  if (problems.length === 0) {
    host.appendChild(
      h('div', { class: 'empty-note' }, 'Sin problemas detectados en los archivos abiertos.'),
    );
    return;
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const problem of problems) {
    counts[problem.severity] += 1;
  }
  host.appendChild(
    h(
      'div',
      { style: 'display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border-subtle)' },
      h('span', { class: 'chip', 'data-tone': counts.error > 0 ? 'error' : undefined }, `${counts.error} errores`),
      h('span', { class: 'chip' }, `${counts.warning} avisos`),
      h('span', { class: 'chip' }, `${counts.info} informativos`),
    ),
  );

  for (const problem of problems) {
    const row = h('div', { class: 'list-row', title: `${problem.path}:${problem.line}:${problem.column}` });
    const icon = svgIcon(
      problem.severity === 'error' ? ICONS.error : problem.severity === 'warning' ? ICONS.warning : ICONS.info,
      13,
    );
    icon.setAttribute(
      'style',
      `color: var(--state-${problem.severity === 'warning' ? 'warning' : problem.severity});flex:0 0 auto`,
    );
    row.appendChild(icon);
    row.appendChild(h('span', { class: 'list-row__label', style: 'flex:1' }, problem.message));
    row.appendChild(
      h(
        'span',
        { class: 'list-row__hint' },
        `${problem.path.split('/').pop() ?? problem.path}:${problem.line}`,
      ),
    );
    row.appendChild(h('span', { class: 'list-row__hint', style: 'min-width:70px' }, problem.source));

    row.addEventListener('click', () => {
      if (problem.path.startsWith('(')) {
        return;
      }
      void runCommand('editor.revealLine', { path: problem.path, line: problem.line });
    });
    host.appendChild(row);
  }
}
