/**
 * Terminal integrada del panel inferior.
 *
 * Usa xterm.js contra la sesion PTY del proceso principal. Ademas del flujo
 * normal, ofrece sugerencias por prefijo con los scripts, tareas y pipelines
 * REALES del proyecto: se acepta con Tab y se navega con las flechas.
 */

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import { h, svgIcon, debounce } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerPanelView, type PanelViewContext } from './panel.js';
import type { CommandSuggestion, PtyProfile } from '../../shared/contracts.js';

interface TerminalSession {
  readonly id: string;
  readonly terminal: Terminal;
  readonly fit: FitAddon;
  readonly host: HTMLElement;
  readonly profileId: string;
  degraded: boolean;
  /** Linea que el usuario lleva escrita, para las sugerencias. */
  buffer: string;
}

const sessions = new Map<string, TerminalSession>();
let activeId: string | null = null;
let container: HTMLElement;
let tabBar: HTMLElement;
let suggestionBox: HTMLElement;
let profiles: readonly PtyProfile[] = [];
let counter = 0;

let suggestions: readonly CommandSuggestion[] = [];
let suggestionIndex = 0;

export function registerTerminalView(): void {
  registerPanelView('terminal', mount);

  defineCommands([
    {
      id: 'terminal.new',
      title: 'Terminal: nueva',
      category: 'Terminal',
      enabled: () => store.state.workspace !== null,
      run: () => createSession(store.state.settings.terminalProfile),
    },
    {
      id: 'terminal.kill',
      title: 'Terminal: cerrar la actual',
      category: 'Terminal',
      run: () => {
        if (activeId !== null) {
          void disposeSession(activeId);
        }
      },
    },
    {
      id: 'terminal.handleData',
      title: 'Terminal: recibir datos',
      category: 'Terminal',
      run: (argument) => {
        const payload = argument as { id: string; data: string };
        sessions.get(payload.id)?.terminal.write(payload.data);
      },
    },
    {
      id: 'terminal.handleExit',
      title: 'Terminal: proceso terminado',
      category: 'Terminal',
      run: (argument) => {
        const payload = argument as { id: string; exitCode: number };
        const session = sessions.get(payload.id);
        if (session === undefined) {
          return;
        }
        session.terminal.write(
          `\r\n\x1b[90m— proceso terminado con codigo ${payload.exitCode} —\x1b[0m\r\n`,
        );
      },
    },
  ]);
}

function mount(context: PanelViewContext): void {
  tabBar = h('div', {
    style:
      'display:flex;gap:4px;padding:4px 8px;border-bottom:1px solid var(--border-subtle);flex:0 0 auto;overflow-x:auto',
  });
  container = h('div', { style: 'position:relative;flex:1;min-height:0' });
  suggestionBox = h('div', {
    class: 'palette__list',
    style:
      'position:absolute;left:8px;bottom:8px;right:8px;max-height:180px;background:var(--surface-2);border:1px solid var(--border-normal);border-radius:var(--radius-md);box-shadow:var(--shadow-2);display:none;z-index:5',
  });
  container.appendChild(suggestionBox);

  context.container.replaceChildren(tabBar, container);

  const newButton = h('button', { class: 'icon-btn', type: 'button', title: 'Nueva terminal' });
  newButton.appendChild(svgIcon(ICONS.plus, 13));
  newButton.addEventListener('click', () => void runCommand('terminal.new'));

  const killButton = h('button', { class: 'icon-btn', type: 'button', title: 'Cerrar la terminal' });
  killButton.appendChild(svgIcon(ICONS.stop, 13));
  killButton.addEventListener('click', () => void runCommand('terminal.kill'));

  context.actions.append(newButton, killButton);

  const onResize = debounce(() => {
    for (const session of sessions.values()) {
      if (session.id === activeId) {
        fitSession(session);
      }
    }
  }, 120);
  window.addEventListener('resize', onResize);

  void loadProfiles();
}

async function loadProfiles(): Promise<void> {
  const result = await window.forge.terminal.profiles();
  if (result.ok) {
    profiles = result.value;
  }
  if (sessions.size === 0 && store.state.workspace !== null) {
    await createSession(store.state.settings.terminalProfile);
  }
  renderTabs();
}

/* -------------------------------------------------------------------------- */
/*  Sesiones                                                                   */
/* -------------------------------------------------------------------------- */

function themeForTerminal(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback;

  return {
    background: read('--surface-1', '#11141d'),
    foreground: read('--text-normal', '#c8cee2'),
    cursor: read('--accent-300', '#a88cff'),
    selectionBackground: 'rgba(124, 77, 255, 0.32)',
    black: '#11141d',
    red: read('--state-error', '#ff6b6b'),
    green: read('--state-success', '#3fb950'),
    yellow: read('--state-warning', '#d9a441'),
    blue: read('--state-info', '#58a6ff'),
    magenta: read('--accent-300', '#a88cff'),
    cyan: '#7fd4c1',
    white: read('--text-normal', '#c8cee2'),
    brightBlack: read('--text-subtle', '#6b7490'),
    brightWhite: read('--text-strong', '#f2f4fb'),
  };
}

async function createSession(profileId: string): Promise<void> {
  if (store.state.workspace === null) {
    toast('warn', 'Abre una carpeta antes de usar la terminal.');
    return;
  }
  counter += 1;
  const id = `term-${counter}`;

  const host = h('div', { class: 'terminal-host', style: 'position:absolute;inset:0' });
  container.appendChild(host);

  const settings = store.state.settings;
  const terminal = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 8000,
    allowProposedApi: true,
    theme: themeForTerminal(),
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(
    new WebLinksAddon((_event, uri) => {
      void window.forge.app.openExternal(uri);
    }),
  );
  terminal.open(host);
  fit.fit();

  const session: TerminalSession = {
    id,
    terminal,
    fit,
    host,
    profileId,
    degraded: false,
    buffer: '',
  };
  sessions.set(id, session);
  activeId = id;

  const result = await window.forge.terminal.create({
    id,
    profileId,
    cols: terminal.cols,
    rows: terminal.rows,
  });

  if (!result.ok) {
    toastError('No se pudo abrir la terminal.', result.error);
    terminal.dispose();
    host.remove();
    sessions.delete(id);
    return;
  }
  session.degraded = result.value.degraded;

  terminal.onData((data) => {
    trackBuffer(session, data);
    void window.forge.terminal.write(id, data);
  });

  terminal.onResize(({ cols, rows }) => {
    void window.forge.terminal.resize(id, cols, rows);
  });

  // Tab y flechas se interceptan antes de llegar al shell cuando hay
  // sugerencias visibles.
  terminal.attachCustomKeyEventHandler((event) => handleKey(event));

  renderTabs();
  showSession(id);
}

async function disposeSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (session === undefined) {
    return;
  }
  await window.forge.terminal.dispose(id);
  session.terminal.dispose();
  session.host.remove();
  sessions.delete(id);

  if (activeId === id) {
    const next = [...sessions.keys()][0] ?? null;
    activeId = next;
    if (next !== null) {
      showSession(next);
    }
  }
  renderTabs();
}

function showSession(id: string): void {
  activeId = id;
  hideSuggestions();
  for (const session of sessions.values()) {
    session.host.style.display = session.id === id ? 'block' : 'none';
  }
  const session = sessions.get(id);
  if (session !== undefined) {
    fitSession(session);
    session.terminal.focus();
  }
  renderTabs();
}

function fitSession(session: TerminalSession): void {
  try {
    session.fit.fit();
  } catch {
    // El contenedor puede tener tamano cero mientras el panel esta oculto.
  }
}

function renderTabs(): void {
  if (tabBar === undefined) {
    return;
  }
  tabBar.replaceChildren();
  for (const session of sessions.values()) {
    const profile = profiles.find((entry) => entry.id === session.profileId);
    const tab = h('button', {
      class: 'pill-tab',
      type: 'button',
      'data-active': String(session.id === activeId),
      title: session.degraded ? 'Modo degradado: sin TTY real' : (profile?.label ?? session.profileId),
    });
    tab.appendChild(h('span', {}, profile?.label ?? session.profileId));
    if (session.degraded) {
      tab.appendChild(h('span', { style: 'color:var(--state-warning)' }, '·degradada'));
    }
    tab.addEventListener('click', () => showSession(session.id));
    tabBar.appendChild(tab);
  }

  for (const profile of profiles) {
    if (!profile.available) {
      continue;
    }
    if ([...sessions.values()].some((session) => session.profileId === profile.id)) {
      continue;
    }
    const add = h('button', { class: 'pill-tab', type: 'button', title: `Abrir ${profile.label}` });
    add.append(svgIcon(ICONS.plus, 11), profile.label);
    add.addEventListener('click', () => void createSession(profile.id));
    tabBar.appendChild(add);
  }
}

/* -------------------------------------------------------------------------- */
/*  Sugerencias                                                                */
/* -------------------------------------------------------------------------- */

/** Reconstruye la linea escrita a partir de las pulsaciones. */
function trackBuffer(session: TerminalSession, data: string): void {
  const BACKSPACE = '\u007f';
  const CTRL_C = '\u0003';
  const CTRL_U = '\u0015';
  const ESCAPE = '\u001b';

  if (data === '\r' || data === '\n') {
    session.buffer = '';
    hideSuggestions();
    return;
  }
  if (data === BACKSPACE || data === '\b') {
    session.buffer = session.buffer.slice(0, -1);
  } else if (data === CTRL_C || data === CTRL_U) {
    // Ctrl+C y Ctrl+U vacian la linea.
    session.buffer = '';
  } else if (data.length === 1 && data >= ' ') {
    session.buffer += data;
  } else if (data.length > 1 && !data.startsWith(ESCAPE)) {
    // Pegado de varios caracteres; las secuencias de escape se ignoran.
    session.buffer += data;
  }
  requestSuggestions(session);
}

const requestSuggestions = debounce(async (session: TerminalSession) => {
  if (session.buffer.trim() === '') {
    hideSuggestions();
    return;
  }
  const result = await window.forge.terminal.suggest(session.buffer);
  if (!result.ok || result.value.length === 0) {
    hideSuggestions();
    return;
  }
  suggestions = result.value;
  suggestionIndex = 0;
  renderSuggestions();
}, 130);

function renderSuggestions(): void {
  suggestionBox.replaceChildren();
  if (suggestions.length === 0) {
    suggestionBox.style.display = 'none';
    return;
  }
  suggestionBox.style.display = 'block';

  suggestions.forEach((suggestion, index) => {
    const row = h('div', {
      class: 'palette__item',
      'data-active': String(index === suggestionIndex),
    });
    row.appendChild(h('span', {}, suggestion.value));
    if (suggestion.detail !== undefined && suggestion.detail !== '') {
      row.appendChild(h('span', { class: 'palette__item-hint' }, suggestion.detail));
    }
    row.appendChild(h('span', { class: 'palette__item-hint' }, suggestion.kind));
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      acceptSuggestion(index);
    });
    suggestionBox.appendChild(row);
  });
}

function hideSuggestions(): void {
  suggestions = [];
  suggestionIndex = 0;
  if (suggestionBox !== undefined) {
    suggestionBox.style.display = 'none';
  }
}

/** Sustituye lo escrito por la sugerencia elegida. */
function acceptSuggestion(index: number): void {
  const session = activeId === null ? undefined : sessions.get(activeId);
  const suggestion = suggestions[index];
  if (session === undefined || suggestion === undefined) {
    return;
  }
  // Ctrl+U borra la linea escrita; despues se envia la sugerencia completa.
  void window.forge.terminal.write(session.id, '\u0015');
  void window.forge.terminal.write(session.id, suggestion.value);
  session.buffer = suggestion.value;
  hideSuggestions();
}

/** Intercepta Tab y flechas solo mientras hay sugerencias visibles. */
function handleKey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || suggestions.length === 0) {
    return true;
  }
  switch (event.key) {
    case 'Tab':
      event.preventDefault();
      acceptSuggestion(suggestionIndex);
      return false;
    case 'ArrowDown':
      event.preventDefault();
      suggestionIndex = (suggestionIndex + 1) % suggestions.length;
      renderSuggestions();
      return false;
    case 'ArrowUp':
      event.preventDefault();
      suggestionIndex = (suggestionIndex - 1 + suggestions.length) % suggestions.length;
      renderSuggestions();
      return false;
    case 'Escape':
      hideSuggestions();
      return false;
    default:
      return true;
  }
}
