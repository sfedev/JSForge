/**
 * Paleta de comandos y buscador rapido de archivos.
 *
 * Un unico control con dos modos: sin prefijo lista comandos; con el modo
 * "archivos" busca por subsecuencia dentro del workspace. La puntuacion
 * favorece coincidencias contiguas y al inicio de segmento, que es lo que
 * hace que `sctr` encuentre `src/core/store.ts`.
 */

import { h, debounce } from '../core/dom.js';
import { listCommands, defineCommands, runCommand } from '../core/commands.js';
import { keybindingFor } from '../core/keybindings.js';
import { store } from '../core/store.js';
import type { ShellMounts } from '../shell.js';

interface PaletteEntry {
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void | Promise<void>;
}

interface Scored {
  readonly entry: PaletteEntry;
  readonly score: number;
  readonly positions: readonly number[];
}

/**
 * Puntuacion por subsecuencia. Devuelve `null` si no hay coincidencia.
 * Bonifica: inicio de cadena, inicio de segmento (`/`, `-`, `_`, `.`) y
 * caracteres consecutivos.
 */
export function fuzzyScore(text: string, query: string): { score: number; positions: number[] } | null {
  if (query === '') {
    return { score: 0, positions: [] };
  }
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let cursor = 0;
  let previousIndex = -2;

  for (const character of needle) {
    if (character === ' ') {
      continue;
    }
    const index = haystack.indexOf(character, cursor);
    if (index === -1) {
      return null;
    }
    let gain = 1;
    if (index === previousIndex + 1) {
      gain += 4;
    }
    if (index === 0) {
      gain += 6;
    } else {
      const before = haystack[index - 1];
      if (before === '/' || before === '-' || before === '_' || before === '.' || before === ' ') {
        gain += 4;
      }
    }
    score += gain;
    positions.push(index);
    previousIndex = index;
    cursor = index + 1;
  }
  // Penaliza cadenas largas para que gane la coincidencia mas ajustada.
  score -= Math.floor(haystack.length / 40);
  return { score, positions };
}

/** Resalta los caracteres coincidentes sin usar innerHTML. */
function highlight(text: string, positions: readonly number[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const marked = new Set(positions);
  let buffer = '';
  let bufferMarked = false;

  const flush = (): void => {
    if (buffer === '') {
      return;
    }
    if (bufferMarked) {
      fragment.appendChild(h('strong', { style: 'color:var(--accent-200)' }, buffer));
    } else {
      fragment.appendChild(document.createTextNode(buffer));
    }
    buffer = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const isMarked = marked.has(index);
    if (isMarked !== bufferMarked) {
      flush();
      bufferMarked = isMarked;
    }
    buffer += text[index];
  }
  flush();
  return fragment;
}

const MAX_RESULTS = 60;

export function mountCommandPalette(mounts: ShellMounts): void {
  const input = h('input', {
    class: 'palette__input',
    type: 'text',
    placeholder: 'Escribe un comando…',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Paleta de comandos',
  });
  const list = h('div', { class: 'palette__list', role: 'listbox' });
  const palette = h('div', { class: 'palette' }, input, list);
  const overlay = h('div', { class: 'overlay overlay--top', hidden: true }, palette);
  mounts.overlays.appendChild(overlay);

  let mode: 'commands' | 'files' = 'commands';
  let entries: PaletteEntry[] = [];
  let filtered: Scored[] = [];
  let activeIndex = 0;

  function close(): void {
    overlay.hidden = true;
    input.value = '';
    filtered = [];
    list.replaceChildren();
  }

  function commandEntries(): PaletteEntry[] {
    return listCommands().map((command) => ({
      label: `${command.category}: ${command.title}`,
      hint: keybindingFor(command.id),
      run: () => runCommand(command.id),
    }));
  }

  async function fileEntries(query: string): Promise<PaletteEntry[]> {
    if (store.state.workspace === null || query.trim() === '') {
      return [];
    }
    // El main recorre el arbol saltando node_modules, dist y demas, y
    // devuelve rutas ya relativas al workspace.
    const result = await window.forge.fileSystem.findFiles(query.trim(), 300);
    if (!result.ok) {
      return [];
    }
    return result.value.map((relativePath) => ({
      label: relativePath,
      hint: 'archivo',
      run: () => runCommand('editor.openFile', relativePath),
    }));
  }

  function render(): void {
    const query = input.value;
    const scored: Scored[] = [];
    for (const entry of entries) {
      const result = fuzzyScore(entry.label, query);
      if (result === null) {
        continue;
      }
      scored.push({ entry, score: result.score, positions: result.positions });
    }
    scored.sort((a, b) => b.score - a.score);
    filtered = scored.slice(0, MAX_RESULTS);
    activeIndex = 0;
    paint();
  }

  function paint(): void {
    list.replaceChildren();
    if (filtered.length === 0) {
      list.appendChild(h('div', { class: 'empty-note' }, 'Sin resultados'));
      return;
    }
    filtered.forEach((item, index) => {
      const row = h('div', {
        class: 'palette__item',
        role: 'option',
        'data-active': String(index === activeIndex),
        'aria-selected': String(index === activeIndex),
      });
      row.appendChild(h('span', {}, highlight(item.entry.label, item.positions)));
      if (item.entry.hint !== undefined) {
        row.appendChild(h('span', { class: 'palette__item-hint' }, item.entry.hint));
      }
      row.addEventListener('mouseenter', () => {
        activeIndex = index;
        paint();
      });
      row.addEventListener('click', () => {
        close();
        void item.entry.run();
      });
      list.appendChild(row);
    });
    list.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  const refreshFiles = debounce(async () => {
    entries = await fileEntries(input.value);
    render();
  }, 140);

  input.addEventListener('input', () => {
    if (mode === 'files') {
      refreshFiles();
    } else {
      render();
    }
  });

  input.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'ArrowDown':
        event.preventDefault();
        activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
        paint();
        break;
      case 'ArrowUp':
        event.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        paint();
        break;
      case 'Enter': {
        event.preventDefault();
        const selected = filtered[activeIndex];
        if (selected !== undefined) {
          close();
          void selected.entry.run();
        }
        break;
      }
      default:
        break;
    }
  });

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  function open(nextMode: 'commands' | 'files', prefill = ''): void {
    mode = nextMode;
    overlay.hidden = false;
    input.placeholder =
      nextMode === 'files' ? 'Buscar archivos por nombre…' : 'Escribe un comando…';
    input.value = prefill;
    entries = nextMode === 'commands' ? commandEntries() : [];
    render();
    input.focus();
    input.setSelectionRange(prefill.length, prefill.length);
    if (nextMode === 'files' && prefill !== '') {
      refreshFiles();
    }
  }

  defineCommands([
    {
      id: 'palette.open',
      title: 'Abrir la paleta de comandos',
      category: 'Vista',
      run: (argument) => open('commands', typeof argument === 'string' ? argument : ''),
    },
    {
      id: 'palette.openFiles',
      title: 'Ir al archivo…',
      category: 'Archivo',
      enabled: () => store.state.workspace !== null,
      run: () => open('files'),
    },
  ]);
}
