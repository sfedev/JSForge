/**
 * Superficie publica expuesta al renderer como `window.forge`.
 *
 * El preload implementa exactamente esta interfaz y nada mas: no se expone
 * `ipcRenderer`, `require`, `process` ni ningun objeto de Node. Cada metodo
 * es un envoltorio explicito sobre un canal declarado en `IPC`.
 */

import type {
  AiChatRequest,
  AiProviderId,
  AiProviderInfo,
  AppInfo,
  Blueprint,
  BreakpointState,
  ComposeFileView,
  ContainerInfo,
  ContractAuditReport,
  CoverageReport,
  DbSchemaView,
  DebugAttachRequest,
  DebugEvaluateRequest,
  DebugEvaluateResult,
  DebugScopeView,
  DebugSessionInfo,
  DebugStepKind,
  DebugTarget,
  DebugVariableView,
  DirEntry,
  DotForgeConfig,
  DotForgeManifest,
  EnvFileView,
  FileStat,
  ForgeEvent,
  ForgeSettings,
  FormatRequest,
  FormatResponse,
  GenerateRequest,
  GenerateResult,
  GitBranch,
  GitCommitRequest,
  GitDiffPair,
  GitDiffRequest,
  GitLogEntry,
  GitStatus,
  HeapTrend,
  HttpEndpointLens,
  HttpRequestSpec,
  HttpResponseView,
  LanguageServerId,
  LspNotifyPayload,
  LspRequestPayload,
  LspServerState,
  MetricsSnapshot,
  OpenApiDocumentView,
  ProcessInfo,
  ProjectManifest,
  PtyCreateRequest,
  PtyCreateResult,
  PtyProfile,
  ReadFileResult,
  Result,
  ScriptEntry,
  SearchRequest,
  SearchResult,
  SourceBreakpoint,
  SpecGenerateRequest,
  SpecGenerateResult,
  StartProcessRequest,
  TestBlock,
  TestRunRequest,
  TestRunSummary,
  TestRunnerId,
  ToolchainInfo,
  UpdateChannel,
  UpdaterState,
  VaultView,
  VaultWriteRequest,
  WindowState,
  WorkspaceInfo,
  WriteFileRequest,
  CommandSuggestion,
} from './contracts.js';

export interface ForgeAppApi {
  info(): Promise<Result<AppInfo>>;
  /** Solo abre http(s) y mailto hacia destinos validados en el main. */
  openExternal(url: string): Promise<Result<true>>;
}

export interface ForgeWindowApi {
  minimize(): Promise<Result<true>>;
  toggleMaximize(): Promise<Result<true>>;
  close(): Promise<Result<true>>;
  state(): Promise<Result<WindowState>>;
}

export interface ForgeWorkspaceApi {
  /** Abre el dialogo nativo de seleccion de carpeta. */
  pick(): Promise<Result<WorkspaceInfo | null>>;
  open(absolutePath: string): Promise<Result<WorkspaceInfo>>;
  close(): Promise<Result<true>>;
  current(): Promise<Result<WorkspaceInfo | null>>;
  recent(): Promise<Result<readonly string[]>>;
  /**
   * Abre el selector nativo de carpeta y devuelve la ruta elegida SIN
   * abrirla como workspace. Lo usa el asistente de scaffolding para elegir
   * el destino de un proyecto nuevo.
   */
  pickDirectory(title?: string): Promise<Result<string | null>>;
}

export interface ForgeFileSystemApi {
  readDir(relativePath: string): Promise<Result<readonly DirEntry[]>>;
  readFile(relativePath: string): Promise<Result<ReadFileResult>>;
  writeFile(request: WriteFileRequest): Promise<Result<FileStat>>;
  createFile(relativePath: string, content?: string): Promise<Result<FileStat>>;
  createDir(relativePath: string): Promise<Result<FileStat>>;
  rename(fromRelative: string, toRelative: string): Promise<Result<FileStat>>;
  remove(relativePath: string): Promise<Result<true>>;
  stat(relativePath: string): Promise<Result<FileStat>>;
  search(request: SearchRequest): Promise<Result<SearchResult>>;
  /** Busca archivos por nombre para el selector rapido. */
  findFiles(query: string, limit?: number): Promise<Result<readonly string[]>>;
  watchStart(): Promise<Result<true>>;
  watchStop(): Promise<Result<true>>;
}

export interface ForgeDotForgeApi {
  readConfig(): Promise<Result<DotForgeManifest>>;
  writeConfig(config: DotForgeConfig): Promise<Result<DotForgeManifest>>;
  /** Sincroniza el manifiesto con package.json y los frameworks detectados. */
  sync(): Promise<Result<DotForgeManifest>>;
  /** Esquema JSON usado para validacion y autocompletado de manifiestos. */
  schema(): Promise<Result<unknown>>;
  blueprints(): Promise<Result<readonly Blueprint[]>>;
  generate(request: GenerateRequest): Promise<Result<GenerateResult>>;
  runPipeline(pipelineId: string): Promise<Result<readonly ProcessInfo[]>>;
}

export interface ForgeToolchainApi {
  detect(): Promise<Result<ToolchainInfo>>;
  manifest(): Promise<Result<ProjectManifest>>;
  scripts(): Promise<Result<readonly ScriptEntry[]>>;
}

export interface ForgeProcessApi {
  start(request: StartProcessRequest): Promise<Result<ProcessInfo>>;
  stop(id: string): Promise<Result<true>>;
  restart(id: string): Promise<Result<ProcessInfo>>;
  list(): Promise<Result<readonly ProcessInfo[]>>;
  clear(id: string): Promise<Result<true>>;
  /** Variables de entorno con los valores sensibles ya enmascarados. */
  readEnv(environment?: string): Promise<Result<readonly EnvFileView[]>>;
  /** Revela el valor real de una unica clave, bajo peticion explicita. */
  revealEnv(file: string, key: string): Promise<Result<string>>;
}

export interface ForgeLspApi {
  ensure(server: LanguageServerId): Promise<Result<LspServerState>>;
  stop(server: LanguageServerId): Promise<Result<true>>;
  request(payload: LspRequestPayload): Promise<Result<unknown>>;
  notify(payload: LspNotifyPayload): Promise<Result<true>>;
  status(): Promise<Result<readonly LspServerState[]>>;
}

export interface ForgeFormatApi {
  document(request: FormatRequest): Promise<Result<FormatResponse>>;
}

export interface ForgeAiApi {
  providers(): Promise<Result<readonly AiProviderInfo[]>>;
  setKey(provider: AiProviderId, apiKey: string): Promise<Result<true>>;
  deleteKey(provider: AiProviderId): Promise<Result<true>>;
  models(provider: AiProviderId): Promise<Result<readonly string[]>>;
  /** El texto llega por eventos `ai/stream`; aqui solo se acepta la peticion. */
  chat(request: AiChatRequest): Promise<Result<true>>;
  cancel(requestId: string): Promise<Result<true>>;
}

export interface ForgeGitApi {
  status(): Promise<Result<GitStatus>>;
  branches(): Promise<Result<readonly GitBranch[]>>;
  checkout(branch: string): Promise<Result<true>>;
  createBranch(name: string, from?: string): Promise<Result<true>>;
  stage(paths: readonly string[]): Promise<Result<true>>;
  unstage(paths: readonly string[]): Promise<Result<true>>;
  discard(paths: readonly string[]): Promise<Result<true>>;
  /** Aplica un parche unificado al indice (stage por bloque). */
  applyPatch(patch: string, reverse?: boolean): Promise<Result<true>>;
  commit(request: GitCommitRequest): Promise<Result<GitLogEntry>>;
  log(limit?: number): Promise<Result<readonly GitLogEntry[]>>;
  diff(request: GitDiffRequest): Promise<Result<GitDiffPair>>;
}

export interface ForgeTerminalApi {
  profiles(): Promise<Result<readonly PtyProfile[]>>;
  create(request: PtyCreateRequest): Promise<Result<PtyCreateResult>>;
  write(id: string, data: string): Promise<Result<true>>;
  resize(id: string, cols: number, rows: number): Promise<Result<true>>;
  dispose(id: string): Promise<Result<true>>;
  suggest(prefix: string): Promise<Result<readonly CommandSuggestion[]>>;
}

export interface ForgeHttpApi {
  send(request: HttpRequestSpec): Promise<Result<HttpResponseView>>;
  cancel(id: string): Promise<Result<true>>;
  /** Analiza un documento `.http`/`.rest` y devuelve las peticiones. */
  parse(content: string): Promise<Result<readonly HttpRequestSpec[]>>;
  /** Detecta endpoints Express/NestJS/Fastify/Next para el code lens. */
  endpoints(relativePath: string, content: string): Promise<Result<readonly HttpEndpointLens[]>>;
}

export interface ForgeDockerApi {
  available(): Promise<Result<boolean>>;
  parseCompose(relativePath: string): Promise<Result<ComposeFileView>>;
  up(relativePath: string, services: readonly string[]): Promise<Result<true>>;
  down(relativePath: string, services: readonly string[]): Promise<Result<true>>;
  ps(): Promise<Result<readonly ContainerInfo[]>>;
}

export interface ForgeDbApi {
  schema(): Promise<Result<DbSchemaView | null>>;
}

export interface ForgeMetricsApi {
  snapshot(): Promise<Result<MetricsSnapshot>>;
  subscribe(enabled: boolean): Promise<Result<true>>;
}

export interface ForgeUpdaterApi {
  state(): Promise<Result<UpdaterState>>;
  check(): Promise<Result<UpdaterState>>;
  download(): Promise<Result<true>>;
  /** `restartNow=false` aplica la actualizacion en el proximo arranque. */
  install(restartNow: boolean): Promise<Result<true>>;
  setChannel(channel: UpdateChannel): Promise<Result<UpdaterState>>;
}

export interface ForgeDebugApi {
  /** Sondea `/json/list` sin abrir sesion; sirve para descubrir el puerto. */
  discover(host: string, port: number): Promise<Result<readonly DebugTarget[]>>;
  attach(request: DebugAttachRequest): Promise<Result<DebugSessionInfo>>;
  detach(sessionId: string): Promise<Result<true>>;
  sessions(): Promise<Result<readonly DebugSessionInfo[]>>;
  /** Reemplaza en bloque los puntos de interrupcion de un archivo. */
  setBreakpoints(
    sessionId: string,
    relativePath: string,
    points: readonly SourceBreakpoint[],
  ): Promise<Result<readonly BreakpointState[]>>;
  resume(sessionId: string): Promise<Result<true>>;
  pause(sessionId: string): Promise<Result<true>>;
  step(sessionId: string, kind: DebugStepKind): Promise<Result<true>>;
  evaluate(request: DebugEvaluateRequest): Promise<Result<DebugEvaluateResult>>;
  scopes(sessionId: string, frameId: string): Promise<Result<readonly DebugScopeView[]>>;
  properties(sessionId: string, objectId: string): Promise<Result<readonly DebugVariableView[]>>;
  /** El muestreo llega por eventos `debug/heap`. */
  subscribeHeap(sessionId: string, enabled: boolean): Promise<Result<true>>;
  heapTrend(sessionId: string): Promise<Result<HeapTrend>>;
  collectGarbage(sessionId: string): Promise<Result<true>>;
}

export interface ForgeSpecApi {
  /** Especificaciones OpenAPI detectadas en el workspace. */
  discover(): Promise<Result<readonly string[]>>;
  parse(relativePath: string): Promise<Result<OpenApiDocumentView>>;
  /** Con `write: false` solo calcula el contenido; no toca el disco. */
  generate(request: SpecGenerateRequest): Promise<Result<SpecGenerateResult>>;
  /** Modulos de `src/shared/` que se pueden auditar. */
  auditTargets(): Promise<Result<readonly string[]>>;
  audit(relativePath: string, revision?: string): Promise<Result<ContractAuditReport>>;
}

export interface ForgeTestingApi {
  /** Archivos `*.test.ts` / `*.spec.ts` del workspace. */
  discover(): Promise<Result<readonly string[]>>;
  /**
   * Bloques `describe`/`it` de un archivo, para el code lens.
   * Con `content` se analiza lo que el editor tiene sin guardar.
   */
  blocks(relativePath: string, content?: string): Promise<Result<readonly TestBlock[]>>;
  runners(): Promise<Result<readonly TestRunnerId[]>>;
  /** El progreso llega por eventos `test/started` y `test/finished`. */
  run(request: TestRunRequest): Promise<Result<TestRunSummary>>;
  cancel(runId: string): Promise<Result<true>>;
  lastRun(): Promise<Result<TestRunSummary | null>>;
  coverage(): Promise<Result<CoverageReport | null>>;
}

export interface ForgeVaultApi {
  /** Archivos de entorno con los secretos ya enmascarados. */
  read(): Promise<Result<VaultView>>;
  write(request: VaultWriteRequest): Promise<Result<VaultView>>;
  /** Revela el valor real de UNA clave, a peticion explicita. */
  reveal(file: string, key: string): Promise<Result<string>>;
  /** Claves del almacen cifrado; los valores nunca salen del main. */
  secrets(): Promise<Result<readonly string[]>>;
  setSecret(key: string, value: string): Promise<Result<true>>;
  deleteSecret(key: string): Promise<Result<true>>;
  /** Cifra la variable y la RETIRA del archivo en texto plano. */
  promote(file: string, key: string): Promise<Result<VaultView>>;
  /** Vuelca las claves a `.env.example`, sin los valores sensibles. */
  syncExample(): Promise<Result<VaultView>>;
}

export interface ForgeSettingsApi {
  get(): Promise<Result<ForgeSettings>>;
  set(patch: Partial<ForgeSettings>): Promise<Result<ForgeSettings>>;
}

/** Cancela la suscripcion a eventos. */
export type Unsubscribe = () => void;

export interface ForgeApi {
  readonly app: ForgeAppApi;
  readonly window: ForgeWindowApi;
  readonly workspace: ForgeWorkspaceApi;
  readonly fileSystem: ForgeFileSystemApi;
  readonly dotforge: ForgeDotForgeApi;
  readonly toolchain: ForgeToolchainApi;
  readonly process: ForgeProcessApi;
  readonly lsp: ForgeLspApi;
  readonly format: ForgeFormatApi;
  readonly ai: ForgeAiApi;
  readonly git: ForgeGitApi;
  readonly terminal: ForgeTerminalApi;
  readonly http: ForgeHttpApi;
  readonly docker: ForgeDockerApi;
  readonly db: ForgeDbApi;
  readonly metrics: ForgeMetricsApi;
  readonly debug: ForgeDebugApi;
  readonly spec: ForgeSpecApi;
  readonly testing: ForgeTestingApi;
  readonly vault: ForgeVaultApi;
  readonly updater: ForgeUpdaterApi;
  readonly settings: ForgeSettingsApi;
  /** Suscripcion al flujo unico de eventos main -> renderer. */
  on(listener: (event: ForgeEvent) => void): Unsubscribe;
}

declare global {
  interface Window {
    readonly forge: ForgeApi;
  }
}
