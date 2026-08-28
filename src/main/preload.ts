/**
 * Preload de ForgeJS IDE — puente IPC estricto.
 *
 * Invariantes de seguridad:
 *  - `ipcRenderer` NUNCA se expone. Solo se publican funciones concretas.
 *  - Cada funcion invoca un canal literal tomado de `IPC`; el renderer no
 *    puede elegir el nombre del canal.
 *  - Los argumentos se copian a estructuras planas antes de cruzar el puente,
 *    de modo que no viajan proxies ni objetos con getters del renderer.
 *  - El listener de eventos recibe solo el payload deserializado; el objeto
 *    `IpcRendererEvent` (que contiene `sender`) se descarta.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  IPC,
  IPC_EVENT_CHANNEL,
  forgeError,
  type AiChatRequest,
  type AiProviderId,
  type ForgeEvent,
  type ForgeSettings,
  type FormatRequest,
  type GenerateRequest,
  type GitCommitRequest,
  type GitDiffRequest,
  type HttpRequestSpec,
  type IpcChannel,
  type LanguageServerId,
  type LspNotifyPayload,
  type LspRequestPayload,
  type PtyCreateRequest,
  type Result,
  type SearchRequest,
  type StartProcessRequest,
  type UpdateChannel,
  type WriteFileRequest,
  type DotForgeConfig,
} from '../shared/contracts.js';
import type { ForgeApi, Unsubscribe } from '../shared/forge-api.js';

/**
 * Clona a estructuras planas. Evita que el renderer envie objetos con
 * getters que se ejecutarian durante la serializacion estructurada, y
 * garantiza que lo que llega al main es datos inertes.
 */
function plain<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('No se pueden enviar funciones ni simbolos por IPC.');
  }
  if (typeof value !== 'object') {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

async function call<T>(channel: IpcChannel, ...args: readonly unknown[]): Promise<Result<T>> {
  try {
    const safeArgs = args.map((arg) => plain(arg));
    const result = (await ipcRenderer.invoke(channel, ...safeArgs)) as Result<T> | undefined;
    if (result === undefined || typeof result !== 'object' || !('ok' in result)) {
      return {
        ok: false,
        error: forgeError('E_UNKNOWN', 'Respuesta IPC malformada.', channel),
      };
    }
    return result;
  } catch (cause) {
    return {
      ok: false,
      error: forgeError(
        'E_UNKNOWN',
        'La invocacion IPC fallo.',
        cause instanceof Error ? cause.message : String(cause),
      ),
    };
  }
}

const api: ForgeApi = {
  app: {
    info: () => call(IPC.APP_INFO),
    openExternal: (url) => call(IPC.APP_OPEN_EXTERNAL, url),
  },

  window: {
    minimize: () => call(IPC.WINDOW_MINIMIZE),
    toggleMaximize: () => call(IPC.WINDOW_TOGGLE_MAXIMIZE),
    close: () => call(IPC.WINDOW_CLOSE),
    state: () => call(IPC.WINDOW_STATE),
  },

  workspace: {
    pick: () => call(IPC.WORKSPACE_PICK),
    open: (absolutePath: string) => call(IPC.WORKSPACE_OPEN, absolutePath),
    close: () => call(IPC.WORKSPACE_CLOSE),
    current: () => call(IPC.WORKSPACE_CURRENT),
    recent: () => call(IPC.WORKSPACE_RECENT),
  },

  fileSystem: {
    readDir: (relativePath: string) => call(IPC.FS_READ_DIR, relativePath),
    readFile: (relativePath: string) => call(IPC.FS_READ_FILE, relativePath),
    writeFile: (request: WriteFileRequest) => call(IPC.FS_WRITE_FILE, request),
    createFile: (relativePath: string, content?: string) =>
      call(IPC.FS_CREATE_FILE, relativePath, content ?? ''),
    createDir: (relativePath: string) => call(IPC.FS_CREATE_DIR, relativePath),
    rename: (fromRelative: string, toRelative: string) =>
      call(IPC.FS_RENAME, fromRelative, toRelative),
    remove: (relativePath: string) => call(IPC.FS_DELETE, relativePath),
    stat: (relativePath: string) => call(IPC.FS_STAT, relativePath),
    search: (request: SearchRequest) => call(IPC.FS_SEARCH, request),
    watchStart: () => call(IPC.FS_WATCH_START),
    watchStop: () => call(IPC.FS_WATCH_STOP),
  },

  dotforge: {
    readConfig: () => call(IPC.DOTFORGE_READ_CONFIG),
    writeConfig: (config: DotForgeConfig) => call(IPC.DOTFORGE_WRITE_CONFIG, config),
    sync: () => call(IPC.DOTFORGE_SYNC),
    schema: () => call(IPC.DOTFORGE_SCHEMA),
    blueprints: () => call(IPC.DOTFORGE_BLUEPRINTS),
    generate: (request: GenerateRequest) => call(IPC.DOTFORGE_GENERATE, request),
    runPipeline: (pipelineId: string) => call(IPC.DOTFORGE_PIPELINE_RUN, pipelineId),
  },

  toolchain: {
    detect: () => call(IPC.TOOLCHAIN_DETECT),
    manifest: () => call(IPC.TOOLCHAIN_MANIFEST),
    scripts: () => call(IPC.TOOLCHAIN_SCRIPTS),
  },

  process: {
    start: (request: StartProcessRequest) => call(IPC.PROCESS_START, request),
    stop: (id: string) => call(IPC.PROCESS_STOP, id),
    restart: (id: string) => call(IPC.PROCESS_RESTART, id),
    list: () => call(IPC.PROCESS_LIST),
    clear: (id: string) => call(IPC.PROCESS_CLEAR, id),
    readEnv: (environment?: string) => call(IPC.PROCESS_ENV_READ, environment ?? null),
    revealEnv: (file: string, key: string) => call(IPC.PROCESS_ENV_REVEAL, file, key),
  },

  lsp: {
    ensure: (server: LanguageServerId) => call(IPC.LSP_ENSURE, server),
    stop: (server: LanguageServerId) => call(IPC.LSP_STOP, server),
    request: (payload: LspRequestPayload) => call(IPC.LSP_REQUEST, payload),
    notify: (payload: LspNotifyPayload) => call(IPC.LSP_NOTIFY, payload),
    status: () => call(IPC.LSP_STATUS),
  },

  format: {
    document: (request: FormatRequest) => call(IPC.FORMAT_DOCUMENT, request),
  },

  ai: {
    providers: () => call(IPC.AI_PROVIDERS),
    setKey: (provider: AiProviderId, apiKey: string) => call(IPC.AI_SET_KEY, provider, apiKey),
    deleteKey: (provider: AiProviderId) => call(IPC.AI_DELETE_KEY, provider),
    models: (provider: AiProviderId) => call(IPC.AI_MODELS, provider),
    chat: (request: AiChatRequest) => call(IPC.AI_CHAT_START, request),
    cancel: (requestId: string) => call(IPC.AI_CHAT_CANCEL, requestId),
  },

  git: {
    status: () => call(IPC.GIT_STATUS),
    branches: () => call(IPC.GIT_BRANCHES),
    checkout: (branch: string) => call(IPC.GIT_CHECKOUT, branch),
    createBranch: (name: string, from?: string) =>
      call(IPC.GIT_CREATE_BRANCH, name, from ?? null),
    stage: (paths: readonly string[]) => call(IPC.GIT_STAGE, paths),
    unstage: (paths: readonly string[]) => call(IPC.GIT_UNSTAGE, paths),
    discard: (paths: readonly string[]) => call(IPC.GIT_DISCARD, paths),
    applyPatch: (patch: string, reverse?: boolean) =>
      call(IPC.GIT_APPLY_PATCH, patch, reverse === true),
    commit: (request: GitCommitRequest) => call(IPC.GIT_COMMIT, request),
    log: (limit?: number) => call(IPC.GIT_LOG, limit ?? 50),
    diff: (request: GitDiffRequest) => call(IPC.GIT_DIFF, request),
  },

  terminal: {
    profiles: () => call(IPC.PTY_PROFILES),
    create: (request: PtyCreateRequest) => call(IPC.PTY_CREATE, request),
    write: (id: string, data: string) => call(IPC.PTY_WRITE, id, data),
    resize: (id: string, cols: number, rows: number) => call(IPC.PTY_RESIZE, id, cols, rows),
    dispose: (id: string) => call(IPC.PTY_DISPOSE, id),
    suggest: (prefix: string) => call(IPC.PTY_SUGGEST, prefix),
  },

  http: {
    send: (request: HttpRequestSpec) => call(IPC.HTTP_SEND, request),
    cancel: (id: string) => call(IPC.HTTP_CANCEL, id),
    parse: (content: string) => call(IPC.HTTP_PARSE, content),
    endpoints: (relativePath: string, content: string) =>
      call(IPC.HTTP_ENDPOINTS, relativePath, content),
  },

  docker: {
    available: () => call(IPC.DOCKER_AVAILABLE),
    parseCompose: (relativePath: string) => call(IPC.DOCKER_COMPOSE_PARSE, relativePath),
    up: (relativePath: string, services: readonly string[]) =>
      call(IPC.DOCKER_COMPOSE_UP, relativePath, services),
    down: (relativePath: string, services: readonly string[]) =>
      call(IPC.DOCKER_COMPOSE_DOWN, relativePath, services),
    ps: () => call(IPC.DOCKER_PS),
  },

  db: {
    schema: () => call(IPC.DB_SCHEMA),
  },

  metrics: {
    snapshot: () => call(IPC.METRICS_SNAPSHOT),
    subscribe: (enabled: boolean) => call(IPC.METRICS_SUBSCRIBE, enabled),
  },

  updater: {
    state: () => call(IPC.UPDATER_STATE),
    check: () => call(IPC.UPDATER_CHECK),
    download: () => call(IPC.UPDATER_DOWNLOAD),
    install: (restartNow: boolean) => call(IPC.UPDATER_INSTALL, restartNow),
    setChannel: (channel: UpdateChannel) => call(IPC.UPDATER_SET_CHANNEL, channel),
  },

  settings: {
    get: () => call(IPC.SETTINGS_GET),
    set: (patch: Partial<ForgeSettings>) => call(IPC.SETTINGS_SET, patch),
  },

  on(listener: (event: ForgeEvent) => void): Unsubscribe {
    if (typeof listener !== 'function') {
      throw new TypeError('Se esperaba una funcion como listener.');
    }
    // El primer parametro (`IpcRendererEvent`) se descarta a proposito:
    // contiene `sender` y `ports`, que no deben llegar al renderer.
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      if (payload === null || typeof payload !== 'object' || !('type' in payload)) {
        return;
      }
      try {
        listener(payload as ForgeEvent);
      } catch (cause) {
        console.error('[forge] listener de evento fallo', cause);
      }
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('forge', api);
