/**
 * Area de edicion: pestanas, modelos de Monaco y ciclo abrir/guardar/cerrar.
 *
 * Cada documento abierto tiene un `ITextModel` con URI estable
 * (`forge://workspace/<ruta>`), lo que permite que el cliente LSP y el visor
 * de diferencias se refieran al mismo documento sin ambiguedad. Los modelos
 * se conservan al cambiar de pestana para no perder el historial de deshacer.
 */

import type * as MonacoNs from 'monaco-editor';

import { h, svgIcon } from '../core/dom.js';
import { confirmDialog } from '../core/dialogs.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { findDocument, store, toggleBreakpoint, type OpenDocument } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { setCursorStatus } from './status-bar.js';
import { applyMonacoTheme, setupMonaco } from '../monaco/setup.js';
import { isBinaryPath, languageForPath } from '../monaco/languages.js';
import {
  disposeBreakpointsFor,
  mountBreakpoints,
  notifyBreakpointToggle,
} from '../editor/breakpoints.js';
import type { ShellMounts } from '../shell.js';

const MODEL_SCHEME = 'forge';
const DIFF_SCHEME = 'forge-diff';

let monaco: typeof MonacoNs;
let editor: MonacoNs.editor.IStandaloneCodeEditor | null = null;
let diffEditor: MonacoNs.editor.IStandaloneDiffEditor | null = null;
let editorHost: HTMLElement;
let diffHost: HTMLElement;
let emptyHost: HTMLElement;

/** Estados de vista (scroll, plegados, seleccion) por documento. */
const viewStates = new Map<string, MonacoNs.editor.ICodeEditorViewState | null>();

function modelUri(relativePath: string): MonacoNs.Uri {
  return monaco.Uri.from({ scheme: MODEL_SCHEME, authority: 'workspace', path: `/${relativePath}` });
}

function diffUri(relativePath: string, side: 'original' | 'modified'): MonacoNs.Uri {
  return monaco.Uri.from({
    scheme: DIFF_SCHEME,
    authority: side,
    path: `/${relativePath}`,
  });
}

/** Modelo del documento, creandolo si aun no existe. */
function ensureModel(relativePath: string, content: string): MonacoNs.editor.ITextModel {
  const uri = modelUri(relativePath);
  const existing = monaco.editor.getModel(uri);
  if (existing !== null) {
    if (existing.getValue() !== content) {
      existing.setValue(content);
    }
    return existing;
  }
  return monaco.editor.createModel(content, languageForPath(relativePath), uri);
}

export function mountEditorArea(mounts: ShellMounts): void {
  monaco = setupMonaco();
  editorHost = mounts.editorSurface;
  emptyHost = mounts.editorEmpty;

  diffHost = h('div', { class: 'editor-area__monaco', style: 'display:none' });
  editorHost.parentElement?.appendChild(diffHost);

  const settings = store.state.settings;

  editor = monaco.editor.create(editorHost, {
    theme: settings.theme,
    automaticLayout: true,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    fontLigatures: true,
    tabSize: settings.tabSize,
    minimap: { enabled: settings.minimap },
    wordWrap: settings.wordWrap ? 'on' : 'off',
    'semanticHighlighting.enabled': settings.semanticHighlighting,
    renderWhitespace: 'selection',
    renderLineHighlight: 'all',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    scrollBeyondLastLine: false,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    padding: { top: 8, bottom: 120 },
    fixedOverflowWidgets: true,
    stickyScroll: { enabled: true },
    inlayHints: { enabled: 'on' },
    suggest: { showStatusBar: true, preview: true },
    quickSuggestions: { other: true, comments: false, strings: true },
    formatOnPaste: true,
    linkedEditing: true,
    occurrencesHighlight: 'singleFile',
    unicodeHighlight: { ambiguousCharacters: true },
    accessibilitySupport: 'auto',
  });

  editor.onDidChangeCursorPosition((event) => {
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    let selected = 0;
    if (selection !== null && selection !== undefined && model !== null && model !== undefined) {
      selected = model.getValueInRange(selection).length;
    }
    setCursorStatus(event.position.lineNumber, event.position.column, selected);
  });

  editor.onDidChangeModelContent(() => {
    const active = store.state.activeDocument;
    if (active === null) {
      return;
    }
    const document = findDocument(active);
    if (document !== undefined && !document.dirty) {
      store.mutate(['documents'], (state) => {
        const entry = state.documents.find((item) => item.path === active);
        if (entry !== undefined) {
          entry.dirty = true;
        }
      });
    }
  });

  // Atajo de guardado dentro del editor (Monaco captura Ctrl+S antes que el
  // manejador global cuando tiene el foco).
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void runCommand('editor.save');
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
    void runCommand('ai.inlineEdit');
  });

  // El margen de puntos de interrupcion necesita el editor ya creado.
  mountBreakpoints(monaco, editor);

  renderTabs(mounts);
  store.subscribe(['documents', 'activeDocument', 'workspace'], () => renderTabs(mounts));
  store.subscribe(['settings'], applySettings);

  defineCommands([
    {
      id: 'editor.openFile',
      title: 'Abrir archivo',
      category: 'Archivo',
      run: (argument) => openFile(String(argument ?? '')),
    },
    {
      id: 'editor.save',
      title: 'Guardar',
      category: 'Archivo',
      enabled: () => store.state.activeDocument !== null,
      run: () => saveActive(),
    },
    {
      id: 'editor.saveAll',
      title: 'Guardar todo',
      category: 'Archivo',
      run: () => saveAll(),
    },
    {
      id: 'editor.closeTab',
      title: 'Cerrar la pestana',
      category: 'Archivo',
      enabled: () => store.state.activeDocument !== null,
      run: () => {
        const active = store.state.activeDocument;
        if (active !== null) {
          void closeDocument(active);
        }
      },
    },
    {
      id: 'editor.closeAll',
      title: 'Cerrar todas las pestanas',
      category: 'Archivo',
      run: () => {
        for (const document of [...store.state.documents]) {
          void closeDocument(document.path);
        }
      },
    },
    {
      id: 'editor.goToLine',
      title: 'Ir a la linea…',
      category: 'Editor',
      run: () => {
        editor?.focus();
        editor?.getAction('editor.action.gotoLine')?.run();
      },
    },
    {
      id: 'editor.format',
      title: 'Formatear el documento',
      category: 'Editor',
      run: () => formatActive(),
    },
    {
      id: 'editor.toggleBreakpointAtCursor',
      title: 'Alternar el punto de interrupcion en el cursor',
      category: 'Depuracion',
      enabled: () => store.state.activeDocument !== null,
      run: () => {
        const active = store.state.activeDocument;
        const line = editor?.getPosition()?.lineNumber;
        const document = active === null ? undefined : findDocument(active);
        // Las pestanas de diferencias no corresponden a un archivo real.
        if (active === null || line === undefined || document?.kind !== 'file') {
          return;
        }
        notifyBreakpointToggle(active, toggleBreakpoint(active, line));
      },
    },
    {
      id: 'editor.revealLine',
      title: 'Revelar una linea',
      category: 'Editor',
      run: (argument) => {
        const target = argument as { path?: string; line?: number } | undefined;
        if (target?.path === undefined) {
          return;
        }
        void openFile(target.path, target.line);
      },
    },
  ]);
}

function applySettings(): void {
  const settings = store.state.settings;
  applyMonacoTheme(settings.theme);
  editor?.updateOptions({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    tabSize: settings.tabSize,
    minimap: { enabled: settings.minimap },
    wordWrap: settings.wordWrap ? 'on' : 'off',
    'semanticHighlighting.enabled': settings.semanticHighlighting,
  });
}

/* -------------------------------------------------------------------------- */
/*  Pestanas                                                                   */
/* -------------------------------------------------------------------------- */

function renderTabs(mounts: ShellMounts): void {
  const state = store.state;
  mounts.editorTabs.replaceChildren();

  for (const document of state.documents) {
    const isActive = document.path === state.activeDocument;
    const tab = h('div', {
      class: 'tab',
      role: 'tab',
      'data-active': String(isActive),
      'data-dirty': String(document.dirty),
      title: document.path,
      'aria-selected': String(isActive),
    });

    tab.appendChild(svgIcon(document.kind === 'diff' ? ICONS.diff : ICONS.file, 13));
    tab.appendChild(h('span', { class: 'tab__label' }, document.title));

    const close = h('button', { class: 'tab__close', type: 'button', 'aria-label': 'Cerrar' });
    close.appendChild(svgIcon(ICONS.close, 11));
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeDocument(document.path);
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => activateDocument(document.path));
    tab.addEventListener('auxclick', (event) => {
      if ((event as MouseEvent).button === 1) {
        event.preventDefault();
        void closeDocument(document.path);
      }
    });
    mounts.editorTabs.appendChild(tab);
  }

  const hasDocuments = state.documents.length > 0;
  emptyHost.style.display = hasDocuments ? 'none' : 'flex';
  editorHost.style.display = hasDocuments ? 'block' : 'none';
  if (!hasDocuments) {
    renderWelcome();
  }
}

/**
 * Pantalla de bienvenida.
 *
 * Es el unico sitio donde el usuario mira al abrir el IDE sin proyecto, asi
 * que aqui viven las dos acciones de arranque: abrir una carpeta y generar
 * un proyecto nuevo con DotForge. Antes el generador solo existia en la
 * paleta de comandos y no habia forma de descubrirlo.
 */
function renderWelcome(): void {
  const hasWorkspace = store.state.workspace !== null;

  const action = (
    label: string,
    hint: string,
    icon: keyof typeof ICONS,
    commandId: string,
    primary: boolean,
  ): HTMLElement => {
    const button = h('button', {
      class: primary ? 'btn btn--primary' : 'btn btn--ghost',
      type: 'button',
      style: 'height:34px;padding-inline:14px',
    });
    button.append(svgIcon(ICONS[icon], 14), label);
    button.addEventListener('click', () => void runCommand(commandId));

    return h(
      'div',
      { style: 'display:flex;flex-direction:column;align-items:center;gap:6px' },
      button,
      h('span', { class: 'list-row__hint' }, hint),
    );
  };

  const actions = h('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;justify-content:center' });
  if (hasWorkspace) {
    actions.append(
      action('Ir al archivo', 'Ctrl+P', 'search', 'palette.openFiles', true),
      action('Nuevo archivo', '', 'plus', 'explorer.newFile', false),
      action('Generar proyecto', 'Blueprints DotForge', 'layers', 'dotforge.newProject', false),
    );
  } else {
    actions.append(
      action('Abrir carpeta', 'Ctrl+K Ctrl+O', 'folderOpen', 'workspace.open', true),
      action('Generar proyecto', '12 arquitecturas listas', 'layers', 'dotforge.newProject', false),
    );
  }

  emptyHost.replaceChildren(
    h(
      'p',
      { style: 'font-size:19px;font-weight:600;color:var(--text-strong);letter-spacing:-0.01em' },
      hasWorkspace ? (store.state.workspace?.name ?? 'ForgeJS IDE') : 'ForgeJS IDE',
    ),
    h(
      'p',
      { style: 'color:var(--text-muted);margin-bottom:8px' },
      hasWorkspace
        ? 'Ningun archivo abierto.'
        : 'Abre un proyecto existente o genera uno nuevo con el motor DotForge.',
    ),
    actions,
    h(
      'p',
      { style: 'margin-top:14px' },
      'Todos los comandos estan en la paleta: ',
      h('span', { class: 'kbd' }, 'Ctrl+Shift+P'),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/*  Apertura y activacion                                                      */
/* -------------------------------------------------------------------------- */

export async function openFile(relativePath: string, line?: number): Promise<void> {
  if (relativePath === '') {
    return;
  }
  if (isBinaryPath(relativePath)) {
    toast('warn', 'Archivo binario', `${relativePath} no se puede abrir en el editor.`);
    return;
  }

  const existing = findDocument(relativePath);
  if (existing !== undefined) {
    activateDocument(relativePath, line);
    return;
  }

  const result = await window.forge.fileSystem.readFile(relativePath);
  if (!result.ok) {
    toastError(`No se pudo abrir ${relativePath}.`, result.error);
    return;
  }
  const file = result.value;
  ensureModel(relativePath, file.content);

  const document: OpenDocument = {
    path: relativePath,
    title: relativePath.split('/').pop() ?? relativePath,
    languageId: languageForPath(relativePath),
    dirty: false,
    modifiedAt: file.modifiedAt,
    bom: file.bom,
    eol: file.eol,
    kind: 'file',
  };

  store.mutate(['documents', 'activeDocument'], (state) => {
    state.documents.push(document);
    state.activeDocument = relativePath;
  });
  activateDocument(relativePath, line);
  void runCommand('lsp.didOpen', relativePath);
}

export function activateDocument(relativePath: string, line?: number): void {
  const document = findDocument(relativePath);
  if (document === undefined || editor === null) {
    return;
  }

  // Guarda el estado de la pestana que se abandona.
  const previous = store.state.activeDocument;
  if (previous !== null && previous !== relativePath) {
    viewStates.set(previous, editor.saveViewState());
  }

  if (document.kind === 'diff') {
    showDiffDocument(document);
  } else {
    diffHost.style.display = 'none';
    editorHost.style.display = 'block';
    const model = monaco.editor.getModel(modelUri(relativePath));
    if (model !== null) {
      editor.setModel(model);
      const saved = viewStates.get(relativePath);
      if (saved !== undefined && saved !== null) {
        editor.restoreViewState(saved);
      }
    }
    if (line !== undefined) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
    editor.focus();
  }

  store.patch({ activeDocument: relativePath });
}

function showDiffDocument(document: OpenDocument): void {
  editorHost.style.display = 'none';
  diffHost.style.display = 'block';
  if (diffEditor === null) {
    diffEditor = monaco.editor.createDiffEditor(diffHost, {
      theme: store.state.settings.theme,
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontFamily: store.state.settings.fontFamily,
      fontSize: store.state.settings.fontSize,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      diffAlgorithm: 'advanced',
    });
  }
  const original = monaco.editor.getModel(diffUri(document.path, 'original'));
  const modified = monaco.editor.getModel(diffUri(document.path, 'modified'));
  if (original !== null && modified !== null) {
    diffEditor.setModel({ original, modified });
  }
}

/** Abre una pestana de diferencias lado a lado con modelos `forge-diff:`. */
export function openDiff(
  relativePath: string,
  original: string,
  modified: string,
  title: string,
): void {
  const language = languageForPath(relativePath);
  const originalUri = diffUri(relativePath, 'original');
  const modifiedUri = diffUri(relativePath, 'modified');

  const originalModel =
    monaco.editor.getModel(originalUri) ?? monaco.editor.createModel(original, language, originalUri);
  originalModel.setValue(original);
  const modifiedModel =
    monaco.editor.getModel(modifiedUri) ?? monaco.editor.createModel(modified, language, modifiedUri);
  modifiedModel.setValue(modified);

  const key = `${DIFF_SCHEME}:${relativePath}`;
  if (findDocument(key) === undefined) {
    store.mutate(['documents'], (state) => {
      state.documents.push({
        path: key,
        title,
        languageId: language,
        dirty: false,
        modifiedAt: 0,
        bom: false,
        eol: 'lf',
        kind: 'diff',
        diffAgainst: relativePath,
      });
    });
  }
  store.patch({ activeDocument: key });
  const document = findDocument(key);
  if (document !== undefined) {
    showDiffDocument({ ...document, path: relativePath });
  }
}

export async function closeDocument(pathOrKey: string): Promise<void> {
  const document = findDocument(pathOrKey);
  if (document === undefined) {
    return;
  }
  if (document.dirty) {
    const keep = await confirmDialog({
      title: 'Cambios sin guardar',
      message: `"${document.title}" tiene cambios sin guardar.`,
      detail: 'Si cierras la pestana, se perderan.',
      confirmLabel: 'Cerrar sin guardar',
      cancelLabel: 'Seguir editando',
      danger: true,
    });
    if (!keep) {
      return;
    }
  }

  if (document.kind === 'file') {
    monaco.editor.getModel(modelUri(document.path))?.dispose();
    void runCommand('lsp.didClose', document.path);
  } else {
    const target = document.diffAgainst ?? document.path;
    monaco.editor.getModel(diffUri(target, 'original'))?.dispose();
    monaco.editor.getModel(diffUri(target, 'modified'))?.dispose();
  }
  viewStates.delete(pathOrKey);
  disposeBreakpointsFor(document.path);

  store.mutate(['documents', 'activeDocument'], (state) => {
    const index = state.documents.findIndex((entry) => entry.path === pathOrKey);
    if (index !== -1) {
      state.documents.splice(index, 1);
    }
    if (state.activeDocument === pathOrKey) {
      const next = state.documents[Math.min(index, state.documents.length - 1)];
      state.activeDocument = next?.path ?? null;
    }
  });

  const nextActive = store.state.activeDocument;
  if (nextActive !== null) {
    activateDocument(nextActive);
  } else {
    editor?.setModel(null);
  }
}

/* -------------------------------------------------------------------------- */
/*  Guardado                                                                   */
/* -------------------------------------------------------------------------- */

async function formatActive(): Promise<string | null> {
  const active = store.state.activeDocument;
  const document = active === null ? undefined : findDocument(active);
  if (document === undefined || document.kind !== 'file' || editor === null) {
    return null;
  }
  const model = monaco.editor.getModel(modelUri(document.path));
  if (model === null) {
    return null;
  }
  const result = await window.forge.format.document({
    path: document.path,
    content: model.getValue(),
    languageId: document.languageId,
  });
  if (!result.ok) {
    // El formateo es una comodidad: si falla, no se bloquea el guardado.
    return null;
  }
  if (result.value.changed) {
    const position = editor.getPosition();
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: result.value.content }],
      () => null,
    );
    if (position !== null) {
      editor.setPosition(position);
    }
  }
  return result.value.content;
}

export async function saveActive(): Promise<void> {
  const active = store.state.activeDocument;
  if (active === null) {
    return;
  }
  await saveDocument(active);
}

async function saveDocument(pathOrKey: string): Promise<void> {
  const document = findDocument(pathOrKey);
  if (document === undefined || document.kind !== 'file') {
    return;
  }
  const model = monaco.editor.getModel(modelUri(document.path));
  if (model === null) {
    return;
  }

  if (store.state.settings.formatOnSave) {
    await formatActive();
  }

  const result = await window.forge.fileSystem.writeFile({
    path: document.path,
    content: model.getValue(),
    bom: document.bom,
    eol: document.eol,
    expectedModifiedAt: document.modifiedAt,
  });

  if (!result.ok) {
    if (result.error.code === 'E_CONFLICT') {
      const overwrite = await confirmDialog({
        title: 'El archivo cambio en el disco',
        message: `"${document.title}" fue modificado fuera del IDE desde que se abrio.`,
        detail: 'Si sobrescribes, se perderan esos cambios externos.',
        confirmLabel: 'Sobrescribir',
        cancelLabel: 'Cancelar',
        danger: true,
      });
      if (!overwrite) {
        return;
      }
      const forced = await window.forge.fileSystem.writeFile({
        path: document.path,
        content: model.getValue(),
        bom: document.bom,
        eol: document.eol,
      });
      if (!forced.ok) {
        toastError(`No se pudo guardar ${document.title}.`, forced.error);
        return;
      }
      markSaved(document.path, forced.value.modifiedAt);
      return;
    }
    toastError(`No se pudo guardar ${document.title}.`, result.error);
    return;
  }

  markSaved(document.path, result.value.modifiedAt);
  void runCommand('lsp.didSave', document.path);
}

function markSaved(path: string, modifiedAt: number): void {
  store.mutate(['documents'], (state) => {
    const entry = state.documents.find((item) => item.path === path);
    if (entry !== undefined) {
      entry.dirty = false;
      entry.modifiedAt = modifiedAt;
    }
  });
}

async function saveAll(): Promise<void> {
  for (const document of store.state.documents) {
    if (document.dirty && document.kind === 'file') {
      await saveDocument(document.path);
    }
  }
}

/** Acceso controlado al editor para otras vistas (IA en linea, LSP). */
export function getEditor(): MonacoNs.editor.IStandaloneCodeEditor | null {
  return editor;
}

export function getMonaco(): typeof MonacoNs {
  return monaco;
}

export function getModelUri(relativePath: string): MonacoNs.Uri {
  return modelUri(relativePath);
}
