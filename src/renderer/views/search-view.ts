/**
 * Busqueda en el workspace.
 *
 * La busqueda corre en el proceso principal por flujo de lineas; aqui solo
 * se agrupan los resultados por archivo y se ofrecen los conmutadores
 * habituales (mayusculas, palabra completa, expresion regular, filtros).
 */

import { h, svgIcon, debounce, formatDuration } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import type { SearchMatch, SearchResult } from '../../shared/contracts.js';

let input: HTMLInputElement;
let includeInput: HTMLInputElement;
let excludeInput: HTMLInputElement;
let resultsHost: HTMLElement;
let summary: HTMLElement;

let caseSensitive = false;
let wholeWord = false;
let useRegex = false;

export function registerSearchView(): void {
  registerSidebarView('search', mount);

  defineCommands([
    {
      id: 'search.focus',
      title: 'Buscar en los archivos',
      category: 'Buscar',
      run: () => {
        store.patch({ sidebarView: 'search', sidebarVisible: true });
        window.setTimeout(() => input?.focus(), 60);
      },
    },
  ]);
}

function toggleButton(label: string, title: string, get: () => boolean, set: (value: boolean) => void): HTMLButtonElement {
  const button = h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title }, label) as HTMLButtonElement;
  button.dataset['active'] = String(get());
  button.addEventListener('click', () => {
    set(!get());
    button.dataset['active'] = String(get());
    void runSearch();
  });
  return button;
}

function mount(context: SidebarViewContext): void {
  input = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Buscar…',
    spellcheck: 'false',
    'aria-label': 'Texto a buscar',
  }) as HTMLInputElement;

  const toggles = h(
    'div',
    { style: 'display:flex;gap:2px' },
    toggleButton('Aa', 'Distinguir mayusculas', () => caseSensitive, (value) => (caseSensitive = value)),
    toggleButton('ab', 'Solo palabras completas', () => wholeWord, (value) => (wholeWord = value)),
    toggleButton('.*', 'Expresion regular', () => useRegex, (value) => (useRegex = value)),
  );

  includeInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Incluir (p. ej. src/**/*.ts)',
    spellcheck: 'false',
    'aria-label': 'Patron de archivos incluidos',
  }) as HTMLInputElement;

  excludeInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Excluir (p. ej. **/*.test.ts)',
    spellcheck: 'false',
    'aria-label': 'Patron de archivos excluidos',
  }) as HTMLInputElement;

  summary = h('div', { class: 'list-row__hint', style: 'padding:4px 8px' });
  resultsHost = h('div', {});

  const form = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:6px;padding:8px;border-bottom:1px solid var(--border-subtle)' },
    h('div', { style: 'display:flex;gap:4px;align-items:center' }, input, toggles),
    includeInput,
    excludeInput,
  );

  context.container.replaceChildren(form, summary, resultsHost);

  const debounced = debounce(() => void runSearch(), 260);
  input.addEventListener('input', debounced);
  includeInput.addEventListener('input', debounced);
  excludeInput.addEventListener('input', debounced);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSearch();
    }
  });
}

function splitPatterns(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

async function runSearch(): Promise<void> {
  const query = input.value;
  if (query.trim() === '') {
    resultsHost.replaceChildren();
    summary.textContent = '';
    return;
  }
  if (store.state.workspace === null) {
    summary.textContent = 'Abre una carpeta para buscar.';
    return;
  }

  summary.textContent = 'Buscando…';
  const result = await window.forge.fileSystem.search({
    query,
    caseSensitive,
    wholeWord,
    regex: useRegex,
    include: splitPatterns(includeInput.value),
    exclude: splitPatterns(excludeInput.value),
    maxResults: 1000,
  });

  if (!result.ok) {
    summary.textContent = '';
    toastError('La busqueda fallo.', result.error);
    return;
  }
  renderResults(result.value);
}

function renderResults(result: SearchResult): void {
  const grouped = new Map<string, SearchMatch[]>();
  for (const match of result.matches) {
    const bucket = grouped.get(match.path);
    if (bucket === undefined) {
      grouped.set(match.path, [match]);
    } else {
      bucket.push(match);
    }
  }

  summary.textContent =
    result.matches.length === 0
      ? `Sin coincidencias · ${result.scannedFiles} archivos · ${formatDuration(result.elapsedMs)}`
      : `${result.matches.length}${result.truncated ? '+' : ''} coincidencias en ${grouped.size} archivos · ${formatDuration(result.elapsedMs)}`;

  resultsHost.replaceChildren();
  for (const [path, matches] of grouped) {
    const section = h('div', { class: 'section' });
    const header = h('div', { class: 'section__header' });
    header.appendChild(svgIcon(ICONS.file, 13));
    header.appendChild(h('span', { style: 'overflow:hidden;text-overflow:ellipsis' }, path));
    header.appendChild(h('span', { class: 'section__count' }, String(matches.length)));
    header.addEventListener('click', () => {
      section.dataset['collapsed'] = section.dataset['collapsed'] === 'true' ? 'false' : 'true';
    });

    const body = h('div', { class: 'section__body' });
    for (const match of matches) {
      const row = h('div', { class: 'list-row', title: `${path}:${match.line}` });
      row.appendChild(
        h('span', { style: 'color:var(--text-subtle);min-width:34px;text-align:right' }, String(match.line)),
      );
      row.appendChild(h('span', { class: 'list-row__label', style: 'font-family:var(--font-mono)' }, match.preview));
      row.addEventListener('click', () => {
        void runCommand('editor.revealLine', { path, line: match.line });
      });
      body.appendChild(row);
    }

    section.append(header, body);
    resultsHost.appendChild(section);
  }
}
