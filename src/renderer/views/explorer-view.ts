/**
 * Explorador de archivos.
 *
 * Arbol perezoso: cada carpeta se lee la primera vez que se expande y su
 * contenido se cachea hasta que el vigilante avisa de un cambio. Solo se
 * repintan las ramas abiertas, de modo que un repositorio con miles de
 * archivos no penaliza el arranque.
 */

import { h, svgIcon, debounce } from '../core/dom.js';
import { confirmDialog, promptDialog } from '../core/dialogs.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import type { DirEntry, GitFileState } from '../../shared/contracts.js';

const INDENT_PX = 12;

interface TreeNode {
  readonly entry: DirEntry;
  expanded: boolean;
  children: TreeNode[] | null;
}

let host: HTMLElement;
let rootNodes: TreeNode[] = [];
let selected: string | null = null;
const expandedPaths = new Set<string>();

export function registerExplorerView(): void {
  registerSidebarView('explorer', mount);

  defineCommands([
    {
      id: 'explorer.refresh',
      title: 'Explorador: actualizar',
      category: 'Explorador',
      run: () => refresh(),
    },
    {
      id: 'explorer.refreshQuiet',
      title: 'Explorador: actualizar en segundo plano',
      category: 'Explorador',
      run: () => scheduleRefresh(),
    },
    {
      id: 'explorer.newFile',
      title: 'Nuevo archivo…',
      category: 'Explorador',
      enabled: () => store.state.workspace !== null,
      run: () => createEntry('file'),
    },
    {
      id: 'explorer.newFolder',
      title: 'Nueva carpeta…',
      category: 'Explorador',
      enabled: () => store.state.workspace !== null,
      run: () => createEntry('directory'),
    },
    {
      id: 'explorer.rename',
      title: 'Renombrar…',
      category: 'Explorador',
      enabled: () => selected !== null,
      run: () => renameSelected(),
    },
    {
      id: 'explorer.delete',
      title: 'Eliminar',
      category: 'Explorador',
      enabled: () => selected !== null,
      run: () => deleteSelected(),
    },
    {
      id: 'workspace.refresh',
      title: 'Recargar el proyecto',
      category: 'Archivo',
      run: async () => {
        await Promise.all([
          refresh(),
          runCommand('dotforge.reload'),
          runCommand('toolchain.reload'),
          runCommand('git.refresh'),
        ]);
      },
    },
  ]);
}

function mount(context: SidebarViewContext): void {
  host = h('div', { class: 'tree', role: 'tree' });
  context.container.replaceChildren(host);

  const actions: [string, keyof typeof ICONS, string][] = [
    ['explorer.newFile', 'plus', 'Nuevo archivo'],
    ['explorer.newFolder', 'folder', 'Nueva carpeta'],
    ['explorer.refresh', 'refresh', 'Actualizar'],
  ];
  for (const [commandId, icon, label] of actions) {
    const button = h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label });
    button.appendChild(svgIcon(ICONS[icon], 13));
    button.addEventListener('click', () => void runCommand(commandId));
    context.actions.appendChild(button);
  }

  store.subscribe(['workspace'], () => void refresh());
  store.subscribe(['git'], render);
  void refresh();
}

const scheduleRefresh = debounce(() => void refresh(), 350);

async function refresh(): Promise<void> {
  if (host === undefined) {
    return;
  }
  if (store.state.workspace === null) {
    rootNodes = [];
    render();
    return;
  }
  rootNodes = await loadChildren('');
  // Se restauran las ramas que el usuario tenia abiertas.
  await Promise.all(rootNodes.map((node) => restoreExpansion(node)));
  render();
}

async function restoreExpansion(node: TreeNode): Promise<void> {
  if (node.entry.kind !== 'directory' || !expandedPaths.has(node.entry.path)) {
    return;
  }
  node.expanded = true;
  node.children = await loadChildren(node.entry.path);
  await Promise.all(node.children.map((child) => restoreExpansion(child)));
}

async function loadChildren(relativePath: string): Promise<TreeNode[]> {
  const result = await window.forge.fileSystem.readDir(relativePath);
  if (!result.ok) {
    if (result.error.code !== 'E_NO_WORKSPACE') {
      toastError('No se pudo leer la carpeta.', result.error);
    }
    return [];
  }
  return result.value.map((entry) => ({ entry, expanded: false, children: null }));
}

/** Estado de Git del archivo, para colorear la fila. */
function gitStateOf(path: string): GitFileState | null {
  const git = store.state.git;
  if (git === null) {
    return null;
  }
  const all = [...git.conflicted, ...git.staged, ...git.unstaged, ...git.untracked];
  const change = all.find((entry) => entry.path === path);
  if (change === undefined) {
    return null;
  }
  if (change.conflicted) {
    return 'conflicted';
  }
  return change.worktree === 'unmodified' ? change.index : change.worktree;
}

function render(): void {
  if (host === undefined) {
    return;
  }
  host.replaceChildren();

  if (store.state.workspace === null) {
    const open = h('button', { class: 'btn btn--primary', type: 'button' }, 'Abrir carpeta…');
    open.addEventListener('click', () => void runCommand('workspace.open'));
    const create = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Generar proyecto…');
    create.addEventListener('click', () => void runCommand('dotforge.newProject'));
    host.appendChild(
      h(
        'div',
        { class: 'empty-note', style: 'display:flex;flex-direction:column;gap:10px;align-items:center' },
        'No hay ninguna carpeta abierta.',
        open,
        create,
      ),
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const node of rootNodes) {
    appendNode(fragment, node, 0);
  }
  host.appendChild(fragment);
}

function appendNode(parent: Node, node: TreeNode, depth: number): void {
  parent.appendChild(renderRow(node, depth));
  if (node.expanded && node.children !== null) {
    for (const child of node.children) {
      appendNode(parent, child, depth + 1);
    }
  }
}

function renderRow(node: TreeNode, depth: number): HTMLElement {
  const isDirectory = node.entry.kind === 'directory';
  const gitState = gitStateOf(node.entry.path);

  const row = h('div', {
    class: 'tree__row',
    role: 'treeitem',
    title: node.entry.path,
    'data-selected': String(selected === node.entry.path),
    'data-git': gitState ?? '',
    'aria-expanded': isDirectory ? String(node.expanded) : null,
    style: `padding-left:${depth * INDENT_PX + 6}px`,
  });

  if (isDirectory) {
    const twisty = h('span', { class: 'tree__twisty', 'data-open': String(node.expanded) });
    twisty.appendChild(svgIcon(ICONS.chevronRight, 12));
    row.appendChild(twisty);
  } else {
    row.appendChild(h('span', { class: 'tree__twisty' }));
  }

  const icon = h('span', { class: 'tree__icon' });
  icon.appendChild(
    svgIcon(isDirectory ? (node.expanded ? ICONS.folderOpen : ICONS.folder) : ICONS.file, 14),
  );
  row.appendChild(icon);
  row.appendChild(h('span', { class: 'tree__label' }, node.entry.name));

  row.addEventListener('click', () => {
    selected = node.entry.path;
    if (isDirectory) {
      void toggle(node);
    } else {
      void runCommand('editor.openFile', node.entry.path);
      render();
    }
  });

  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    selected = node.entry.path;
    render();
    void runCommand('palette.open', 'Explorador: ');
  });

  return row;
}

async function toggle(node: TreeNode): Promise<void> {
  node.expanded = !node.expanded;
  if (node.expanded) {
    expandedPaths.add(node.entry.path);
    if (node.children === null) {
      node.children = await loadChildren(node.entry.path);
    }
  } else {
    expandedPaths.delete(node.entry.path);
  }
  render();
}

/* -------------------------------------------------------------------------- */
/*  Acciones                                                                   */
/* -------------------------------------------------------------------------- */

/** Carpeta base para crear: la seleccion si es carpeta, si no su padre. */
function baseDirectory(): string {
  if (selected === null) {
    return '';
  }
  const node = findNode(rootNodes, selected);
  if (node?.entry.kind === 'directory') {
    return node.entry.path;
  }
  const slash = selected.lastIndexOf('/');
  return slash === -1 ? '' : selected.slice(0, slash);
}

function findNode(nodes: readonly TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.entry.path === path) {
      return node;
    }
    if (node.children !== null) {
      const found = findNode(node.children, path);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * Valida un nombre de archivo o carpeta antes de enviarlo al guardian.
 * Adelantar aqui la comprobacion da un mensaje util en el propio dialogo en
 * lugar de un error generico despues.
 */
function validateEntryName(value: string): string | null {
  if (value === '') {
    return 'Escribe un nombre.';
  }
  if (value.includes('/') || value.includes('\\')) {
    return 'El nombre no puede contener barras.';
  }
  if (value === '.' || value === '..') {
    return 'Ese nombre esta reservado.';
  }
  if (/[<>:"|?*]/.test(value)) {
    return 'El nombre contiene caracteres no validos en Windows.';
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)) {
    return 'Ese nombre esta reservado por el sistema.';
  }
  return null;
}

async function createEntry(kind: 'file' | 'directory'): Promise<void> {
  const base = baseDirectory();
  const name = await promptDialog({
    title: kind === 'file' ? 'Nuevo archivo' : 'Nueva carpeta',
    label: 'Nombre',
    placeholder: kind === 'file' ? 'componente.tsx' : 'componentes',
    detail: base === '' ? 'Se creara en la raiz del workspace.' : `Se creara dentro de "${base}".`,
    confirmLabel: 'Crear',
    validate: validateEntryName,
  });
  if (name === null) {
    return;
  }
  const target = base === '' ? name : `${base}/${name}`;
  const result =
    kind === 'file'
      ? await window.forge.fileSystem.createFile(target, '')
      : await window.forge.fileSystem.createDir(target);
  if (!result.ok) {
    toastError('No se pudo crear el elemento.', result.error);
    return;
  }
  if (base !== '') {
    expandedPaths.add(base);
  }
  await refresh();
  if (kind === 'file') {
    await runCommand('editor.openFile', target);
  }
}

async function renameSelected(): Promise<void> {
  if (selected === null) {
    return;
  }
  const current = selected;
  const slash = current.lastIndexOf('/');
  const directory = slash === -1 ? '' : current.slice(0, slash);
  const name = current.slice(slash + 1);
  const next = await promptDialog({
    title: 'Renombrar',
    label: 'Nuevo nombre',
    value: name,
    detail: current,
    confirmLabel: 'Renombrar',
    validate: validateEntryName,
  });
  if (next === null || next === name) {
    return;
  }
  const target = directory === '' ? next : `${directory}/${next}`;
  const result = await window.forge.fileSystem.rename(current, target);
  if (!result.ok) {
    toastError('No se pudo renombrar.', result.error);
    return;
  }
  selected = target;
  await refresh();
}

async function deleteSelected(): Promise<void> {
  if (selected === null) {
    return;
  }
  const target = selected;
  const confirmed = await confirmDialog({
    title: 'Eliminar',
    message: `¿Eliminar "${target}"?`,
    detail: 'El IDE no puede deshacer esta accion.',
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  const result = await window.forge.fileSystem.remove(target);
  if (!result.ok) {
    toastError('No se pudo eliminar.', result.error);
    return;
  }
  selected = null;
  toast('info', `"${target}" eliminado.`);
  await refresh();
}
