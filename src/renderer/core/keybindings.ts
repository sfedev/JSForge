/**
 * Atajos de teclado globales del shell.
 *
 * Monaco gestiona los suyos dentro del editor; aqui solo se capturan los
 * que pertenecen al IDE. Los acordes (`Ctrl+K` seguido de otra tecla) se
 * resuelven con una ventana de espera corta.
 */

import { runCommand } from './commands.js';

const CHORD_TIMEOUT_MS = 1400;

interface Binding {
  readonly key: string;
  readonly commandId: string;
}

/**
 * Notacion: `ctrl+shift+p`, `ctrl+k ctrl+o` (acorde). En macOS `ctrl` se
 * interpreta como la tecla de comando, que es lo que espera el usuario.
 */
const BINDINGS: readonly Binding[] = [
  { key: 'ctrl+shift+p', commandId: 'palette.open' },
  { key: 'ctrl+p', commandId: 'palette.openFiles' },
  { key: 'ctrl+shift+e', commandId: 'sidebar.explorer' },
  { key: 'ctrl+shift+f', commandId: 'sidebar.search' },
  { key: 'ctrl+shift+g', commandId: 'sidebar.git' },
  { key: 'ctrl+shift+d', commandId: 'sidebar.pipelines' },
  { key: 'ctrl+s', commandId: 'editor.save' },
  { key: 'ctrl+shift+s', commandId: 'editor.saveAll' },
  { key: 'ctrl+w', commandId: 'editor.closeTab' },
  { key: 'ctrl+b', commandId: 'view.toggleSidebar' },
  { key: 'ctrl+j', commandId: 'view.togglePanel' },
  { key: 'ctrl+i', commandId: 'ai.inlineEdit' },
  { key: 'ctrl+shift+i', commandId: 'ai.toggle' },
  { key: 'ctrl+shift+y', commandId: 'panel.output' },
  { key: 'ctrl+grave', commandId: 'panel.terminal' },
  { key: 'ctrl+shift+m', commandId: 'panel.problems' },
  { key: 'f5', commandId: 'pipeline.runDefault' },
  { key: 'shift+f5', commandId: 'pipeline.stopAll' },
  { key: 'ctrl+k ctrl+o', commandId: 'workspace.open' },
  { key: 'ctrl+k ctrl+w', commandId: 'editor.closeAll' },
  { key: 'ctrl+k ctrl+t', commandId: 'view.toggleTheme' },
];

const isMac = navigator.platform.toLowerCase().includes('mac');

function normalize(event: KeyboardEvent): string {
  const parts: string[] = [];
  // En macOS el modificador principal es Meta; se normaliza a `ctrl`.
  if (isMac ? event.metaKey : event.ctrlKey) {
    parts.push('ctrl');
  }
  if (event.altKey) {
    parts.push('alt');
  }
  if (event.shiftKey) {
    parts.push('shift');
  }
  const key = event.key.toLowerCase();
  const named: Record<string, string> = {
    ' ': 'space',
    '`': 'grave',
    escape: 'escape',
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
  };
  parts.push(named[key] ?? key);
  return parts.join('+');
}

/** Un campo de texto tiene prioridad salvo para los atajos de comando. */
function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Atajos que deben funcionar incluso con el foco en un campo de texto. */
const ALWAYS_ACTIVE = new Set([
  'ctrl+shift+p',
  'ctrl+p',
  'ctrl+s',
  'ctrl+shift+s',
  'ctrl+b',
  'ctrl+j',
  'ctrl+i',
  'escape',
]);

export function registerKeybindings(): void {
  let pendingChord: string | null = null;
  let chordTimer: number | null = null;

  const clearChord = (): void => {
    pendingChord = null;
    if (chordTimer !== null) {
      window.clearTimeout(chordTimer);
      chordTimer = null;
    }
  };

  window.addEventListener(
    'keydown',
    (event) => {
      const combo = normalize(event);

      if (pendingChord !== null) {
        const full = `${pendingChord} ${combo}`;
        clearChord();
        const binding = BINDINGS.find((entry) => entry.key === full);
        if (binding !== undefined) {
          event.preventDefault();
          void runCommand(binding.commandId);
          return;
        }
      }

      // Prefijo de acorde valido: se espera la segunda tecla.
      const isPrefix = BINDINGS.some((entry) => entry.key.startsWith(`${combo} `));
      if (isPrefix) {
        event.preventDefault();
        pendingChord = combo;
        chordTimer = window.setTimeout(clearChord, CHORD_TIMEOUT_MS);
        return;
      }

      if (isTextTarget(event.target) && !ALWAYS_ACTIVE.has(combo)) {
        return;
      }

      const binding = BINDINGS.find((entry) => entry.key === combo);
      if (binding !== undefined) {
        event.preventDefault();
        void runCommand(binding.commandId);
      }
    },
    { capture: true },
  );
}

/** Etiqueta legible del atajo asociado a un comando, para la paleta. */
export function keybindingFor(commandId: string): string | undefined {
  const binding = BINDINGS.find((entry) => entry.commandId === commandId);
  if (binding === undefined) {
    return undefined;
  }
  return binding.key
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((part) =>
          part === 'ctrl'
            ? isMac
              ? '⌘'
              : 'Ctrl'
            : part === 'shift'
              ? '⇧'
              : part === 'alt'
                ? isMac
                  ? '⌥'
                  : 'Alt'
                : part === 'grave'
                  ? '`'
                  : part.length === 1
                    ? part.toUpperCase()
                    : part[0]?.toUpperCase() + part.slice(1),
        )
        .join(isMac ? '' : '+'),
    )
    .join(' ');
}
