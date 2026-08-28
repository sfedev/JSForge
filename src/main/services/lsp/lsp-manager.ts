/**
 * Gestor de servidores de lenguaje.
 *
 * Los servidores son dependencias OPCIONALES. Si el binario no esta
 * instalado, el servidor se marca como `unavailable` y el IDE sigue
 * funcionando con el resaltado y el autocompletado basico de Monaco: nunca
 * se bloquea la edicion por una dependencia ausente.
 *
 * Resolucion del binario, en orden:
 *  1. `node_modules/.bin` del workspace (lo habitual en un proyecto real).
 *  2. `node_modules/.bin` del propio IDE (dependencias opcionales).
 *  3. PATH del sistema.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  forgeError,
  type LanguageServerId,
  type LspServerState,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { getWorkspaceRoot, requireWorkspaceRoot } from '../workspace-service.js';
import { LspClient } from './lsp-client.js';

interface ServerDefinition {
  readonly id: LanguageServerId;
  readonly label: string;
  /** Nombre del binario en `node_modules/.bin`. */
  readonly binary: string;
  readonly args: readonly string[];
  /** Extensiones que atiende, para decidir cuando arrancarlo. */
  readonly extensions: readonly string[];
  readonly initializationOptions?: Readonly<Record<string, unknown>>;
  readonly configuration?: Readonly<Record<string, unknown>>;
}

const DEFINITIONS: readonly ServerDefinition[] = [
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    binary: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    initializationOptions: {
      hostInfo: 'forgejs-ide',
      preferences: {
        includeInlayParameterNameHints: 'literals',
        includeInlayFunctionParameterTypeHints: true,
        includeInlayVariableTypeHints: false,
        includeInlayPropertyDeclarationTypeHints: true,
        includeInlayFunctionLikeReturnTypeHints: true,
        importModuleSpecifierPreference: 'shortest',
        includeCompletionsForModuleExports: true,
      },
    },
    configuration: {
      typescript: {
        format: { semicolons: 'insert' },
        inlayHints: { parameterNames: { enabled: 'literals' } },
      },
      javascript: { format: { semicolons: 'insert' } },
      completions: { completeFunctionCalls: true },
    },
  },
  {
    id: 'html',
    label: 'HTML',
    binary: 'vscode-html-language-server',
    args: ['--stdio'],
    extensions: ['.html', '.htm'],
    configuration: { html: { format: { enable: true } } },
  },
  {
    id: 'css',
    label: 'CSS / SCSS / LESS',
    binary: 'vscode-css-language-server',
    args: ['--stdio'],
    extensions: ['.css', '.scss', '.sass', '.less'],
    configuration: {
      css: { validate: true, lint: { unknownAtRules: 'ignore' } },
      scss: { validate: true },
      less: { validate: true },
    },
  },
  {
    id: 'json',
    label: 'JSON',
    binary: 'vscode-json-language-server',
    args: ['--stdio'],
    extensions: ['.json', '.jsonc'],
    configuration: { json: { validate: { enable: true } } },
  },
  {
    id: 'vue',
    label: 'Vue (Volar)',
    binary: 'vue-language-server',
    args: ['--stdio'],
    extensions: ['.vue'],
  },
  {
    id: 'tailwind',
    label: 'TailwindCSS',
    binary: 'tailwindcss-language-server',
    args: ['--stdio'],
    extensions: ['.css', '.html', '.tsx', '.jsx', '.vue', '.svelte'],
    configuration: {
      tailwindCSS: {
        validate: true,
        classAttributes: ['class', 'className', 'ngClass', 'class:list'],
      },
    },
  },
];

const clients = new Map<LanguageServerId, LspClient>();
const states = new Map<LanguageServerId, LspServerState>();

function setState(state: LspServerState): void {
  states.set(state.id, state);
  emit({ type: 'lsp/state', payload: state });
}

export function serverStates(): readonly LspServerState[] {
  // Los servidores nunca arrancados se reportan como detenidos, para que la
  // barra de estado sepa que existen.
  for (const definition of DEFINITIONS) {
    if (!states.has(definition.id)) {
      states.set(definition.id, { id: definition.id, status: 'stopped' });
    }
  }
  return [...states.values()];
}

/** Servidor responsable de una extension de archivo. */
export function serverForExtension(extension: string): LanguageServerId | null {
  const definition = DEFINITIONS.find((entry) => entry.extensions.includes(extension.toLowerCase()));
  return definition?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Resolucion del binario                                                     */
/* -------------------------------------------------------------------------- */

function binaryCandidates(binary: string): string[] {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.CMD', '.exe', ''] : [''];
  const roots: string[] = [];

  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot !== null) {
    roots.push(path.join(workspaceRoot, 'node_modules', '.bin'));
  }
  // Dependencias opcionales del propio IDE.
  roots.push(path.join(process.cwd(), 'node_modules', '.bin'));
  roots.push(path.join(__dirname, '..', '..', 'node_modules', '.bin'));

  const candidates: string[] = [];
  for (const root of roots) {
    for (const suffix of suffixes) {
      candidates.push(path.join(root, `${binary}${suffix}`));
    }
  }
  return candidates;
}

/** Ruta ejecutable del servidor, o el nombre pelado para buscarlo en el PATH. */
export function resolveBinary(binary: string): { command: string; resolved: boolean } {
  for (const candidate of binaryCandidates(binary)) {
    if (existsSync(candidate)) {
      return { command: candidate, resolved: true };
    }
  }
  return { command: binary, resolved: false };
}

/* -------------------------------------------------------------------------- */
/*  Arranque                                                                   */
/* -------------------------------------------------------------------------- */

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

/** Capacidades que el IDE anuncia al servidor. */
function clientCapabilities(): Record<string, unknown> {
  return {
    workspace: {
      workspaceFolders: true,
      configuration: true,
      didChangeConfiguration: { dynamicRegistration: true },
      didChangeWatchedFiles: { dynamicRegistration: true },
      symbol: { dynamicRegistration: true },
      applyEdit: true,
      workspaceEdit: { documentChanges: true },
    },
    textDocument: {
      synchronization: { dynamicRegistration: true, willSave: false, didSave: true },
      completion: {
        dynamicRegistration: true,
        completionItem: {
          snippetSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
          insertReplaceSupport: true,
          labelDetailsSupport: true,
        },
        contextSupport: true,
      },
      hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
      signatureHelp: {
        dynamicRegistration: true,
        signatureInformation: { documentationFormat: ['markdown', 'plaintext'] },
      },
      definition: { dynamicRegistration: true, linkSupport: true },
      typeDefinition: { dynamicRegistration: true, linkSupport: true },
      implementation: { dynamicRegistration: true, linkSupport: true },
      references: { dynamicRegistration: true },
      documentHighlight: { dynamicRegistration: true },
      documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
      codeAction: {
        dynamicRegistration: true,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: ['quickfix', 'refactor', 'refactor.extract', 'source', 'source.organizeImports'],
          },
        },
      },
      formatting: { dynamicRegistration: true },
      rangeFormatting: { dynamicRegistration: true },
      rename: { dynamicRegistration: true, prepareSupport: true },
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
      semanticTokens: {
        dynamicRegistration: true,
        requests: { range: true, full: { delta: false } },
        tokenTypes: SEMANTIC_TOKEN_TYPES,
        tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
        formats: ['relative'],
      },
      inlayHint: { dynamicRegistration: true },
      foldingRange: { dynamicRegistration: true, lineFoldingOnly: true },
    },
    general: { positionEncodings: ['utf-16'] },
  };
}

/** Vocabulario de tokens semanticos anunciado por el cliente. */
export const SEMANTIC_TOKEN_TYPES: readonly string[] = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
  'parameter', 'variable', 'property', 'enumMember', 'event', 'function',
  'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number',
  'regexp', 'operator', 'decorator',
];

export const SEMANTIC_TOKEN_MODIFIERS: readonly string[] = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract',
  'async', 'modification', 'documentation', 'defaultLibrary',
];

export async function ensureServer(id: LanguageServerId): Promise<LspServerState> {
  const definition = DEFINITIONS.find((entry) => entry.id === id);
  if (definition === undefined) {
    failure('E_INVALID_ARGUMENT', `Servidor de lenguaje desconocido: ${id}`);
  }

  const existing = clients.get(id);
  if (existing !== undefined && existing.running) {
    return states.get(id) ?? { id, status: 'running' };
  }

  const root = requireWorkspaceRoot();
  const { command, resolved } = resolveBinary(definition.binary);

  if (!resolved && process.platform === 'win32') {
    // En Windows no se puede confiar en que el PATH lo encuentre; si no esta
    // en ningun node_modules/.bin, se declara no disponible sin intentarlo.
    const state: LspServerState = {
      id,
      status: 'unavailable',
      command: definition.binary,
      message: `No se encontro "${definition.binary}". Instalalo en el proyecto para activar ${definition.label}.`,
    };
    setState(state);
    return state;
  }

  setState({ id, status: 'starting', command });

  const client = new LspClient({
    id,
    command,
    args: definition.args,
    cwd: root,
    onNotification: (method, params) => {
      emit({ type: 'lsp/notification', payload: { server: id, method, params } });
    },
    onExit: (code, stderr) => {
      clients.delete(id);
      setState({
        id,
        status: 'failed',
        command,
        message:
          code === null
            ? `No se pudo ejecutar "${definition.binary}".`
            : `El servidor termino con codigo ${code}.`,
        ...(stderr === '' ? {} : {}),
      });
    },
    ...(definition.configuration === undefined ? {} : { configuration: definition.configuration }),
  });

  clients.set(id, client);
  client.start();

  try {
    const result = (await client.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'ForgeJS IDE', version: '0.1.0' },
      locale: 'es',
      rootUri: pathToFileURL(root).toString(),
      rootPath: root,
      workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: path.basename(root) }],
      capabilities: clientCapabilities(),
      ...(definition.initializationOptions === undefined
        ? {}
        : { initializationOptions: definition.initializationOptions }),
    })) as { capabilities?: Record<string, unknown> } | null;

    client.notify('initialized', {});
    if (definition.configuration !== undefined) {
      client.notify('workspace/didChangeConfiguration', { settings: definition.configuration });
    }

    const capabilities = Object.keys(result?.capabilities ?? {});
    const state: LspServerState = { id, status: 'running', command, capabilities };
    setState(state);
    return state;
  } catch (cause) {
    await client.stop().catch(() => undefined);
    clients.delete(id);
    const message =
      cause instanceof Error ? cause.message : `No se pudo inicializar ${definition.label}.`;
    const state: LspServerState = {
      id,
      status: resolved ? 'failed' : 'unavailable',
      command,
      message: resolved
        ? message
        : `No se encontro "${definition.binary}". Instalalo para activar ${definition.label}.`,
    };
    setState(state);
    return state;
  }
}

export async function stopServer(id: LanguageServerId): Promise<true> {
  const client = clients.get(id);
  if (client === undefined) {
    return true;
  }
  clients.delete(id);
  await client.stop();
  setState({ id, status: 'stopped' });
  return true;
}

export async function stopAllServers(): Promise<void> {
  await Promise.all([...clients.keys()].map((id) => stopServer(id)));
}

export async function sendRequest(
  id: LanguageServerId,
  method: string,
  params: unknown,
): Promise<unknown> {
  const client = clients.get(id);
  if (client === undefined || !client.running) {
    // Se intenta arrancar una vez: la primera peticion del editor suele
    // llegar antes de que nadie haya pedido el servidor explicitamente.
    const state = await ensureServer(id);
    if (state.status !== 'running') {
      failure('E_NOT_AVAILABLE', state.message ?? `El servidor "${id}" no esta disponible.`);
    }
  }
  const active = clients.get(id);
  if (active === undefined) {
    failure('E_NOT_AVAILABLE', `El servidor "${id}" no esta disponible.`);
  }
  return active.request(method, params);
}

export function sendNotification(id: LanguageServerId, method: string, params: unknown): true {
  const client = clients.get(id);
  if (client === undefined || !client.running) {
    // Una notificacion a un servidor caido se descarta en silencio: el
    // editor no debe romperse por escribir en un archivo sin servidor.
    return true;
  }
  client.notify(method, params);
  return true;
}
