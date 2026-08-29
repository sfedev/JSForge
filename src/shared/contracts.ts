/**
 * ForgeJS IDE — Contratos compartidos.
 *
 * Este modulo es la unica fuente de verdad para:
 *  - Los nombres de canal IPC (`IPC`).
 *  - Los tipos de datos puros intercambiados entre procesos.
 *  - Las estructuras de configuracion del motor DotForge.
 *
 * REGLA DE ORO: este archivo NO debe importar nada de `electron`, `node:*`
 * ni de ningun modulo del proceso principal. Se compila en los tres bundles
 * (main, preload y renderer).
 */

/* -------------------------------------------------------------------------- */
/*  Utilidades de tipos                                                        */
/* -------------------------------------------------------------------------- */

/** Resultado explicito: evita que las excepciones crucen la frontera IPC. */
export type Result<T, E = ForgeError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ForgeError {
  readonly code: ForgeErrorCode;
  readonly message: string;
  /** Detalle tecnico opcional; nunca contiene secretos. */
  readonly detail?: string;
}

export type ForgeErrorCode =
  | 'E_UNKNOWN'
  | 'E_INVALID_ARGUMENT'
  | 'E_NO_WORKSPACE'
  | 'E_OUTSIDE_WORKSPACE'
  | 'E_NOT_FOUND'
  | 'E_ALREADY_EXISTS'
  | 'E_PERMISSION'
  | 'E_TOO_LARGE'
  | 'E_BINARY'
  | 'E_PARSE'
  | 'E_PROCESS_FAILED'
  | 'E_NOT_AVAILABLE'
  | 'E_CANCELLED'
  | 'E_NETWORK'
  | 'E_TIMEOUT'
  | 'E_CONFLICT'
  | 'E_UNSUPPORTED';

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E = ForgeError>(error: E): Result<never, E> => ({ ok: false, error });

export function forgeError(
  code: ForgeErrorCode,
  message: string,
  detail?: string,
): ForgeError {
  return detail === undefined ? { code, message } : { code, message, detail };
}

export const fail = (
  code: ForgeErrorCode,
  message: string,
  detail?: string,
): Result<never> => err(forgeError(code, message, detail));

/* -------------------------------------------------------------------------- */
/*  Canales IPC                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Todos los canales `invoke` disponibles. El preload expone envoltorios
 * tipados; `ipcRenderer` jamas se expone al renderer.
 */
export const IPC = {
  /* Aplicacion y ventana */
  APP_INFO: 'forge:app/info',
  APP_OPEN_EXTERNAL: 'forge:app/open-external',
  WINDOW_MINIMIZE: 'forge:window/minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'forge:window/toggle-maximize',
  WINDOW_CLOSE: 'forge:window/close',
  WINDOW_STATE: 'forge:window/state',

  /* Workspace */
  WORKSPACE_PICK: 'forge:workspace/pick',
  WORKSPACE_OPEN: 'forge:workspace/open',
  WORKSPACE_CLOSE: 'forge:workspace/close',
  WORKSPACE_CURRENT: 'forge:workspace/current',
  WORKSPACE_RECENT: 'forge:workspace/recent',
  /** Selector de carpeta puro: devuelve la ruta y no abre nada. */
  DIALOG_PICK_DIRECTORY: 'forge:dialog/pick-directory',

  /* Sistema de archivos (siempre pasa por assertInsideWorkspace) */
  FS_READ_DIR: 'forge:fs/read-dir',
  FS_READ_FILE: 'forge:fs/read-file',
  FS_WRITE_FILE: 'forge:fs/write-file',
  FS_CREATE_FILE: 'forge:fs/create-file',
  FS_CREATE_DIR: 'forge:fs/create-dir',
  FS_RENAME: 'forge:fs/rename',
  FS_DELETE: 'forge:fs/delete',
  FS_STAT: 'forge:fs/stat',
  FS_SEARCH: 'forge:fs/search',
  FS_FIND_FILES: 'forge:fs/find-files',
  FS_WATCH_START: 'forge:fs/watch-start',
  FS_WATCH_STOP: 'forge:fs/watch-stop',

  /* DotForge */
  DOTFORGE_READ_CONFIG: 'forge:dotforge/read-config',
  DOTFORGE_WRITE_CONFIG: 'forge:dotforge/write-config',
  DOTFORGE_SYNC: 'forge:dotforge/sync',
  DOTFORGE_SCHEMA: 'forge:dotforge/schema',
  DOTFORGE_BLUEPRINTS: 'forge:dotforge/blueprints',
  DOTFORGE_GENERATE: 'forge:dotforge/generate',
  DOTFORGE_PIPELINE_RUN: 'forge:dotforge/pipeline-run',

  /* Toolchain */
  TOOLCHAIN_DETECT: 'forge:toolchain/detect',
  TOOLCHAIN_MANIFEST: 'forge:toolchain/manifest',
  TOOLCHAIN_SCRIPTS: 'forge:toolchain/scripts',

  /* Gestor de procesos */
  PROCESS_START: 'forge:process/start',
  PROCESS_STOP: 'forge:process/stop',
  PROCESS_RESTART: 'forge:process/restart',
  PROCESS_LIST: 'forge:process/list',
  PROCESS_CLEAR: 'forge:process/clear',
  PROCESS_ENV_READ: 'forge:process/env-read',
  PROCESS_ENV_REVEAL: 'forge:process/env-reveal',

  /* LSP */
  LSP_ENSURE: 'forge:lsp/ensure',
  LSP_STOP: 'forge:lsp/stop',
  LSP_REQUEST: 'forge:lsp/request',
  LSP_NOTIFY: 'forge:lsp/notify',
  LSP_STATUS: 'forge:lsp/status',

  /* Formateo */
  FORMAT_DOCUMENT: 'forge:format/document',

  /* IA */
  AI_PROVIDERS: 'forge:ai/providers',
  AI_SET_KEY: 'forge:ai/set-key',
  AI_DELETE_KEY: 'forge:ai/delete-key',
  AI_MODELS: 'forge:ai/models',
  AI_CHAT_START: 'forge:ai/chat-start',
  AI_CHAT_CANCEL: 'forge:ai/chat-cancel',

  /* Git */
  GIT_STATUS: 'forge:git/status',
  GIT_BRANCHES: 'forge:git/branches',
  GIT_CHECKOUT: 'forge:git/checkout',
  GIT_CREATE_BRANCH: 'forge:git/create-branch',
  GIT_STAGE: 'forge:git/stage',
  GIT_UNSTAGE: 'forge:git/unstage',
  GIT_DISCARD: 'forge:git/discard',
  GIT_APPLY_PATCH: 'forge:git/apply-patch',
  GIT_COMMIT: 'forge:git/commit',
  GIT_LOG: 'forge:git/log',
  GIT_DIFF: 'forge:git/diff',

  /* Terminal PTY */
  PTY_PROFILES: 'forge:pty/profiles',
  PTY_CREATE: 'forge:pty/create',
  PTY_WRITE: 'forge:pty/write',
  PTY_RESIZE: 'forge:pty/resize',
  PTY_DISPOSE: 'forge:pty/dispose',
  PTY_SUGGEST: 'forge:pty/suggest',

  /* Cliente HTTP */
  HTTP_SEND: 'forge:http/send',
  HTTP_CANCEL: 'forge:http/cancel',
  HTTP_PARSE: 'forge:http/parse',
  HTTP_ENDPOINTS: 'forge:http/endpoints',

  /* Docker / Bases de datos */
  DOCKER_AVAILABLE: 'forge:docker/available',
  DOCKER_COMPOSE_PARSE: 'forge:docker/compose-parse',
  DOCKER_COMPOSE_UP: 'forge:docker/compose-up',
  DOCKER_COMPOSE_DOWN: 'forge:docker/compose-down',
  DOCKER_PS: 'forge:docker/ps',
  DB_SCHEMA: 'forge:db/schema',

  /* Metricas */
  METRICS_SNAPSHOT: 'forge:metrics/snapshot',
  METRICS_SUBSCRIBE: 'forge:metrics/subscribe',

  /* Actualizaciones */
  UPDATER_STATE: 'forge:updater/state',
  UPDATER_CHECK: 'forge:updater/check',
  UPDATER_DOWNLOAD: 'forge:updater/download',
  UPDATER_INSTALL: 'forge:updater/install',
  UPDATER_SET_CHANNEL: 'forge:updater/set-channel',

  /* Depuracion CDP y perfilado de memoria */
  DEBUG_ATTACH: 'forge:debug/attach',
  DEBUG_DETACH: 'forge:debug/detach',
  DEBUG_SESSIONS: 'forge:debug/sessions',
  DEBUG_DISCOVER: 'forge:debug/discover',
  DEBUG_SET_BREAKPOINTS: 'forge:debug/set-breakpoints',
  DEBUG_RESUME: 'forge:debug/resume',
  DEBUG_PAUSE: 'forge:debug/pause',
  DEBUG_STEP: 'forge:debug/step',
  DEBUG_EVALUATE: 'forge:debug/evaluate',
  DEBUG_SCOPES: 'forge:debug/scopes',
  DEBUG_PROPERTIES: 'forge:debug/properties',
  DEBUG_HEAP_SUBSCRIBE: 'forge:debug/heap-subscribe',
  DEBUG_HEAP_TREND: 'forge:debug/heap-trend',
  DEBUG_COLLECT_GARBAGE: 'forge:debug/collect-garbage',

  /* Especificaciones OpenAPI y auditoria de contratos */
  SPEC_DISCOVER: 'forge:spec/discover',
  SPEC_PARSE: 'forge:spec/parse',
  SPEC_GENERATE: 'forge:spec/generate',
  SPEC_AUDIT: 'forge:spec/audit',
  SPEC_AUDIT_TARGETS: 'forge:spec/audit-targets',

  /* Pruebas y cobertura */
  TEST_DISCOVER: 'forge:test/discover',
  TEST_BLOCKS: 'forge:test/blocks',
  TEST_RUNNERS: 'forge:test/runners',
  TEST_RUN: 'forge:test/run',
  TEST_CANCEL: 'forge:test/cancel',
  TEST_LAST_RUN: 'forge:test/last-run',
  TEST_COVERAGE: 'forge:test/coverage',

  /* Forge Vault: entorno y secretos */
  VAULT_READ: 'forge:vault/read',
  VAULT_WRITE: 'forge:vault/write',
  VAULT_REVEAL: 'forge:vault/reveal',
  VAULT_SECRETS: 'forge:vault/secrets',
  VAULT_SET_SECRET: 'forge:vault/set-secret',
  VAULT_DELETE_SECRET: 'forge:vault/delete-secret',
  VAULT_PROMOTE: 'forge:vault/promote',
  VAULT_SYNC_EXAMPLE: 'forge:vault/sync-example',

  /* Motor de plugins */
  PLUGIN_LIST: 'forge:plugin/list',
  PLUGIN_RELOAD: 'forge:plugin/reload',
  PLUGIN_RUN: 'forge:plugin/run',
  PLUGIN_SET_ENABLED: 'forge:plugin/set-enabled',
  PLUGIN_SCAFFOLD_TEMPLATE: 'forge:plugin/scaffold-template',

  /* Preferencias */
  SETTINGS_GET: 'forge:settings/get',
  SETTINGS_SET: 'forge:settings/set',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Canal unico main -> renderer. Toda notificacion viaja como `ForgeEvent`. */
export const IPC_EVENT_CHANNEL = 'forge:event';

/* -------------------------------------------------------------------------- */
/*  Aplicacion / ventana                                                       */
/* -------------------------------------------------------------------------- */

export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly userDataPath: string;
}

export interface WindowState {
  readonly maximized: boolean;
  readonly fullScreen: boolean;
  readonly focused: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Workspace y sistema de archivos                                            */
/* -------------------------------------------------------------------------- */

export interface WorkspaceInfo {
  /** Ruta absoluta normalizada y resuelta (sin symlinks). */
  readonly root: string;
  readonly name: string;
  /** true si se detecto un manifiesto DotForge en la raiz. */
  readonly hasDotForge: boolean;
  readonly hasPackageJson: boolean;
  readonly isGitRepo: boolean;
  readonly openedAt: number;
}

export type FileKind = 'file' | 'directory' | 'symlink' | 'other';

export interface DirEntry {
  readonly name: string;
  /** Ruta relativa al root del workspace, siempre con separador `/`. */
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly modifiedAt: number;
  /** Heuristica por extension: el archivo parece binario. */
  readonly binary: boolean;
}

export interface FileStat {
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly modifiedAt: number;
  readonly createdAt: number;
}

export type EolStyle = 'lf' | 'crlf';

export interface ReadFileResult {
  readonly path: string;
  readonly content: string;
  /** true si el archivo original tenia BOM UTF-8 (se preserva al escribir). */
  readonly bom: boolean;
  readonly eol: EolStyle;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface WriteFileRequest {
  readonly path: string;
  readonly content: string;
  readonly bom?: boolean;
  readonly eol?: EolStyle;
  /** Si se indica y no coincide con el mtime en disco, se rechaza la escritura. */
  readonly expectedModifiedAt?: number;
}

export interface SearchRequest {
  readonly query: string;
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxResults?: number;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly preview: string;
}

export interface SearchResult {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
  readonly scannedFiles: number;
  readonly elapsedMs: number;
}

export type FileChangeType = 'created' | 'modified' | 'deleted';

export interface FileChangeEvent {
  readonly path: string;
  readonly type: FileChangeType;
}

/* -------------------------------------------------------------------------- */
/*  Motor DotForge — configuracion                                             */
/* -------------------------------------------------------------------------- */

/** Version del esquema soportado por este IDE. */
export const DOTFORGE_SCHEMA_VERSION = '1.0';

/** Nombres de manifiesto reconocidos, en orden de precedencia. */
export const DOTFORGE_MANIFEST_NAMES = [
  'dotforge.config.json',
  'dotforge.json',
  '.dotforge',
] as const;

export type DotForgeRuntime = 'node' | 'bun' | 'deno';
export type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DotForgeConfig {
  /** Version del esquema; permite migraciones tolerantes. */
  readonly $schemaVersion?: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly runtime?: DotForgeRuntime;
  readonly packageManager?: PackageManagerId;
  /** Preset de arquitectura con el que fue generado el proyecto. */
  readonly preset?: string;
  readonly workspaces?: readonly string[];
  readonly tasks?: Readonly<Record<string, DotForgeTask>>;
  readonly pipelines?: Readonly<Record<string, DotForgePipeline>>;
  readonly environments?: Readonly<Record<string, DotForgeEnvironment>>;
  readonly services?: readonly DotForgeService[];
  readonly ai?: DotForgeAiSettings;
}

export interface DotForgeTask {
  /** Etiqueta legible mostrada en la UI. */
  readonly label?: string;
  /** Comando completo. Alternativa a `script`. */
  readonly command?: string;
  /** Nombre de script de package.json a ejecutar con el gestor detectado. */
  readonly script?: string;
  readonly args?: readonly string[];
  /** Directorio relativo al workspace. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Puerto esperado; el IDE lo usa para generar el hipervinculo local. */
  readonly port?: number;
  /** Expresion regular que indica que el proceso ya esta listo. */
  readonly readyPattern?: string;
  /** Formato de log emitido, para el visualizador estructurado. */
  readonly logFormat?: LogFormat;
  readonly watch?: boolean;
}

export interface DotForgePipeline {
  readonly label?: string;
  readonly description?: string;
  /** Nombres de tareas ejecutadas. */
  readonly tasks: readonly string[];
  /** true: todas a la vez. false: en cadena, esperando a cada una. */
  readonly parallel?: boolean;
  readonly environment?: string;
  /** Detiene el pipeline completo si una tarea sale con codigo != 0. */
  readonly stopOnError?: boolean;
}

export interface DotForgeEnvironment {
  readonly label?: string;
  /** Archivos .env cargados en orden (los ultimos ganan). */
  readonly envFiles?: readonly string[];
  readonly variables?: Readonly<Record<string, string>>;
  /** Claves cuyo valor debe enmascararse siempre en la UI y los logs. */
  readonly secrets?: readonly string[];
}

export type DotForgeServiceKind =
  | 'postgres'
  | 'mysql'
  | 'mongo'
  | 'redis'
  | 'mailhog'
  | 'other';

export interface DotForgeService {
  readonly name: string;
  readonly kind: DotForgeServiceKind;
  readonly composeFile?: string;
  readonly composeService?: string;
  readonly port?: number;
  readonly url?: string;
}

export interface DotForgeAiSettings {
  readonly provider?: AiProviderId;
  readonly model?: string;
  /** Globs excluidos de la inyeccion contextual RAG. */
  readonly excludeFromContext?: readonly string[];
}

/** Resultado de leer el manifiesto DotForge de un workspace. */
export interface DotForgeManifest {
  readonly found: boolean;
  /** Ruta relativa del manifiesto encontrado, si lo hay. */
  readonly path?: string;
  readonly config: DotForgeConfig;
  /** Avisos no fatales del parser tolerante (claves desconocidas, etc.). */
  readonly warnings: readonly string[];
  /** true si la config fue derivada de package.json por ausencia de manifiesto. */
  readonly inferred: boolean;
}

/** Diagnostico de validacion de un manifiesto, para el LSP `dotforge`. */
export interface DotForgeDiagnostic {
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

/* -------------------------------------------------------------------------- */
/*  Scaffolding — blueprints del generador                                     */
/* -------------------------------------------------------------------------- */

export type BlueprintCategory = 'frontend' | 'backend' | 'fullstack' | 'monorepo';

export interface BlueprintChoice {
  readonly id: string;
  readonly label: string;
}

export interface BlueprintOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly type: 'boolean' | 'choice';
  readonly default: string | boolean;
  readonly choices?: readonly BlueprintChoice[];
}

export interface Blueprint {
  readonly id: string;
  readonly label: string;
  readonly category: BlueprintCategory;
  readonly description: string;
  readonly tags: readonly string[];
  readonly options: readonly BlueprintOption[];
}

export interface GenerateRequest {
  readonly blueprintId: string;
  /** Directorio destino absoluto; debe estar vacio o no existir. */
  readonly targetDir: string;
  readonly projectName: string;
  readonly packageManager: PackageManagerId;
  readonly options: Readonly<Record<string, string | boolean>>;
  /** Si es true no se escribe nada, solo se devuelve el plan de archivos. */
  readonly dryRun?: boolean;
}

export interface GeneratedFile {
  readonly path: string;
  readonly bytes: number;
}

export interface GenerateResult {
  readonly targetDir: string;
  readonly blueprintId: string;
  readonly files: readonly GeneratedFile[];
  readonly nextSteps: readonly string[];
  readonly dryRun: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Toolchain                                                                  */
/* -------------------------------------------------------------------------- */

export interface PackageManagerInfo {
  readonly id: PackageManagerId;
  readonly available: boolean;
  readonly version?: string;
}

export type PreferredReason = 'declared' | 'lockfile' | 'available' | 'default';

export interface ToolchainInfo {
  readonly managers: readonly PackageManagerInfo[];
  /** Gestor elegido: declarado en package.json/dotforge o inferido por lockfile. */
  readonly preferred: PackageManagerId;
  readonly preferredReason: PreferredReason;
  readonly nodeVersion?: string;
  readonly gitVersion?: string;
  readonly dockerVersion?: string;
}

export interface PackageJsonSummary {
  readonly path: string;
  readonly name?: string;
  readonly version?: string;
  readonly packageManager?: string;
  readonly type?: 'module' | 'commonjs';
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly workspaces?: readonly string[];
}

export interface TsConfigSummary {
  readonly path: string;
  readonly strict: boolean;
  readonly target?: string;
  readonly module?: string;
  readonly jsx?: string;
  readonly baseUrl?: string;
  readonly paths: Readonly<Record<string, readonly string[]>>;
  readonly extends?: string;
}

export type FrameworkId =
  | 'react'
  | 'next'
  | 'vue'
  | 'nuxt'
  | 'angular'
  | 'svelte'
  | 'sveltekit'
  | 'vite'
  | 'express'
  | 'nestjs'
  | 'fastify'
  | 'prisma'
  | 'typeorm'
  | 'drizzle'
  | 'tailwind'
  | 'vitest'
  | 'jest'
  | 'playwright'
  | 'nx'
  | 'turborepo';

export interface DetectedFramework {
  readonly id: FrameworkId;
  readonly label: string;
  readonly version?: string;
  /** Ruta relativa del archivo que evidencio la deteccion. */
  readonly evidence: string;
}

export interface ProjectManifest {
  readonly packageJson?: PackageJsonSummary;
  readonly tsconfig?: TsConfigSummary;
  readonly frameworks: readonly DetectedFramework[];
  readonly configFiles: readonly string[];
  readonly warnings: readonly string[];
}

export interface ScriptEntry {
  readonly name: string;
  readonly command: string;
  /** Paquete del monorepo al que pertenece, si aplica. */
  readonly workspace?: string;
}

/* -------------------------------------------------------------------------- */
/*  Gestor de procesos                                                         */
/* -------------------------------------------------------------------------- */

export type LogFormat =
  | 'auto'
  | 'plain'
  | 'pino'
  | 'winston'
  | 'bunyan'
  | 'morgan'
  | 'dotforge';

export type ProcessStatus =
  | 'starting'
  | 'running'
  | 'ready'
  | 'exited'
  | 'failed'
  | 'stopped';

export interface StartProcessRequest {
  /** Identificador estable elegido por el renderer (uno por canal de salida). */
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** Relativo al workspace. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly environment?: string;
  readonly logFormat?: LogFormat;
  readonly readyPattern?: string;
  readonly port?: number;
  readonly pipelineId?: string;
}

export interface ProcessInfo {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly status: ProcessStatus;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** Puerto detectado en la salida (o declarado). */
  readonly port?: number;
  readonly url?: string;
  readonly pipelineId?: string;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface StackFrameRef {
  /** Ruta relativa al workspace cuando se pudo resolver. */
  readonly path: string;
  readonly line: number;
  readonly column?: number;
  readonly inWorkspace: boolean;
}

export interface LogRecord {
  readonly processId: string;
  readonly seq: number;
  readonly time: number;
  readonly level: LogLevel;
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly message: string;
  /** Campos estructurados extra del parser (pino/winston/bunyan). */
  readonly fields?: Readonly<Record<string, string>>;
  readonly frames?: readonly StackFrameRef[];
  readonly urls?: readonly string[];
}

export interface EnvVariableView {
  readonly key: string;
  /** Valor ya enmascarado si `secret` es true. */
  readonly value: string;
  readonly secret: boolean;
  readonly source: string;
}

export interface EnvFileView {
  readonly path: string;
  readonly variables: readonly EnvVariableView[];
}

/* -------------------------------------------------------------------------- */
/*  LSP                                                                        */
/* -------------------------------------------------------------------------- */

export type LanguageServerId =
  | 'typescript'
  | 'html'
  | 'css'
  | 'json'
  | 'vue'
  | 'tailwind'
  | 'dotforge';

export type LspStatus = 'stopped' | 'starting' | 'running' | 'unavailable' | 'failed';

export interface LspServerState {
  readonly id: LanguageServerId;
  readonly status: LspStatus;
  readonly command?: string;
  readonly message?: string;
  readonly capabilities?: readonly string[];
}

export interface LspRequestPayload {
  readonly server: LanguageServerId;
  readonly method: string;
  readonly params?: unknown;
}

export interface LspNotifyPayload {
  readonly server: LanguageServerId;
  readonly method: string;
  readonly params?: unknown;
}

/** Notificacion cruda reenviada del servidor al renderer. */
export interface LspServerNotification {
  readonly server: LanguageServerId;
  readonly method: string;
  readonly params: unknown;
}

/* -------------------------------------------------------------------------- */
/*  Formateo                                                                   */
/* -------------------------------------------------------------------------- */

export type FormatterId = 'prettier' | 'biome' | 'plugin' | 'none';

export interface FormatRequest {
  readonly path: string;
  readonly content: string;
  readonly languageId: string;
}

export interface FormatResponse {
  readonly formatter: FormatterId;
  readonly content: string;
  readonly changed: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Asistente IA                                                               */
/* -------------------------------------------------------------------------- */

export type AiProviderId = 'anthropic' | 'openai' | 'ollama';

export interface AiProviderInfo {
  readonly id: AiProviderId;
  readonly label: string;
  /** true si requiere clave API almacenada con safeStorage. */
  readonly requiresKey: boolean;
  readonly hasKey: boolean;
  readonly defaultModel: string;
  readonly models: readonly string[];
  readonly baseUrl: string;
  /** true si el cifrado del SO esta disponible para guardar claves. */
  readonly secureStorage: boolean;
}

export type AiRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  readonly role: AiRole;
  readonly content: string;
}

export interface AiContextSelection {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface AiDiagnosticContext {
  readonly path: string;
  readonly line: number;
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly message: string;
  readonly source?: string;
}

/** Contexto RAG recolectado por el renderer y enriquecido en el main. */
export interface AiContextRequest {
  readonly activeFile?: string;
  readonly includeActiveFileContent?: boolean;
  readonly selection?: AiContextSelection;
  readonly diagnostics?: readonly AiDiagnosticContext[];
  readonly extraFiles?: readonly string[];
  readonly includeDotForge?: boolean;
  readonly includeDependencies?: boolean;
}

export type AiQuickAction =
  | 'chat'
  | 'explain'
  | 'test-vitest'
  | 'to-typescript'
  | 'optimize-component'
  | 'dotforge-pipeline'
  | 'inline-edit';

export interface AiChatRequest {
  readonly requestId: string;
  readonly provider: AiProviderId;
  readonly model: string;
  readonly messages: readonly AiMessage[];
  readonly context?: AiContextRequest;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Instruccion de sistema adicional (acciones rapidas / inline). */
  readonly systemPreset?: AiQuickAction;
}

export type AiStreamEvent =
  | { readonly kind: 'start'; readonly requestId: string; readonly model: string }
  | { readonly kind: 'delta'; readonly requestId: string; readonly text: string }
  | {
      readonly kind: 'done';
      readonly requestId: string;
      readonly text: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly elapsedMs: number;
    }
  | { readonly kind: 'error'; readonly requestId: string; readonly error: ForgeError };

/* -------------------------------------------------------------------------- */
/*  Git                                                                        */
/* -------------------------------------------------------------------------- */

export type GitFileState =
  | 'unmodified'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflicted'
  | 'typechange';

export interface GitFileChange {
  readonly path: string;
  readonly originalPath?: string;
  readonly index: GitFileState;
  readonly worktree: GitFileState;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly conflicted: boolean;
}

export interface GitStatus {
  readonly isRepo: boolean;
  readonly branch?: string;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly detached: boolean;
  readonly staged: readonly GitFileChange[];
  readonly unstaged: readonly GitFileChange[];
  readonly untracked: readonly GitFileChange[];
  readonly conflicted: readonly GitFileChange[];
}

export interface GitBranch {
  readonly name: string;
  readonly current: boolean;
  readonly remote: boolean;
  readonly upstream?: string;
}

export interface GitCommitRequest {
  readonly message: string;
  readonly amend?: boolean;
  readonly signoff?: boolean;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly shortHash: string;
  readonly author: string;
  readonly email: string;
  readonly date: number;
  readonly subject: string;
  readonly body: string;
  readonly refs: readonly string[];
}

export interface GitDiffRequest {
  readonly path: string;
  readonly staged: boolean;
}

/** Contenido para el visor lado a lado con modelos `forge-diff:`. */
export interface GitDiffPair {
  readonly path: string;
  readonly original: string;
  readonly modified: string;
  readonly originalRef: string;
  readonly modifiedRef: string;
  readonly binary: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Terminal PTY                                                               */
/* -------------------------------------------------------------------------- */

export interface PtyProfile {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly available: boolean;
}

export interface PtyCreateRequest {
  readonly id: string;
  readonly profileId: string;
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface PtyCreateResult {
  readonly id: string;
  readonly pid: number;
  readonly profileId: string;
  /** Modo degradado: sin node-pty se usa un shell por tuberias, sin TTY real. */
  readonly degraded: boolean;
}

export interface CommandSuggestion {
  readonly value: string;
  readonly detail?: string;
  readonly kind: 'script' | 'task' | 'pipeline' | 'command' | 'path' | 'history';
}

/* -------------------------------------------------------------------------- */
/*  Cliente HTTP                                                               */
/* -------------------------------------------------------------------------- */

export interface HttpRequestSpec {
  readonly id: string;
  readonly name?: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Linea inicial en el archivo .http de origen (para el code lens). */
  readonly line?: number;
}

export interface HttpResponseView {
  readonly id: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly contentType: string;
  readonly size: number;
  readonly elapsedMs: number;
  /** Cuerpo JSON reindentado cuando el content-type lo permite. */
  readonly prettyBody?: string;
}

export interface HttpEndpointLens {
  readonly path: string;
  readonly line: number;
  readonly method: string;
  readonly route: string;
  readonly framework: 'express' | 'nestjs' | 'fastify' | 'next';
}

/* -------------------------------------------------------------------------- */
/*  Docker y bases de datos                                                    */
/* -------------------------------------------------------------------------- */

export interface ComposePortMapping {
  readonly host: number;
  readonly container: number;
}

export interface ComposeService {
  readonly name: string;
  readonly image?: string;
  readonly kind: DotForgeServiceKind;
  readonly ports: readonly ComposePortMapping[];
  readonly environment: Readonly<Record<string, string>>;
  readonly volumes: readonly string[];
}

export interface ComposeFileView {
  readonly path: string;
  readonly services: readonly ComposeService[];
  readonly warnings: readonly string[];
}

export interface ContainerInfo {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly ports: string;
}

export type DbSchemaSource = 'prisma' | 'typeorm' | 'drizzle';

export interface DbColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly primary: boolean;
  readonly unique: boolean;
  readonly relation?: string;
  readonly defaultValue?: string;
}

export interface DbModel {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly columns: readonly DbColumn[];
}

export interface DbEnum {
  readonly name: string;
  readonly values: readonly string[];
}

export interface DbSchemaView {
  readonly source: DbSchemaSource;
  readonly provider?: string;
  readonly models: readonly DbModel[];
  readonly enums: readonly DbEnum[];
}

/* -------------------------------------------------------------------------- */
/*  Metricas                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProcessMetricSample {
  readonly processId: string;
  readonly label: string;
  readonly pid: number;
  readonly cpu: number;
  readonly memoryMb: number;
}

export interface MetricsSnapshot {
  readonly time: number;
  readonly totalCpu: number;
  readonly totalMemoryMb: number;
  readonly systemMemoryMb: number;
  readonly processes: readonly ProcessMetricSample[];
}

/* -------------------------------------------------------------------------- */
/*  Actualizaciones                                                            */
/* -------------------------------------------------------------------------- */

export type UpdateChannel = 'stable' | 'beta' | 'nightly';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'error'
  | 'unsupported';

export interface UpdateInfoView {
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly releaseDate?: string;
  readonly releaseNotes?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly url?: string;
}

export interface UpdaterState {
  readonly phase: UpdatePhase;
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly available?: UpdateInfoView;
  readonly progressPercent?: number;
  readonly bytesPerSecond?: number;
  readonly error?: ForgeError;
  readonly lastCheckedAt?: number;
  readonly autoInstallOnQuit: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Preferencias                                                               */
/* -------------------------------------------------------------------------- */

export type ThemeId = 'forge-dark' | 'forge-light' | 'forge-high-contrast';

export interface ForgeSettings {
  readonly theme: ThemeId;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly tabSize: number;
  readonly formatOnSave: boolean;
  readonly formatter: FormatterId;
  readonly minimap: boolean;
  readonly wordWrap: boolean;
  readonly semanticHighlighting: boolean;
  readonly updateChannel: UpdateChannel;
  readonly autoInstallUpdates: boolean;
  /** Si es false, Forge AI queda inhabilitado en toda la interfaz. */
  readonly aiEnabled: boolean;
  readonly aiProvider: AiProviderId;
  readonly aiModel: string;
  readonly terminalProfile: string;
  readonly logThrottleMs: number;
  readonly recentWorkspaces: readonly string[];
}

export const DEFAULT_SETTINGS: ForgeSettings = {
  theme: 'forge-dark',
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
  fontSize: 13,
  tabSize: 2,
  formatOnSave: true,
  formatter: 'prettier',
  minimap: false,
  wordWrap: false,
  semanticHighlighting: true,
  updateChannel: 'stable',
  autoInstallUpdates: false,
  aiEnabled: true,
  aiProvider: 'anthropic',
  aiModel: 'claude-sonnet-4-5',
  terminalProfile: 'default',
  logThrottleMs: 400,
  recentWorkspaces: [],
};

/* -------------------------------------------------------------------------- */
/*  Eventos main -> renderer                                                   */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Depuracion CDP y perfilado de memoria                                      */
/* -------------------------------------------------------------------------- */

export type DebugSessionStatus =
  | 'connecting'
  | 'attached'
  | 'paused'
  | 'detached'
  | 'failed';

/** Objetivo anunciado por el inspector de Node en `/json/list`. */
export interface DebugTarget {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface DebugAttachRequest {
  /** Identificador estable elegido por el renderer. */
  readonly sessionId: string;
  readonly host?: string;
  readonly port: number;
  readonly label?: string;
  /** Proceso del gestor al que pertenece el inspector, si se conoce. */
  readonly processId?: string;
}

export interface DebugSessionInfo {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly status: DebugSessionStatus;
  readonly processId?: string;
  readonly attachedAt?: number;
  readonly pauseReason?: string;
  /** Motivo del fallo cuando `status` es `failed`; nunca lleva secretos. */
  readonly detail?: string;
}

/** Punto de interrupcion tal y como lo pide el renderer (linea 1-based). */
export interface SourceBreakpoint {
  readonly line: number;
  readonly condition?: string;
}

export interface BreakpointState {
  /** Ruta relativa al workspace. */
  readonly path: string;
  readonly line: number;
  /** true si el motor lo acepto y lo asocio a una posicion real. */
  readonly verified: boolean;
  readonly condition?: string;
  /** Linea real donde quedo anclado, si el motor lo desplazo. */
  readonly resolvedLine?: number;
}

export interface DebugCallFrameView {
  readonly id: string;
  readonly functionName: string;
  readonly url: string;
  /** Ruta relativa al workspace cuando se pudo resolver. */
  readonly path: string | null;
  readonly line: number;
  readonly column: number;
  readonly inWorkspace: boolean;
}

export interface DebugVariableView {
  readonly name: string;
  readonly value: string;
  readonly type: string;
  /** Referencia para expandir el objeto; se invalida al reanudar. */
  readonly objectId?: string;
  readonly expandable: boolean;
}

export interface DebugScopeView {
  readonly type: string;
  readonly name?: string;
  readonly objectId?: string;
  readonly variables: readonly DebugVariableView[];
}

export interface DebugPauseEvent {
  readonly sessionId: string;
  readonly reason: string;
  readonly frames: readonly DebugCallFrameView[];
  readonly hitBreakpoints: readonly string[];
}

export type DebugStepKind = 'over' | 'into' | 'out';

export interface DebugEvaluateRequest {
  readonly sessionId: string;
  readonly expression: string;
  /** Evalua en el marco indicado; sin el, en el contexto global. */
  readonly callFrameId?: string;
}

export interface DebugEvaluateResult {
  readonly value: string;
  readonly type: string;
  readonly objectId?: string;
  readonly expandable: boolean;
  /** true si la expresion lanzo: el valor lleva el mensaje del error. */
  readonly thrown: boolean;
}

export interface DebugConsoleEvent {
  readonly sessionId: string;
  readonly level: LogLevel;
  readonly text: string;
  readonly time: number;
}

export interface HeapSample {
  readonly sessionId: string;
  readonly time: number;
  readonly usedHeapMb: number;
  readonly totalHeapMb: number;
}

export interface HeapTrend {
  readonly sessionId: string;
  readonly samples: readonly HeapSample[];
  /** Pendiente por minimos cuadrados, en MB/min. */
  readonly slopeMbPerMinute: number;
  /** Crecimiento sostenido sin recuperacion: posible fuga. */
  readonly leakSuspected: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Especificaciones OpenAPI                                                   */
/* -------------------------------------------------------------------------- */

export type OpenApiMethod =
  | 'get'
  | 'post'
  | 'put'
  | 'patch'
  | 'delete'
  | 'head'
  | 'options'
  | 'trace';

export interface OpenApiParameter {
  readonly name: string;
  readonly location: 'path' | 'query' | 'header' | 'cookie';
  readonly required: boolean;
  /** Tipo ya traducido a notacion de TypeScript. */
  readonly type: string;
  readonly description?: string;
}

export interface OpenApiResponse {
  readonly status: string;
  readonly description: string;
  /** Nombre del esquema referenciado, si la respuesta lleva cuerpo. */
  readonly schemaRef?: string;
  readonly contentType?: string;
}

export interface OpenApiOperation {
  /** `operationId`, o `metodo:ruta` cuando la especificacion no lo declara. */
  readonly id: string;
  readonly method: OpenApiMethod;
  readonly path: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBodyRef?: string;
  readonly requestBodyRequired: boolean;
  readonly responses: readonly OpenApiResponse[];
  /** Linea aproximada en el documento, para saltar desde la vista. */
  readonly line: number;
}

export interface OpenApiSchemaField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly enumValues?: readonly string[];
  readonly ref?: string;
  readonly description?: string;
}

export interface OpenApiSchema {
  readonly name: string;
  readonly type: string;
  readonly fields: readonly OpenApiSchemaField[];
  readonly line: number;
}

export interface OpenApiDocumentView {
  readonly path: string;
  readonly title: string;
  readonly version: string;
  readonly openapi: string;
  readonly servers: readonly string[];
  readonly operations: readonly OpenApiOperation[];
  readonly schemas: readonly OpenApiSchema[];
  /** Lo que el lector no supo interpretar, en lugar de callarlo. */
  readonly warnings: readonly string[];
}

export type SpecGenerationTarget = 'types' | 'react-hooks' | 'vue-composables' | 'client';

export interface SpecGenerateRequest {
  readonly specPath: string;
  readonly target: SpecGenerationTarget;
  /** Limita la generacion a estas operaciones; vacio significa todas. */
  readonly operationIds?: readonly string[];
  readonly outputPath?: string;
  /** Si es false, solo se calcula el contenido y no se escribe nada. */
  readonly write?: boolean;
}

export interface SpecGenerateResult {
  readonly path: string;
  readonly content: string;
  readonly written: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Auditoria de contratos compartidos                                         */
/* -------------------------------------------------------------------------- */

export type BreakingChangeKind =
  | 'removed-export'
  | 'removed-field'
  | 'required-field-added'
  | 'optional-became-required'
  | 'type-changed'
  | 'enum-value-removed';

export interface BreakingChange {
  readonly kind: BreakingChangeKind;
  /** Nombre del tipo afectado. */
  readonly symbol: string;
  /** Campo concreto, cuando el cambio es de un miembro. */
  readonly member?: string;
  readonly before?: string;
  readonly after?: string;
  readonly detail: string;
  readonly line: number;
}

export interface ContractDependent {
  readonly path: string;
  /** Simbolos afectados que este archivo importa. */
  readonly symbols: readonly string[];
  readonly line: number;
}

export interface ContractAuditReport {
  readonly path: string;
  /** Referencia contra la que se comparo (por ejemplo `HEAD`). */
  readonly comparedAgainst: string;
  readonly changes: readonly BreakingChange[];
  readonly dependents: readonly ContractDependent[];
}

/* -------------------------------------------------------------------------- */
/*  Pruebas y cobertura                                                        */
/* -------------------------------------------------------------------------- */

export type TestRunnerId = 'vitest' | 'jest' | 'playwright' | 'node';

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'running' | 'pending';

export type TestBlockKind = 'suite' | 'case';

export type TestModifier =
  | 'none'
  | 'only'
  | 'skip'
  | 'todo'
  | 'each'
  | 'failing'
  | 'concurrent';

/** Bloque `describe`/`it` localizado en el archivo, para el code lens. */
export interface TestBlock {
  readonly id: string;
  readonly kind: TestBlockKind;
  readonly name: string;
  /** Nombre con los `describe` que lo envuelven; es lo que filtra `-t`. */
  readonly fullName: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly modifier: TestModifier;
  readonly children: readonly TestBlock[];
}

export interface TestRunRequest {
  /** Identificador de la ejecucion, elegido por el renderer. */
  readonly runId: string;
  readonly runner?: TestRunnerId;
  /** Limita la ejecucion a un archivo. */
  readonly path?: string;
  /** Filtra por nombre completo de prueba. */
  readonly testName?: string;
  readonly coverage?: boolean;
}

export interface TestCaseResult {
  readonly id: string;
  readonly name: string;
  readonly fullName: string;
  readonly path: string;
  readonly status: TestStatus;
  readonly durationMs: number;
  readonly message?: string;
  /** Archivo y linea del fallo, ya resueltos al workspace. */
  readonly failurePath?: string;
  readonly failureLine?: number;
}

export interface TestFileResult {
  readonly path: string;
  readonly status: TestStatus;
  readonly durationMs: number;
  readonly cases: readonly TestCaseResult[];
}

export interface TestRunSummary {
  readonly runId: string;
  readonly runner: TestRunnerId;
  readonly status: TestStatus;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs: number;
  readonly files: readonly TestFileResult[];
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface FileCoverage {
  readonly path: string;
  readonly coveredLines: readonly number[];
  readonly uncoveredLines: readonly number[];
  readonly statementsCovered: number;
  readonly statementsTotal: number;
  readonly branchesCovered: number;
  readonly branchesTotal: number;
  readonly percent: number;
}

export interface CoverageReport {
  readonly files: readonly FileCoverage[];
  /** Porcentaje sobre el total de sentencias, no media de porcentajes. */
  readonly percent: number;
  readonly statementsCovered: number;
  readonly statementsTotal: number;
  readonly generatedAt: number;
}

/* -------------------------------------------------------------------------- */
/*  Forge Vault: entorno y secretos                                            */
/* -------------------------------------------------------------------------- */

/** Formato esperado de un valor, deducido del nombre de la variable. */
export type EnvValueFormat =
  | 'text'
  | 'url'
  | 'port'
  | 'number'
  | 'boolean'
  | 'base64'
  | 'email'
  | 'secret';

export type EnvIssueKind =
  | 'missing'
  | 'undocumented'
  | 'empty'
  | 'placeholder'
  | 'invalid-format';

export interface EnvIssue {
  readonly kind: EnvIssueKind;
  readonly file: string;
  readonly key: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
}

/** Fila del editor tabular. El valor llega enmascarado si es secreto. */
export interface VaultVariable {
  readonly key: string;
  readonly value: string;
  readonly secret: boolean;
  readonly format: EnvValueFormat;
  /** Linea dentro del archivo, para saltar al texto plano. */
  readonly line: number;
  /** Comentario que precede a la variable, si lo hay. */
  readonly comment?: string;
}

export interface VaultFileView {
  readonly path: string;
  /** true si es el archivo de referencia (`.env.example`). */
  readonly isExample: boolean;
  readonly variables: readonly VaultVariable[];
}

export interface VaultView {
  readonly files: readonly VaultFileView[];
  readonly issues: readonly EnvIssue[];
  /** Claves guardadas en el almacen cifrado del sistema. */
  readonly vaultKeys: readonly string[];
  /** false si el sistema no ofrece cifrado: no se guardara nada. */
  readonly secureStorageAvailable: boolean;
}

/** Cambio pedido desde la tabla. `value: null` elimina la variable. */
export interface VaultEdit {
  readonly key: string;
  readonly value: string | null;
}

export interface VaultWriteRequest {
  readonly path: string;
  readonly edits: readonly VaultEdit[];
}

export interface VaultEntry {
  readonly key: string;
  readonly updatedAt: number;
}

/* -------------------------------------------------------------------------- */
/*  Motor de plugins                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Accion declarativa de un plugin.
 *
 * Es un verbo cerrado, no codigo: el manifiesto se LEE, nunca se ejecuta.
 * Ampliar la union es la unica forma de anadir capacidades, y obliga a
 * pensar en las implicaciones de cada una.
 */
export type PluginAction =
  | {
      readonly task: 'shell';
      readonly command: string;
      readonly args: readonly string[];
      /** Relativo al workspace; pasa por el guardian de rutas. */
      readonly cwd?: string;
      readonly label?: string;
    }
  | {
      /** Invoca un comando que el IDE ya tiene registrado. */
      readonly task: 'command';
      readonly id: string;
      readonly args: readonly string[];
    }
  | {
      readonly task: 'write';
      readonly path: string;
      readonly content: string;
      readonly overwrite: boolean;
    }
  | {
      readonly task: 'open';
      readonly path: string;
      readonly line?: number;
    };

export interface PluginCommand {
  /** Ya viene prefijado con el id del plugin. */
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly keybinding?: string;
  readonly actions: readonly PluginAction[];
}

export interface PluginFormatter {
  readonly languages: readonly string[];
  readonly command: string;
  readonly args: readonly string[];
  /** true si el archivo se pasa por entrada estandar en vez de `$FILE`. */
  readonly usesStdin: boolean;
}

export interface PluginScaffoldHook {
  /** Id del blueprint, o `*` para todos. */
  readonly blueprint: string;
  readonly actions: readonly PluginAction[];
}

export interface PluginWatcher {
  readonly include: readonly string[];
  readonly actions: readonly PluginAction[];
}

export interface PluginDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** Ruta del manifiesto, relativa al workspace. */
  readonly path: string;
  readonly commands: readonly PluginCommand[];
  readonly formatters: readonly PluginFormatter[];
  readonly scaffold: readonly PluginScaffoldHook[];
  readonly watchers: readonly PluginWatcher[];
}

export interface PluginState {
  readonly definition: PluginDefinition;
  readonly enabled: boolean;
  /** Problemas del manifiesto; el plugin puede seguir siendo util. */
  readonly errors: readonly string[];
}

export interface PluginRunResult {
  readonly commandId: string;
  /** Acciones que se completaron, en orden. */
  readonly performed: readonly string[];
  /** Procesos lanzados, para seguirlos en el panel de salida. */
  readonly processIds: readonly string[];
}

export type ForgeEvent =
  | { readonly type: 'window/state'; readonly payload: WindowState }
  | { readonly type: 'workspace/changed'; readonly payload: WorkspaceInfo | null }
  | { readonly type: 'fs/changed'; readonly payload: readonly FileChangeEvent[] }
  | { readonly type: 'dotforge/changed'; readonly payload: DotForgeManifest }
  | { readonly type: 'process/state'; readonly payload: ProcessInfo }
  | { readonly type: 'process/logs'; readonly payload: readonly LogRecord[] }
  | { readonly type: 'lsp/state'; readonly payload: LspServerState }
  | { readonly type: 'lsp/notification'; readonly payload: LspServerNotification }
  | { readonly type: 'ai/stream'; readonly payload: AiStreamEvent }
  | { readonly type: 'git/changed'; readonly payload: GitStatus }
  | {
      readonly type: 'pty/data';
      readonly payload: { readonly id: string; readonly data: string };
    }
  | {
      readonly type: 'pty/exit';
      readonly payload: { readonly id: string; readonly exitCode: number };
    }
  | { readonly type: 'metrics/sample'; readonly payload: MetricsSnapshot }
  | { readonly type: 'debug/session'; readonly payload: DebugSessionInfo }
  | { readonly type: 'debug/paused'; readonly payload: DebugPauseEvent }
  | {
      readonly type: 'debug/resumed';
      readonly payload: { readonly sessionId: string };
    }
  | {
      readonly type: 'debug/breakpoints';
      readonly payload: {
        readonly sessionId: string;
        readonly breakpoints: readonly BreakpointState[];
      };
    }
  | { readonly type: 'debug/console'; readonly payload: DebugConsoleEvent }
  | { readonly type: 'debug/heap'; readonly payload: HeapSample }
  | {
      readonly type: 'test/started';
      readonly payload: {
        readonly runId: string;
        readonly runner: TestRunnerId;
        readonly path?: string;
      };
    }
  | { readonly type: 'test/finished'; readonly payload: TestRunSummary }
  | { readonly type: 'test/coverage'; readonly payload: CoverageReport }
  | { readonly type: 'vault/changed'; readonly payload: VaultView }
  | {
      readonly type: 'plugin/changed';
      readonly payload: readonly PluginState[];
    }
  | { readonly type: 'updater/state'; readonly payload: UpdaterState }
  | { readonly type: 'docker/changed'; readonly payload: readonly ContainerInfo[] }
  | {
      readonly type: 'ui/command';
      readonly payload: { readonly command: string; readonly args?: unknown };
    }
  | {
      readonly type: 'notification';
      readonly payload: {
        readonly level: 'info' | 'warn' | 'error';
        readonly message: string;
        readonly detail?: string;
      };
    };

export type ForgeEventType = ForgeEvent['type'];

export type ForgeEventPayload<T extends ForgeEventType> = Extract<
  ForgeEvent,
  { type: T }
>['payload'];
