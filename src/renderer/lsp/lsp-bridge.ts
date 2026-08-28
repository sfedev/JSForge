/**
 * Puente entre Monaco y los servidores de lenguaje.
 *
 * Registra un proveedor por capacidad (autocompletado, hover, definicion,
 * referencias, renombrado, ayuda de firma, simbolos, acciones de codigo,
 * pistas en linea y tokens semanticos) y mantiene sincronizado el ciclo
 * `didOpen` / `didChange` / `didSave` / `didClose`.
 *
 * Cuando un servidor no esta instalado, sus proveedores devuelven vacio: el
 * editor sigue funcionando con el resaltado y el autocompletado de Monaco.
 */

import type * as MonacoNs from 'monaco-editor';

import type { LanguageServerId, LspServerNotification } from '../../shared/contracts.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { getMonaco, getModelUri } from '../views/editor-area.js';
import {
  fromFileUri,
  toCompletionKind,
  toFileUri,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toMarker,
  toMonacoRange,
  toSymbolKind,
  type LspDiagnostic,
  type LspRange,
} from './protocol.js';

let monaco: typeof MonacoNs;

/** Lenguaje de Monaco -> servidor responsable. */
const SERVER_BY_LANGUAGE: Readonly<Record<string, LanguageServerId>> = {
  typescript: 'typescript',
  javascript: 'typescript',
  html: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  json: 'json',
  dotforge: 'json',
};

const LANGUAGES = Object.keys(SERVER_BY_LANGUAGE);

/** Version del documento, exigida por `didChange`. */
const versions = new Map<string, number>();
const openDocuments = new Set<string>();

function serverFor(languageId: string): LanguageServerId | null {
  return SERVER_BY_LANGUAGE[languageId] ?? null;
}

/** Ruta relativa del modelo, o `null` si es un modelo virtual (diff, http). */
function relativeOf(model: MonacoNs.editor.ITextModel): string | null {
  const uri = model.uri;
  if (uri.scheme !== 'forge') {
    return null;
  }
  return uri.path.replace(/^\//, '');
}

async function request<T>(
  server: LanguageServerId,
  method: string,
  params: unknown,
): Promise<T | null> {
  const result = await window.forge.lsp.request({ server, method, params });
  if (!result.ok) {
    return null;
  }
  return (result.value ?? null) as T | null;
}

function notify(server: LanguageServerId, method: string, params: unknown): void {
  void window.forge.lsp.notify({ server, method, params });
}

/* -------------------------------------------------------------------------- */
/*  Sincronizacion de documentos                                               */
/* -------------------------------------------------------------------------- */

export async function didOpen(relativePath: string): Promise<void> {
  const uri = getModelUri(relativePath);
  const model = monaco.editor.getModel(uri);
  if (model === null) {
    return;
  }
  const server = serverFor(model.getLanguageId());
  if (server === null || openDocuments.has(relativePath)) {
    return;
  }

  // Se arranca el servidor bajo demanda, al abrir el primer archivo suyo.
  const state = await window.forge.lsp.ensure(server);
  if (!state.ok || state.value.status !== 'running') {
    return;
  }

  openDocuments.add(relativePath);
  versions.set(relativePath, 1);
  notify(server, 'textDocument/didOpen', {
    textDocument: {
      uri: toFileUri(relativePath),
      languageId: model.getLanguageId(),
      version: 1,
      text: model.getValue(),
    },
  });
}

export function didChange(relativePath: string, model: MonacoNs.editor.ITextModel): void {
  const server = serverFor(model.getLanguageId());
  if (server === null || !openDocuments.has(relativePath)) {
    return;
  }
  const version = (versions.get(relativePath) ?? 1) + 1;
  versions.set(relativePath, version);
  // Sincronizacion completa: es lo que aceptan todos los servidores y evita
  // desincronizaciones sutiles con los cambios incrementales de Monaco.
  notify(server, 'textDocument/didChange', {
    textDocument: { uri: toFileUri(relativePath), version },
    contentChanges: [{ text: model.getValue() }],
  });
}

export function didSave(relativePath: string): void {
  const model = monaco.editor.getModel(getModelUri(relativePath));
  if (model === null) {
    return;
  }
  const server = serverFor(model.getLanguageId());
  if (server === null || !openDocuments.has(relativePath)) {
    return;
  }
  notify(server, 'textDocument/didSave', {
    textDocument: { uri: toFileUri(relativePath) },
    text: model.getValue(),
  });
}

export function didClose(relativePath: string): void {
  if (!openDocuments.has(relativePath)) {
    return;
  }
  openDocuments.delete(relativePath);
  versions.delete(relativePath);
  for (const server of new Set(Object.values(SERVER_BY_LANGUAGE))) {
    notify(server, 'textDocument/didClose', {
      textDocument: { uri: toFileUri(relativePath) },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Diagnosticos                                                               */
/* -------------------------------------------------------------------------- */

function handleNotification(notification: LspServerNotification): void {
  if (notification.method !== 'textDocument/publishDiagnostics') {
    return;
  }
  const params = notification.params as {
    uri?: string;
    diagnostics?: readonly LspDiagnostic[];
  } | null;
  if (params?.uri === undefined) {
    return;
  }
  const relative = fromFileUri(params.uri);
  if (relative === null) {
    return;
  }
  const model = monaco.editor.getModel(getModelUri(relative));
  if (model === null) {
    return;
  }
  const markers = (params.diagnostics ?? []).map((diagnostic) => toMarker(monaco, diagnostic));
  monaco.editor.setModelMarkers(model, `lsp:${notification.server}`, markers);
}

/* -------------------------------------------------------------------------- */
/*  Proveedores                                                                */
/* -------------------------------------------------------------------------- */

interface LspTextEdit {
  readonly range: LspRange;
  readonly newText: string;
}

interface LspCompletionItem {
  readonly label: string | { label: string };
  readonly kind?: number;
  readonly detail?: string;
  readonly documentation?: unknown;
  readonly sortText?: string;
  readonly filterText?: string;
  readonly insertText?: string;
  readonly insertTextFormat?: number;
  readonly textEdit?: { range?: LspRange; newText: string };
  readonly additionalTextEdits?: readonly LspTextEdit[];
  readonly command?: { command: string; title: string };
  readonly data?: unknown;
}

type CompletionResponse =
  | readonly LspCompletionItem[]
  | { readonly items?: readonly LspCompletionItem[]; readonly isIncomplete?: boolean };

/** Unifica las dos formas de respuesta del protocolo en una sola. */
function normalizeCompletion(response: CompletionResponse | null): {
  items: readonly LspCompletionItem[];
  isIncomplete: boolean;
} {
  if (response === null) {
    return { items: [], isIncomplete: false };
  }
  if (Array.isArray(response)) {
    return { items: response as readonly LspCompletionItem[], isIncomplete: false };
  }
  const list = response as { items?: readonly LspCompletionItem[]; isIncomplete?: boolean };
  return { items: list.items ?? [], isIncomplete: list.isIncomplete === true };
}

function registerCompletion(): void {
  monaco.languages.registerCompletionItemProvider(LANGUAGES, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<', ':', ' '],

    async provideCompletionItems(model, position, context) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return { suggestions: [] };
      }

      // El servidor puede responder con una lista pelada o con `CompletionList`.
      const response = await request<CompletionResponse>(server, 'textDocument/completion', {
        textDocument: { uri: toFileUri(relative) },
        position: toLspPosition(position),
        context: {
          triggerKind: context.triggerKind === 1 ? 1 : 2,
          ...(context.triggerCharacter === undefined
            ? {}
            : { triggerCharacter: context.triggerCharacter }),
        },
      });
      if (response === null) {
        return { suggestions: [] };
      }

      const list = normalizeCompletion(response);
      const items = list.items;
      const word = model.getWordUntilPosition(position);
      const defaultRange: MonacoNs.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: MonacoNs.languages.CompletionItem[] = items.map((item) => {
        const label = typeof item.label === 'string' ? item.label : item.label.label;
        const edit = item.textEdit;
        const range = edit?.range === undefined ? defaultRange : toMonacoRange(edit.range);
        const insertText = edit?.newText ?? item.insertText ?? label;

        return {
          label,
          kind: toCompletionKind(monaco, item.kind),
          insertText,
          range,
          ...(item.insertTextFormat === 2
            ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
            : {}),
          ...(item.detail === undefined ? {} : { detail: item.detail }),
          ...(item.documentation === undefined
            ? {}
            : { documentation: { value: toMarkdown(item.documentation) } }),
          ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
          ...(item.filterText === undefined ? {} : { filterText: item.filterText }),
          ...(item.additionalTextEdits === undefined
            ? {}
            : {
                additionalTextEdits: item.additionalTextEdits.map((extra) => ({
                  range: toMonacoRange(extra.range),
                  text: extra.newText,
                })),
              }),
        };
      });

      return { suggestions, incomplete: list.isIncomplete };
    },
  });
}

function registerHover(): void {
  monaco.languages.registerHoverProvider(LANGUAGES, {
    async provideHover(model, position) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return null;
      }
      const response = await request<{ contents?: unknown; range?: LspRange }>(
        server,
        'textDocument/hover',
        {
          textDocument: { uri: toFileUri(relative) },
          position: toLspPosition(position),
        },
      );
      const value = toMarkdown(response?.contents);
      if (value === '') {
        return null;
      }
      return {
        contents: [{ value }],
        ...(response?.range === undefined ? {} : { range: toMonacoRange(response.range) }),
      };
    },
  });
}

interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

interface LspLocationLink {
  readonly targetUri: string;
  readonly targetSelectionRange: LspRange;
  readonly targetRange: LspRange;
}

function toLocations(response: unknown): MonacoNs.languages.Location[] {
  if (response === null || response === undefined) {
    return [];
  }
  const entries = Array.isArray(response) ? response : [response];
  const locations: MonacoNs.languages.Location[] = [];

  for (const entry of entries) {
    const record = entry as Partial<LspLocation & LspLocationLink>;
    const uri = record.uri ?? record.targetUri;
    const range = record.range ?? record.targetSelectionRange ?? record.targetRange;
    if (uri === undefined || range === undefined) {
      continue;
    }
    const relative = fromFileUri(uri);
    if (relative === null) {
      // Definicion en `node_modules` o en librerias del sistema: se ignora
      // porque el editor no puede abrir nada fuera del workspace.
      continue;
    }
    locations.push({ uri: getModelUri(relative), range: toMonacoRange(range) });
  }
  return locations;
}

function registerNavigation(): void {
  monaco.languages.registerDefinitionProvider(LANGUAGES, {
    async provideDefinition(model, position) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return [];
      }
      const response = await request(server, 'textDocument/definition', {
        textDocument: { uri: toFileUri(relative) },
        position: toLspPosition(position),
      });
      return toLocations(response);
    },
  });

  monaco.languages.registerTypeDefinitionProvider(LANGUAGES, {
    async provideTypeDefinition(model, position) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return [];
      }
      const response = await request(server, 'textDocument/typeDefinition', {
        textDocument: { uri: toFileUri(relative) },
        position: toLspPosition(position),
      });
      return toLocations(response);
    },
  });

  monaco.languages.registerReferenceProvider(LANGUAGES, {
    async provideReferences(model, position, context) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return [];
      }
      const response = await request(server, 'textDocument/references', {
        textDocument: { uri: toFileUri(relative) },
        position: toLspPosition(position),
        context: { includeDeclaration: context.includeDeclaration },
      });
      return toLocations(response);
    },
  });

  monaco.languages.registerDocumentHighlightProvider(LANGUAGES, {
    async provideDocumentHighlights(model, position) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return [];
      }
      const response = await request<readonly { range: LspRange; kind?: number }[]>(
        server,
        'textDocument/documentHighlight',
        {
          textDocument: { uri: toFileUri(relative) },
          position: toLspPosition(position),
        },
      );
      return (response ?? []).map((entry) => ({
        range: toMonacoRange(entry.range),
        kind:
          entry.kind === 2
            ? monaco.languages.DocumentHighlightKind.Read
            : entry.kind === 3
              ? monaco.languages.DocumentHighlightKind.Write
              : monaco.languages.DocumentHighlightKind.Text,
      }));
    },
  });
}

function registerSignatureHelp(): void {
  monaco.languages.registerSignatureHelpProvider(LANGUAGES, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],

    async provideSignatureHelp(model, position) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return null;
      }
      const response = await request<{
        signatures?: readonly {
          label: string;
          documentation?: unknown;
          parameters?: readonly { label: string | [number, number]; documentation?: unknown }[];
        }[];
        activeSignature?: number;
        activeParameter?: number;
      }>(server, 'textDocument/signatureHelp', {
        textDocument: { uri: toFileUri(relative) },
        position: toLspPosition(position),
      });
      if (response?.signatures === undefined || response.signatures.length === 0) {
        return null;
      }
      return {
        value: {
          signatures: response.signatures.map((signature) => ({
            label: signature.label,
            documentation: { value: toMarkdown(signature.documentation) },
            parameters: (signature.parameters ?? []).map((parameter) => ({
              label: parameter.label,
              documentation: { value: toMarkdown(parameter.documentation) },
            })),
          })),
          activeSignature: response.activeSignature ?? 0,
          activeParameter: response.activeParameter ?? 0,
        },
        dispose: () => undefined,
      };
    },
  });
}

interface LspDocumentSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly range: LspRange;
  readonly selectionRange: LspRange;
  readonly children?: readonly LspDocumentSymbol[];
}

function registerSymbols(): void {
  monaco.languages.registerDocumentSymbolProvider(LANGUAGES, {
    async provideDocumentSymbols(model) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return [];
      }
      const response = await request<readonly LspDocumentSymbol[]>(
        server,
        'textDocument/documentSymbol',
        { textDocument: { uri: toFileUri(relative) } },
      );

      const convert = (symbol: LspDocumentSymbol): MonacoNs.languages.DocumentSymbol => ({
        name: symbol.name,
        detail: symbol.detail ?? '',
        kind: toSymbolKind(monaco, symbol.kind),
        tags: [],
        range: toMonacoRange(symbol.range),
        selectionRange: toMonacoRange(symbol.selectionRange),
        children: (symbol.children ?? []).map(convert),
      });

      return (response ?? []).map(convert);
    },
  });
}

interface LspWorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly LspTextEdit[]>>;
  readonly documentChanges?: readonly {
    textDocument?: { uri: string };
    edits?: readonly LspTextEdit[];
  }[];
}

/** Traduce una edicion de espacio de trabajo a las operaciones de Monaco. */
function toWorkspaceEdit(edit: LspWorkspaceEdit | null): MonacoNs.languages.WorkspaceEdit {
  const operations: MonacoNs.languages.IWorkspaceTextEdit[] = [];
  if (edit === null) {
    return { edits: operations };
  }

  const push = (uri: string, edits: readonly LspTextEdit[]): void => {
    const relative = fromFileUri(uri);
    if (relative === null) {
      return;
    }
    for (const entry of edits) {
      operations.push({
        resource: getModelUri(relative),
        versionId: undefined,
        textEdit: { range: toMonacoRange(entry.range), text: entry.newText },
      });
    }
  };

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    push(uri, edits);
  }
  for (const change of edit.documentChanges ?? []) {
    if (change.textDocument?.uri !== undefined && change.edits !== undefined) {
      push(change.textDocument.uri, change.edits);
    }
  }
  return { edits: operations };
}

function registerRename(): void {
  monaco.languages.registerRenameProvider(LANGUAGES, {
    async provideRenameEdits(model, position, newName) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return { edits: [] };
      }
      const response = await request<LspWorkspaceEdit>(server, 'textDocument/rename', {
        textDocument: { uri: toFileUri(relative) },
        position: toLspPosition(position),
        newName,
      });
      return toWorkspaceEdit(response);
    },

    async resolveRenameLocation(model, position) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'Sin servidor de lenguaje.' };
      }
      const response = await request<{ range?: LspRange; placeholder?: string }>(
        server,
        'textDocument/prepareRename',
        { textDocument: { uri: toFileUri(relative) }, position: toLspPosition(position) },
      );
      if (response?.range === undefined) {
        const word = model.getWordAtPosition(position);
        if (word === null) {
          return {
            range: new monaco.Range(1, 1, 1, 1),
            text: '',
            rejectReason: 'Aqui no hay ningun simbolo que renombrar.',
          };
        }
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          text: word.word,
        };
      }
      const range = toMonacoRange(response.range);
      return {
        range: new monaco.Range(
          range.startLineNumber,
          range.startColumn,
          range.endLineNumber,
          range.endColumn,
        ),
        text: response.placeholder ?? model.getValueInRange(range),
      };
    },
  });
}

interface LspCodeAction {
  readonly title: string;
  readonly kind?: string;
  readonly edit?: LspWorkspaceEdit;
  readonly isPreferred?: boolean;
  readonly diagnostics?: readonly LspDiagnostic[];
}

function registerCodeActions(): void {
  monaco.languages.registerCodeActionProvider(LANGUAGES, {
    async provideCodeActions(model, range, context) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return { actions: [], dispose: () => undefined };
      }
      const response = await request<readonly LspCodeAction[]>(server, 'textDocument/codeAction', {
        textDocument: { uri: toFileUri(relative) },
        range: toLspRange(range),
        context: {
          diagnostics: context.markers.map((marker) => ({
            range: toLspRange(marker),
            message: marker.message,
            severity: 1,
          })),
          ...(context.only === undefined ? {} : { only: [context.only] }),
        },
      });

      const actions: MonacoNs.languages.CodeAction[] = (response ?? [])
        .filter((action) => action.edit !== undefined)
        .map((action) => ({
          title: action.title,
          kind: action.kind ?? 'quickfix',
          isPreferred: action.isPreferred === true,
          edit: toWorkspaceEdit(action.edit ?? null),
        }));

      return { actions, dispose: () => undefined };
    },
  });
}

interface LspInlayHint {
  readonly position: { line: number; character: number };
  readonly label: string | readonly { value: string }[];
  readonly kind?: number;
  readonly paddingLeft?: boolean;
  readonly paddingRight?: boolean;
}

function registerInlayHints(): void {
  monaco.languages.registerInlayHintsProvider(LANGUAGES, {
    async provideInlayHints(model, range) {
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return { hints: [], dispose: () => undefined };
      }
      const response = await request<readonly LspInlayHint[]>(server, 'textDocument/inlayHint', {
        textDocument: { uri: toFileUri(relative) },
        range: toLspRange(range),
      });

      const hints: MonacoNs.languages.InlayHint[] = (response ?? []).map((hint) => ({
        position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
        label: typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join(''),
        kind:
          hint.kind === 1
            ? monaco.languages.InlayHintKind.Type
            : monaco.languages.InlayHintKind.Parameter,
        paddingLeft: hint.paddingLeft === true,
        paddingRight: hint.paddingRight === true,
      }));

      return { hints, dispose: () => undefined };
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Tokens semanticos                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Vocabulario anunciado por el cliente en `initialize`. El orden importa:
 * los datos que devuelve el servidor son indices sobre esta lista.
 */
const TOKEN_TYPES: readonly string[] = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
  'parameter', 'variable', 'property', 'enumMember', 'event', 'function',
  'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number',
  'regexp', 'operator', 'decorator',
];

const TOKEN_MODIFIERS: readonly string[] = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract',
  'async', 'modification', 'documentation', 'defaultLibrary',
];

function registerSemanticTokens(): void {
  monaco.languages.registerDocumentSemanticTokensProvider(LANGUAGES, {
    getLegend: () => ({ tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] }),

    async provideDocumentSemanticTokens(model) {
      if (!store.state.settings.semanticHighlighting) {
        return null;
      }
      const relative = relativeOf(model);
      const server = serverFor(model.getLanguageId());
      if (relative === null || server === null) {
        return null;
      }
      const response = await request<{ data?: readonly number[]; resultId?: string }>(
        server,
        'textDocument/semanticTokens/full',
        { textDocument: { uri: toFileUri(relative) } },
      );
      if (response?.data === undefined) {
        return null;
      }
      return {
        data: Uint32Array.from(response.data),
        ...(response.resultId === undefined ? {} : { resultId: response.resultId }),
      };
    },

    releaseDocumentSemanticTokens: () => undefined,
  });
}

/* -------------------------------------------------------------------------- */
/*  Registro                                                                   */
/* -------------------------------------------------------------------------- */

export function registerLspBridge(): void {
  monaco = getMonaco();

  registerCompletion();
  registerHover();
  registerNavigation();
  registerSignatureHelp();
  registerSymbols();
  registerRename();
  registerCodeActions();
  registerInlayHints();
  registerSemanticTokens();

  // `didChange` se emite con un retardo corto: enviar en cada pulsacion
  // satura al servidor sin mejorar la latencia percibida.
  const pending = new Map<string, number>();
  monaco.editor.onDidCreateModel((model) => {
    const relative = relativeOf(model);
    if (relative === null) {
      return;
    }
    model.onDidChangeContent(() => {
      const existing = pending.get(relative);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }
      pending.set(
        relative,
        window.setTimeout(() => {
          pending.delete(relative);
          didChange(relative, model);
        }, 180),
      );
    });
  });

  defineCommands([
    {
      id: 'lsp.didOpen',
      title: 'LSP: notificar apertura',
      category: 'LSP',
      run: (argument) => didOpen(String(argument ?? '')),
    },
    {
      id: 'lsp.didSave',
      title: 'LSP: notificar guardado',
      category: 'LSP',
      run: (argument) => didSave(String(argument ?? '')),
    },
    {
      id: 'lsp.didClose',
      title: 'LSP: notificar cierre',
      category: 'LSP',
      run: (argument) => didClose(String(argument ?? '')),
    },
    {
      id: 'lsp.handleNotification',
      title: 'LSP: procesar notificacion',
      category: 'LSP',
      run: (argument) => handleNotification(argument as LspServerNotification),
    },
    {
      id: 'lsp.restart',
      title: 'LSP: reiniciar los servidores de lenguaje',
      category: 'LSP',
      run: async () => {
        for (const server of new Set(Object.values(SERVER_BY_LANGUAGE))) {
          await window.forge.lsp.stop(server);
        }
        openDocuments.clear();
        versions.clear();
        const active = store.state.activeDocument;
        if (active !== null) {
          await runCommand('lsp.didOpen', active);
        }
      },
    },
  ]);
}
