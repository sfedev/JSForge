/**
 * Vista de control de fuentes.
 *
 * Secciones de cambios preparados, sin preparar, sin seguimiento y en
 * conflicto; caja de mensaje con enmienda; selector y creacion de ramas; y
 * apertura del visor de diferencias lado a lado en pestana dedicada.
 */

import { h, svgIcon, debounce } from '../core/dom.js';
import { confirmDialog, promptDialog, selectDialog } from '../core/dialogs.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import { openDiff } from './editor-area.js';
import type { GitBranch, GitFileChange } from '../../shared/contracts.js';

let container: HTMLElement;
let messageInput: HTMLTextAreaElement;
let amendCheckbox: HTMLInputElement;
let branchList: readonly GitBranch[] = [];

export function registerGitView(): void {
  registerSidebarView('git', mount);

  defineCommands([
    {
      id: 'git.refresh',
      title: 'Git: actualizar el estado',
      category: 'Git',
      run: () => refresh(),
    },
    {
      id: 'git.refreshQuiet',
      title: 'Git: actualizar en segundo plano',
      category: 'Git',
      run: () => scheduleRefresh(),
    },
    {
      id: 'git.stageAll',
      title: 'Git: preparar todos los cambios',
      category: 'Git',
      enabled: () => store.state.git?.isRepo === true,
      run: async () => {
        const git = store.state.git;
        if (git === null) {
          return;
        }
        const paths = [...git.unstaged, ...git.untracked].map((change) => change.path);
        if (paths.length === 0) {
          return;
        }
        const result = await window.forge.git.stage(paths);
        if (!result.ok) {
          toastError('No se pudieron preparar los cambios.', result.error);
        }
      },
    },
    {
      id: 'git.unstageAll',
      title: 'Git: quitar todo del area de preparacion',
      category: 'Git',
      enabled: () => (store.state.git?.staged.length ?? 0) > 0,
      run: async () => {
        const paths = store.state.git?.staged.map((change) => change.path) ?? [];
        if (paths.length === 0) {
          return;
        }
        const result = await window.forge.git.unstage(paths);
        if (!result.ok) {
          toastError('No se pudo deshacer la preparacion.', result.error);
        }
      },
    },
    {
      id: 'git.commit',
      title: 'Git: confirmar los cambios preparados',
      category: 'Git',
      enabled: () => store.state.git?.isRepo === true,
      run: () => doCommit(),
    },
    {
      id: 'git.switchBranch',
      title: 'Git: cambiar de rama…',
      category: 'Git',
      enabled: () => store.state.git?.isRepo === true,
      run: () => switchBranch(),
    },
    {
      id: 'git.createBranch',
      title: 'Git: crear una rama…',
      category: 'Git',
      enabled: () => store.state.git?.isRepo === true,
      run: () => createBranch(),
    },
    {
      id: 'git.openDiff',
      title: 'Git: abrir el visor de diferencias',
      category: 'Git',
      run: (argument) => {
        const target = argument as { path?: string; staged?: boolean } | undefined;
        if (target?.path !== undefined) {
          void showDiff(target.path, target.staged === true);
        }
      },
    },
  ]);
}

function mount(context: SidebarViewContext): void {
  messageInput = h('textarea', {
    class: 'textarea',
    rows: '3',
    placeholder: 'Mensaje del commit  (Ctrl+Enter para confirmar)',
    'aria-label': 'Mensaje del commit',
  }) as HTMLTextAreaElement;

  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void doCommit();
    }
  });

  amendCheckbox = h('input', { type: 'checkbox' }) as HTMLInputElement;
  amendCheckbox.addEventListener('change', () => {
    if (amendCheckbox.checked && messageInput.value.trim() === '') {
      // Enmendar sin mensaje reutiliza el del ultimo commit.
      void window.forge.git.log(1).then((result) => {
        if (result.ok && result.value[0] !== undefined) {
          messageInput.value = result.value[0].subject;
        }
      });
    }
  });

  const commitButton = h('button', { class: 'btn btn--primary', type: 'button' }, 'Confirmar');
  commitButton.addEventListener('click', () => void doCommit());

  const composer = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:6px;padding:8px;border-bottom:1px solid var(--border-subtle)' },
    messageInput,
    h(
      'div',
      { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px' },
      h('label', { class: 'checkbox' }, amendCheckbox, 'Enmendar'),
      commitButton,
    ),
  );

  container = h('div', {});
  context.container.replaceChildren(composer, container);

  const actions: [string, keyof typeof ICONS, string][] = [
    ['git.stageAll', 'plus', 'Preparar todo'],
    ['git.createBranch', 'branch', 'Crear una rama'],
    ['git.refresh', 'refresh', 'Actualizar'],
  ];
  for (const [commandId, icon, label] of actions) {
    const button = h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label });
    button.appendChild(svgIcon(ICONS[icon], 13));
    button.addEventListener('click', () => void runCommand(commandId));
    context.actions.appendChild(button);
  }

  store.subscribe(['git', 'workspace'], render);
  void refresh();
  render();
}

const scheduleRefresh = debounce(() => void refresh(), 400);

async function refresh(): Promise<void> {
  if (store.state.workspace === null) {
    store.patch({ git: null });
    return;
  }
  const [statusResult, branchResult] = await Promise.all([
    window.forge.git.status(),
    window.forge.git.branches(),
  ]);
  if (statusResult.ok) {
    store.patch({ git: statusResult.value });
  }
  if (branchResult.ok) {
    branchList = branchResult.value;
  }
}

/* -------------------------------------------------------------------------- */
/*  Acciones                                                                   */
/* -------------------------------------------------------------------------- */

async function doCommit(): Promise<void> {
  const message = messageInput.value.trim();
  if (message === '') {
    toast('warn', 'Escribe un mensaje para el commit.');
    messageInput.focus();
    return;
  }
  const git = store.state.git;
  if (git !== null && git.staged.length === 0 && !amendCheckbox.checked) {
    toast('warn', 'No hay cambios preparados.');
    return;
  }
  const result = await window.forge.git.commit({ message, amend: amendCheckbox.checked });
  if (!result.ok) {
    toastError('El commit fallo.', result.error);
    return;
  }
  messageInput.value = '';
  amendCheckbox.checked = false;
  toast('info', `Commit ${result.value.shortHash}`, result.value.subject);
  await refresh();
}

async function switchBranch(): Promise<void> {
  if (branchList.length === 0) {
    await refresh();
  }
  // Un selector filtrable evita tener que teclear el nombre exacto.
  const choice = await selectDialog({
    title: 'Cambiar de rama',
    placeholder: 'Filtrar ramas…',
    emptyMessage: 'No hay ramas que coincidan.',
    items: branchList.map((branch) => ({
      id: branch.name,
      label: branch.name,
      ...(branch.remote ? { hint: 'remota' } : branch.upstream !== undefined ? { hint: branch.upstream } : {}),
      ...(branch.current ? { current: true } : {}),
    })),
  });
  if (choice === null) {
    return;
  }
  const result = await window.forge.git.checkout(choice);
  if (!result.ok) {
    toastError('No se pudo cambiar de rama.', result.error);
    return;
  }
  await refresh();
  await runCommand('explorer.refresh');
}

async function createBranch(): Promise<void> {
  const existing = new Set(branchList.map((branch) => branch.name));
  const name = await promptDialog({
    title: 'Nueva rama',
    label: 'Nombre de la rama',
    placeholder: 'feature/mi-cambio',
    detail: 'Se crea a partir de la rama actual y se activa al momento.',
    confirmLabel: 'Crear rama',
    // Las mismas reglas que aplica el servicio, adelantadas al dialogo.
    validate: (value) => {
      if (value === '') {
        return 'Escribe un nombre.';
      }
      if (value.startsWith('-')) {
        return 'No puede empezar por "-".';
      }
      if (/[\s~^:?*[\\]/.test(value) || value.includes('..') || value.endsWith('.lock')) {
        return 'Git no admite ese nombre de referencia.';
      }
      if (existing.has(value)) {
        return 'Ya existe una rama con ese nombre.';
      }
      return null;
    },
  });
  if (name === null) {
    return;
  }
  const result = await window.forge.git.createBranch(name);
  if (!result.ok) {
    toastError('No se pudo crear la rama.', result.error);
    return;
  }
  toast('info', `Rama "${name}" creada y activa.`);
  await refresh();
}

async function showDiff(path: string, staged: boolean): Promise<void> {
  const result = await window.forge.git.diff({ path, staged });
  if (!result.ok) {
    toastError('No se pudo calcular la diferencia.', result.error);
    return;
  }
  const pair = result.value;
  if (pair.binary) {
    toast('warn', 'Archivo binario', 'No se puede mostrar una diferencia de texto.');
    return;
  }
  const name = path.split('/').pop() ?? path;
  openDiff(path, pair.original, pair.modified, `${name} (${pair.originalRef} ↔ ${pair.modifiedRef})`);
}

/* -------------------------------------------------------------------------- */
/*  Pintado                                                                    */
/* -------------------------------------------------------------------------- */

const STATE_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!',
  typechange: 'T',
  ignored: 'I',
  unmodified: ' ',
};

function changeRow(change: GitFileChange, kind: 'staged' | 'unstaged' | 'untracked' | 'conflicted'): HTMLElement {
  const state = kind === 'staged' ? change.index : change.worktree;
  const row = h('div', {
    class: 'list-row',
    title: change.originalPath === undefined ? change.path : `${change.originalPath} → ${change.path}`,
    'data-git': state,
  });

  const name = change.path.split('/').pop() ?? change.path;
  const directory = change.path.slice(0, change.path.length - name.length).replace(/\/$/, '');

  row.appendChild(h('span', { class: 'list-row__label' }, name));
  if (directory !== '') {
    row.appendChild(h('span', { class: 'list-row__hint', style: 'flex:1' }, directory));
  } else {
    row.appendChild(h('span', { style: 'flex:1' }));
  }

  const actions = h('div', { class: 'list-row__actions' });

  const diffButton = h('button', { class: 'icon-btn', type: 'button', title: 'Ver diferencias' });
  diffButton.appendChild(svgIcon(ICONS.diff, 12));
  diffButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void showDiff(change.path, kind === 'staged');
  });
  actions.appendChild(diffButton);

  if (kind === 'staged') {
    const unstageButton = h('button', { class: 'icon-btn', type: 'button', title: 'Quitar de la preparacion' });
    unstageButton.appendChild(svgIcon(ICONS.minus, 12));
    unstageButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      const result = await window.forge.git.unstage([change.path]);
      if (!result.ok) {
        toastError('No se pudo quitar de la preparacion.', result.error);
      }
    });
    actions.appendChild(unstageButton);
  } else if (kind !== 'conflicted') {
    const discardButton = h('button', { class: 'icon-btn btn--danger', type: 'button', title: 'Descartar los cambios' });
    discardButton.appendChild(svgIcon(ICONS.refresh, 12));
    discardButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      const confirmed = await confirmDialog({
        title: 'Descartar cambios',
        message: `¿Descartar los cambios de "${change.path}"?`,
        detail:
          kind === 'untracked'
            ? 'El archivo no tiene seguimiento, asi que se eliminara del disco.'
            : 'Se perdera todo lo editado desde el ultimo commit.',
        confirmLabel: 'Descartar',
        danger: true,
      });
      if (!confirmed) {
        return;
      }
      const result = await window.forge.git.discard([change.path]);
      if (!result.ok) {
        toastError('No se pudieron descartar los cambios.', result.error);
      }
    });
    actions.appendChild(discardButton);

    const stageButton = h('button', { class: 'icon-btn', type: 'button', title: 'Preparar' });
    stageButton.appendChild(svgIcon(ICONS.plus, 12));
    stageButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      const result = await window.forge.git.stage([change.path]);
      if (!result.ok) {
        toastError('No se pudo preparar el archivo.', result.error);
      }
    });
    actions.appendChild(stageButton);
  }

  row.appendChild(actions);
  row.appendChild(
    h(
      'span',
      { style: 'width:14px;text-align:center;font-weight:600;font-family:var(--font-mono)' },
      STATE_LETTER[state] ?? '?',
    ),
  );

  row.addEventListener('click', () => void showDiff(change.path, kind === 'staged'));
  return row;
}

function section(
  title: string,
  changes: readonly GitFileChange[],
  kind: 'staged' | 'unstaged' | 'untracked' | 'conflicted',
): HTMLElement | null {
  if (changes.length === 0) {
    return null;
  }
  const element = h('div', { class: 'section' });
  const header = h('div', { class: 'section__header' }, title);
  header.appendChild(h('span', { class: 'section__count' }, String(changes.length)));
  header.addEventListener('click', () => {
    element.dataset['collapsed'] = element.dataset['collapsed'] === 'true' ? 'false' : 'true';
  });
  const body = h('div', { class: 'section__body' });
  for (const change of changes) {
    body.appendChild(changeRow(change, kind));
  }
  element.append(header, body);
  return element;
}

function render(): void {
  if (container === undefined) {
    return;
  }
  container.replaceChildren();

  const git = store.state.git;
  if (store.state.workspace === null) {
    container.appendChild(h('div', { class: 'empty-note' }, 'Abre una carpeta para ver su repositorio.'));
    return;
  }
  if (git === null || !git.isRepo) {
    container.appendChild(
      h('div', { class: 'empty-note' }, 'Esta carpeta no es un repositorio de Git.'),
    );
    return;
  }

  const head = h('div', { class: 'chat__context', style: 'padding:8px' });
  head.appendChild(
    h('span', { class: 'chip', 'data-tone': 'accent' }, git.detached ? `${git.branch ?? 'HEAD'} (separada)` : (git.branch ?? 'HEAD')),
  );
  if (git.upstream !== undefined) {
    head.appendChild(h('span', { class: 'chip' }, git.upstream));
  }
  if (git.ahead > 0) {
    head.appendChild(h('span', { class: 'chip' }, `↑${git.ahead}`));
  }
  if (git.behind > 0) {
    head.appendChild(h('span', { class: 'chip' }, `↓${git.behind}`));
  }
  container.appendChild(head);

  const sections = [
    section('En conflicto', git.conflicted, 'conflicted'),
    section('Cambios preparados', git.staged, 'staged'),
    section('Cambios', git.unstaged, 'unstaged'),
    section('Sin seguimiento', git.untracked, 'untracked'),
  ].filter((element): element is HTMLElement => element !== null);

  if (sections.length === 0) {
    container.appendChild(h('div', { class: 'empty-note' }, 'El arbol de trabajo esta limpio.'));
    return;
  }
  for (const element of sections) {
    container.appendChild(element);
  }
}
