/**
 * Panel lateral de Forge AI.
 *
 * El renderer nunca ve las claves API ni habla con ningun proveedor: compone
 * la peticion, la envia por IPC y pinta el flujo de tokens que devuelve el
 * proceso principal.
 */

import { copyToClipboard, h, svgIcon } from '../core/dom.js';
import { promptDialog } from '../core/dialogs.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store, type AiConversationMessage } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { getEditor } from './editor-area.js';
import { collapseContext, diffLines } from '../core/diff.js';
import type { ShellMounts } from '../shell.js';
import type {
  AiContextRequest,
  AiProviderId,
  AiQuickAction,
  AiStreamEvent,
} from '../../shared/contracts.js';

const QUICK_ACTIONS: readonly { id: AiQuickAction; label: string; prompt: string }[] = [
  { id: 'explain', label: 'Explicar', prompt: 'Explica que hace este codigo y por que.' },
  {
    id: 'test-vitest',
    label: 'Generar test Vitest',
    prompt: 'Genera pruebas unitarias con Vitest para este codigo.',
  },
  {
    id: 'to-typescript',
    label: 'Convertir a TypeScript',
    prompt: 'Convierte este codigo a TypeScript estricto, sin usar `any`.',
  },
  {
    id: 'optimize-component',
    label: 'Optimizar componente',
    prompt: 'Optimiza este componente: renders innecesarios, memoizacion y accesibilidad.',
  },
  {
    id: 'dotforge-pipeline',
    label: 'Generar pipeline DotForge',
    prompt:
      'Propon un pipeline de DotForge para este proyecto y devuelve el fragmento de dotforge.config.json.',
  },
];

let messageHost: HTMLElement;
let composer: HTMLTextAreaElement;
let sendButton: HTMLButtonElement;
let providerSelect: HTMLSelectElement;
let modelSelect: HTMLSelectElement;
let contextHost: HTMLElement;

let requestCounter = 0;

export function mountAiPanel(mounts: ShellMounts): void {
  const header = h(
    'div',
    { class: 'sidebar__header' },
    h('span', {}, 'Forge AI'),
  );
  const headerActions = h('div', { style: 'display:flex;gap:2px' });

  const keyButton = h('button', { class: 'icon-btn', type: 'button', title: 'Configurar la clave API' });
  keyButton.appendChild(svgIcon(ICONS.settings, 13));
  keyButton.addEventListener('click', () => void runCommand('ai.configureKey'));

  // La papelera limpia la conversacion; la X cierra el panel. Antes ambas
  // eran la misma aspa y la X no cerraba nada.
  const clearButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Limpiar la conversacion',
    'aria-label': 'Limpiar la conversacion',
  });
  clearButton.appendChild(svgIcon(ICONS.trash, 13));
  clearButton.addEventListener('click', () => store.patch({ aiMessages: [] }));

  const closeButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Cerrar el panel (Ctrl+Shift+I)',
    'aria-label': 'Cerrar el panel de Forge AI',
  });
  closeButton.appendChild(svgIcon(ICONS.close, 13));
  closeButton.addEventListener('click', () => store.patch({ auxVisible: false }));

  headerActions.append(keyButton, clearButton, closeButton);
  header.appendChild(headerActions);

  providerSelect = h('select', { class: 'select', 'aria-label': 'Proveedor' }) as HTMLSelectElement;
  modelSelect = h('select', { class: 'select', 'aria-label': 'Modelo' }) as HTMLSelectElement;
  const selectors = h(
    'div',
    { style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;border-bottom:1px solid var(--border-subtle)' },
    providerSelect,
    modelSelect,
  );

  messageHost = h('div', { class: 'chat__log' });
  contextHost = h('div', { class: 'chat__context' });

  composer = h('textarea', {
    class: 'textarea',
    rows: '3',
    placeholder: 'Pregunta algo sobre el proyecto…  (Ctrl+Enter para enviar)',
    'aria-label': 'Mensaje para Forge AI',
  }) as HTMLTextAreaElement;

  const actions = h('div', { class: 'chat__actions' });
  for (const action of QUICK_ACTIONS) {
    const button = h('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, action.label);
    button.addEventListener('click', () => void send(action.prompt, action.id));
    actions.appendChild(button);
  }

  sendButton = h('button', { class: 'btn btn--primary', type: 'button' }, 'Enviar') as HTMLButtonElement;
  sendButton.addEventListener('click', () => {
    const text = composer.value.trim();
    if (text !== '') {
      void send(text, 'chat');
    }
  });

  const stopButton = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Detener');
  stopButton.addEventListener('click', () => {
    const busy = store.state.aiBusyRequestId;
    if (busy !== null) {
      void window.forge.ai.cancel(busy);
    }
  });

  composer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendButton.click();
    }
  });

  const composerBox = h(
    'div',
    { class: 'chat__composer' },
    contextHost,
    composer,
    actions,
    h('div', { style: 'display:flex;gap:6px;justify-content:flex-end' }, stopButton, sendButton),
  );

  const chat = h('div', { class: 'chat' }, messageHost, composerBox);
  mounts.aux.append(header, selectors, chat);

  providerSelect.addEventListener('change', () => {
    void applyProvider(providerSelect.value as AiProviderId);
  });
  modelSelect.addEventListener('change', () => {
    void window.forge.settings.set({ aiModel: modelSelect.value });
  });

  store.subscribe(['aiMessages', 'aiBusyRequestId'], renderMessages);
  store.subscribe(['activeDocument', 'workspace'], renderContextChips);
  store.subscribe(['aiProviders', 'settings'], renderProviders);

  void loadProviders();
  renderMessages();
  renderContextChips();

  defineCommands([
    {
      id: 'ai.handleStream',
      title: 'IA: procesar flujo',
      category: 'IA',
      run: (argument) => handleStream(argument as AiStreamEvent),
    },
    {
      id: 'ai.inlineEdit',
      title: 'IA: editar en linea la seleccion',
      category: 'IA',
      enabled: () => store.state.settings.aiEnabled,
      run: () => inlineEdit(),
    },
    {
      id: 'ai.configureKey',
      title: 'IA: configurar la clave API',
      category: 'IA',
      enabled: () => store.state.settings.aiEnabled,
      run: () => configureKey(),
    },
    {
      id: 'ai.explainSelection',
      title: 'IA: explicar la seleccion',
      category: 'IA',
      enabled: () => store.state.settings.aiEnabled,
      run: () => send('Explica que hace este codigo y por que.', 'explain'),
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/*  Proveedores                                                                */
/* -------------------------------------------------------------------------- */

async function loadProviders(): Promise<void> {
  const result = await window.forge.ai.providers();
  if (!result.ok) {
    return;
  }
  store.patch({ aiProviders: [...result.value] });
}

function renderProviders(): void {
  const providers = store.state.aiProviders;
  const settings = store.state.settings;
  if (providers.length === 0) {
    return;
  }

  providerSelect.replaceChildren();
  for (const provider of providers) {
    const label = provider.requiresKey && !provider.hasKey ? `${provider.label} (sin clave)` : provider.label;
    const option = h('option', { value: provider.id }, label);
    providerSelect.appendChild(option);
  }
  providerSelect.value = settings.aiProvider;

  const active = providers.find((provider) => provider.id === settings.aiProvider) ?? providers[0];
  modelSelect.replaceChildren();
  for (const model of active?.models ?? []) {
    modelSelect.appendChild(h('option', { value: model }, model));
  }
  const models = active?.models ?? [];
  modelSelect.value = models.includes(settings.aiModel)
    ? settings.aiModel
    : (active?.defaultModel ?? '');
}

async function applyProvider(provider: AiProviderId): Promise<void> {
  const info = store.state.aiProviders.find((entry) => entry.id === provider);
  const model = info?.defaultModel ?? store.state.settings.aiModel;
  const result = await window.forge.settings.set({ aiProvider: provider, aiModel: model });
  if (result.ok) {
    store.patch({ settings: result.value });
  }
}

async function configureKey(): Promise<void> {
  const provider = store.state.settings.aiProvider;
  const info = store.state.aiProviders.find((entry) => entry.id === provider);
  if (info !== undefined && !info.requiresKey) {
    toast('info', `${info.label} no necesita clave API.`);
    return;
  }
  if (info !== undefined && !info.secureStorage) {
    toast(
      'warn',
      'El almacenamiento cifrado del sistema no esta disponible.',
      'La clave no se guardaria de forma segura, asi que no se pedira.',
    );
    return;
  }
  const key = await promptDialog({
    title: `Clave API de ${info?.label ?? provider}`,
    label: 'Clave',
    secret: true,
    placeholder: provider === 'anthropic' ? 'sk-ant-…' : 'sk-…',
    detail:
      'Se cifra con el almacen del sistema operativo y nunca sale del proceso principal.',
    confirmLabel: 'Guardar',
    validate: (value) => (value.length < 8 ? 'La clave parece demasiado corta.' : null),
  });
  if (key === null) {
    return;
  }
  const result = await window.forge.ai.setKey(provider, key);
  if (!result.ok) {
    toastError('No se pudo guardar la clave.', result.error);
    return;
  }
  toast('info', 'Clave guardada y cifrada con el almacen del sistema.');
  await loadProviders();
}

/* -------------------------------------------------------------------------- */
/*  Contexto RAG                                                               */
/* -------------------------------------------------------------------------- */

function buildContext(): AiContextRequest {
  const editor = getEditor();
  const activeDocument = store.state.activeDocument;
  const context: {
    activeFile?: string;
    includeActiveFileContent: boolean;
    includeDotForge: boolean;
    includeDependencies: boolean;
    selection?: { path: string; startLine: number; endLine: number; text: string };
  } = {
    includeActiveFileContent: true,
    includeDotForge: true,
    includeDependencies: true,
  };

  if (activeDocument !== null && !activeDocument.startsWith('forge-diff:')) {
    context.activeFile = activeDocument;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    if (selection !== null && selection !== undefined && model !== null && model !== undefined && !selection.isEmpty()) {
      context.selection = {
        path: activeDocument,
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
        text: model.getValueInRange(selection),
      };
    }
  }
  return context;
}

function renderContextChips(): void {
  const context = buildContext();
  const chips: HTMLElement[] = [];
  if (context.activeFile !== undefined) {
    chips.push(h('span', { class: 'chip', 'data-tone': 'accent' }, context.activeFile));
  }
  if (context.selection !== undefined) {
    chips.push(
      h(
        'span',
        { class: 'chip' },
        `seleccion ${context.selection.startLine}-${context.selection.endLine}`,
      ),
    );
  }
  if (store.state.manifest?.found === true) {
    chips.push(h('span', { class: 'chip' }, 'dotforge.config.json'));
  }
  contextHost.replaceChildren(...chips);
}

/* -------------------------------------------------------------------------- */
/*  Envio y streaming                                                          */
/* -------------------------------------------------------------------------- */

async function send(prompt: string, preset: AiQuickAction, forcedRequestId?: string): Promise<void> {
  if (!store.state.settings.aiEnabled) {
    toast('info', 'Forge AI esta desactivado.', 'Puedes activarlo en las preferencias.');
    return;
  }
  if (store.state.aiBusyRequestId !== null) {
    toast('warn', 'Espera a que termine la respuesta en curso.');
    return;
  }
  const settings = store.state.settings;
  requestCounter += 1;
  const requestId = forcedRequestId ?? `ai-${Date.now()}-${requestCounter}`;

  const history = store.state.aiMessages
    .filter((message) => message.error === undefined)
    .map((message) => ({ role: message.role, content: message.content }));

  store.mutate(['aiMessages', 'aiBusyRequestId'], (state) => {
    state.aiMessages.push({ id: `${requestId}-user`, role: 'user', content: prompt, streaming: false });
    state.aiMessages.push({ id: requestId, role: 'assistant', content: '', streaming: true });
    state.aiBusyRequestId = requestId;
  });
  composer.value = '';

  const result = await window.forge.ai.chat({
    requestId,
    provider: settings.aiProvider,
    model: modelSelect.value === '' ? settings.aiModel : modelSelect.value,
    messages: [...history, { role: 'user', content: prompt }],
    context: buildContext(),
    systemPreset: preset,
  });

  if (!result.ok) {
    handleStream({ kind: 'error', requestId, error: result.error });
  }
}

function handleStream(event: AiStreamEvent): void {
  if (event.kind === 'done' && pendingInlineEdit?.requestId === event.requestId) {
    const message = store.state.aiMessages.find((entry) => entry.id === event.requestId);
    const content = event.text !== '' ? event.text : (message?.content ?? '');
    showInlinePreview(content);
  }

  store.mutate(['aiMessages', 'aiBusyRequestId'], (state) => {
    const message = state.aiMessages.find((entry) => entry.id === event.requestId);
    if (message === undefined) {
      return;
    }
    switch (event.kind) {
      case 'start':
        message.streaming = true;
        break;
      case 'delta':
        message.content += event.text;
        break;
      case 'done':
        message.streaming = false;
        if (event.text !== '' && message.content === '') {
          message.content = event.text;
        }
        state.aiBusyRequestId = null;
        break;
      case 'error':
        message.streaming = false;
        message.error = event.error.message;
        state.aiBusyRequestId = null;
        break;
      default:
        break;
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  Pintado                                                                    */
/* -------------------------------------------------------------------------- */

/** Divide la respuesta en bloques de texto y de codigo, sin usar innerHTML. */
function renderContent(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const parts = content.split(/```/);
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part !== '') {
        fragment.appendChild(document.createTextNode(part));
      }
      return;
    }
    const newline = part.indexOf('\n');
    const code = newline === -1 ? part : part.slice(newline + 1);
    const pre = h('pre', {});
    pre.appendChild(h('code', {}, code));

    const copy = h('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, 'Copiar');
    copy.addEventListener('click', async () => {
      const copiado = await copyToClipboard(code);
      toast(
        copiado ? 'info' : 'warn',
        copiado ? 'Codigo copiado al portapapeles.' : 'No se pudo copiar al portapapeles.',
      );
    });
    fragment.append(pre, copy);
  });
  return fragment;
}

function renderMessages(): void {
  const messages = store.state.aiMessages;
  messageHost.replaceChildren();

  if (messages.length === 0) {
    messageHost.appendChild(
      h(
        'div',
        { class: 'empty-note' },
        'Forge AI usa el archivo activo, la seleccion, los diagnosticos y la configuracion DotForge como contexto.',
      ),
    );
  }

  for (const message of messages) {
    messageHost.appendChild(renderMessage(message));
  }
  messageHost.scrollTop = messageHost.scrollHeight;

  const busy = store.state.aiBusyRequestId !== null;
  sendButton.disabled = busy;
  sendButton.textContent = busy ? 'Generando…' : 'Enviar';
}

function renderMessage(message: AiConversationMessage): HTMLElement {
  const bubble = h('div', { class: 'chat__bubble' });
  if (message.error !== undefined) {
    bubble.appendChild(h('span', { style: 'color:var(--state-error)' }, message.error));
  } else if (message.content === '' && message.streaming) {
    bubble.appendChild(h('span', { style: 'color:var(--text-subtle)' }, 'Pensando…'));
  } else {
    bubble.appendChild(renderContent(message.content));
  }

  return h(
    'div',
    { class: 'chat__message', 'data-role': message.role },
    h('div', { class: 'chat__role' }, message.role === 'user' ? 'Tu' : 'Forge AI'),
    bubble,
  );
}

/* -------------------------------------------------------------------------- */
/*  Asistente en linea                                                         */
/* -------------------------------------------------------------------------- */

interface PendingInlineEdit {
  readonly requestId: string;
  readonly original: string;
  readonly range: MonacoRange;
}

/** Forma minima del rango de Monaco que necesita la aplicacion del parche. */
interface MonacoRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

let pendingInlineEdit: PendingInlineEdit | null = null;

async function inlineEdit(): Promise<void> {
  if (!store.state.settings.aiEnabled) {
    toast('info', 'Forge AI esta desactivado.', 'Puedes activarlo en las preferencias.');
    return;
  }
  const editor = getEditor();
  const selection = editor?.getSelection();
  const model = editor?.getModel();
  if (editor === null || selection === null || selection === undefined || model === null || model === undefined) {
    toast('warn', 'Selecciona el codigo que quieres refactorizar.');
    return;
  }
  if (selection.isEmpty()) {
    toast('warn', 'Selecciona el codigo que quieres refactorizar.');
    return;
  }
  const instruction = await promptDialog({
    title: 'Editar con Forge AI',
    label: '¿Que cambio quieres aplicar?',
    placeholder: 'Extrae esto a una funcion con nombre y anade tipos explicitos',
    detail: `Se enviaran las lineas ${selection.startLineNumber}-${selection.endLineNumber} y el contexto del proyecto.`,
    confirmLabel: 'Generar',
    multiline: true,
  });
  if (instruction === null) {
    return;
  }

  const requestId = `ai-inline-${Date.now()}`;
  pendingInlineEdit = {
    requestId,
    original: model.getValueInRange(selection),
    range: {
      startLineNumber: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLineNumber: selection.endLineNumber,
      endColumn: selection.endColumn,
    },
  };

  store.patch({ auxVisible: true });
  await send(
    `${instruction.trim()}\n\nDevuelve unicamente el codigo resultante en un bloque, sin explicacion.`,
    'inline-edit',
    requestId,
  );
}

/** Extrae el primer bloque de codigo de la respuesta; si no hay, usa todo. */
function extractCodeBlock(content: string): string {
  const match = /```[^\n]*\n([\s\S]*?)```/.exec(content);
  if (match?.[1] !== undefined) {
    return match[1].replace(/\n$/, '');
  }
  return content.trim();
}

/** Vista previa de diferencias antes de tocar el documento. */
function showInlinePreview(content: string): void {
  const pending = pendingInlineEdit;
  pendingInlineEdit = null;
  if (pending === null) {
    return;
  }

  const proposed = extractCodeBlock(content);
  if (proposed === '' || proposed === pending.original) {
    toast('info', 'El asistente no propuso ningun cambio.');
    return;
  }

  const summary = diffLines(pending.original, proposed);
  const body = h('div', {
    style:
      'font-family:var(--font-mono);font-size:var(--font-size-sm);white-space:pre;overflow:auto;max-height:52vh;user-select:text',
  });

  for (const line of collapseContext(summary, 3)) {
    const prefix = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
    const background =
      line.kind === 'added'
        ? 'var(--state-success-soft)'
        : line.kind === 'removed'
          ? 'var(--state-error-soft)'
          : 'transparent';
    body.appendChild(
      h(
        'div',
        { style: `background:${background};padding:0 6px` },
        `${prefix} ${line.text}`,
      ),
    );
  }

  const apply = h('button', { class: 'btn btn--primary', type: 'button' }, 'Aplicar');
  const cancel = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Descartar');

  const dialog = h(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-label': 'Vista previa del cambio' },
    h(
      'div',
      { class: 'dialog__header' },
      'Vista previa del cambio',
      h(
        'span',
        { class: 'chip', style: 'margin-left:auto' },
        `+${summary.added} −${summary.removed}${summary.approximate ? ' (aproximado)' : ''}`,
      ),
    ),
    h('div', { class: 'dialog__body' }, body),
    h('div', { class: 'dialog__footer' }, cancel, apply),
  );
  const overlay = h('div', { class: 'overlay overlay--center' }, dialog);
  document.querySelector('.overlays')?.appendChild(overlay);

  const close = (): void => overlay.remove();
  cancel.addEventListener('click', close);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  apply.addEventListener('click', () => {
    const editor = getEditor();
    const model = editor?.getModel();
    if (editor === null || model === null || model === undefined) {
      close();
      return;
    }
    // Se aplica como una sola operacion para que Ctrl+Z la deshaga entera.
    editor.executeEdits('forge-ai-inline', [
      {
        range: {
          startLineNumber: pending.range.startLineNumber,
          startColumn: pending.range.startColumn,
          endLineNumber: pending.range.endLineNumber,
          endColumn: pending.range.endColumn,
        },
        text: proposed,
        forceMoveMarkers: true,
      },
    ]);
    editor.focus();
    close();
    toast('info', 'Cambio aplicado.', 'Ctrl+Z lo deshace por completo.');
  });
}
