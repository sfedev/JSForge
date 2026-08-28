/**
 * Estado global del renderer.
 *
 * Contenedor observable minimo: sin dependencias, sin proxies y con
 * notificacion agrupada por frame. Las vistas se suscriben a las claves que
 * les interesan, de modo que un lote de logs no repinta el arbol de archivos.
 */

import type {
  AiProviderInfo,
  DotForgeManifest,
  ForgeSettings,
  GitStatus,
  LogRecord,
  LspServerState,
  MetricsSnapshot,
  ProcessInfo,
  ProjectManifest,
  ToolchainInfo,
  UpdaterState,
  WorkspaceInfo,
} from '../../shared/contracts.js';
import { DEFAULT_SETTINGS } from '../../shared/contracts.js';

export interface OpenDocument {
  /** Ruta relativa al workspace, o URI virtual (`forge-diff:`…). */
  readonly path: string;
  readonly title: string;
  readonly languageId: string;
  dirty: boolean;
  /** mtime de la ultima lectura; detecta ediciones externas al guardar. */
  modifiedAt: number;
  bom: boolean;
  eol: 'lf' | 'crlf';
  /** Vista especial: diff lado a lado en lugar del editor normal. */
  readonly kind: 'file' | 'diff' | 'http';
  readonly diffAgainst?: string;
}

export type SidebarView =
  | 'explorer'
  | 'search'
  | 'git'
  | 'pipelines'
  | 'services'
  | 'http'
  | 'metrics';

export type PanelView = 'output' | 'terminal' | 'problems' | 'http' | 'metrics';

export interface AiConversationMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  content: string;
  streaming: boolean;
  error?: string;
}

export interface ForgeState {
  booted: boolean;
  settings: ForgeSettings;
  workspace: WorkspaceInfo | null;
  manifest: DotForgeManifest | null;
  project: ProjectManifest | null;
  toolchain: ToolchainInfo | null;

  documents: OpenDocument[];
  activeDocument: string | null;

  sidebarView: SidebarView;
  sidebarVisible: boolean;
  panelView: PanelView;
  panelVisible: boolean;
  auxVisible: boolean;

  processes: ProcessInfo[];
  activeProcessId: string | null;
  logs: Map<string, LogRecord[]>;

  git: GitStatus | null;
  lsp: LspServerState[];
  metrics: MetricsSnapshot | null;
  metricsHistory: MetricsSnapshot[];
  updater: UpdaterState | null;

  aiProviders: AiProviderInfo[];
  aiMessages: AiConversationMessage[];
  aiBusyRequestId: string | null;
}

export type StateKey = keyof ForgeState;

const MAX_LOGS_PER_CHANNEL = 5000;
const MAX_METRIC_SAMPLES = 120;

function initialState(): ForgeState {
  return {
    booted: false,
    settings: DEFAULT_SETTINGS,
    workspace: null,
    manifest: null,
    project: null,
    toolchain: null,

    documents: [],
    activeDocument: null,

    sidebarView: 'explorer',
    sidebarVisible: true,
    panelView: 'output',
    panelVisible: true,
    auxVisible: true,

    processes: [],
    activeProcessId: null,
    logs: new Map(),

    git: null,
    lsp: [],
    metrics: null,
    metricsHistory: [],
    updater: null,

    aiProviders: [],
    aiMessages: [],
    aiBusyRequestId: null,
  };
}

type Listener = (state: ForgeState) => void;

class Store {
  #state: ForgeState = initialState();
  readonly #listeners = new Map<StateKey | '*', Set<Listener>>();
  #pending = new Set<StateKey>();
  #scheduled = false;

  public get state(): Readonly<ForgeState> {
    return this.#state;
  }

  /** Aplica un parche y notifica solo a quien observa las claves tocadas. */
  public patch(partial: Partial<ForgeState>): void {
    let changed = false;
    for (const [key, value] of Object.entries(partial) as [StateKey, never][]) {
      if (this.#state[key] === value) {
        continue;
      }
      this.#state[key] = value;
      this.#pending.add(key);
      changed = true;
    }
    if (changed) {
      this.#schedule();
    }
  }

  /**
   * Muta el estado en sitio (util para estructuras grandes como los logs)
   * y marca explicitamente las claves afectadas.
   */
  public mutate(keys: readonly StateKey[], mutator: (state: ForgeState) => void): void {
    mutator(this.#state);
    for (const key of keys) {
      this.#pending.add(key);
    }
    this.#schedule();
  }

  public subscribe(keys: readonly StateKey[] | '*', listener: Listener): () => void {
    const targets: (StateKey | '*')[] = keys === '*' ? ['*'] : [...keys];
    for (const key of targets) {
      let set = this.#listeners.get(key);
      if (set === undefined) {
        set = new Set();
        this.#listeners.set(key, set);
      }
      set.add(listener);
    }
    return () => {
      for (const key of targets) {
        this.#listeners.get(key)?.delete(listener);
      }
    };
  }

  #schedule(): void {
    if (this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        this.#scheduled = false;
        const keys = this.#pending;
        this.#pending = new Set();
        const notified = new Set<Listener>();
        for (const key of keys) {
          for (const listener of this.#listeners.get(key) ?? []) {
            notified.add(listener);
          }
        }
        for (const listener of this.#listeners.get('*') ?? []) {
          notified.add(listener);
        }
        for (const listener of notified) {
          try {
            listener(this.#state);
          } catch (cause) {
            console.error('[forge] fallo un suscriptor del store', cause);
          }
        }
      });
    });
  }
}

export const store = new Store();

/* -------------------------------------------------------------------------- */
/*  Ayudantes de dominio                                                       */
/* -------------------------------------------------------------------------- */

export function appendLogs(records: readonly LogRecord[]): void {
  if (records.length === 0) {
    return;
  }
  store.mutate(['logs'], (state) => {
    for (const record of records) {
      let channel = state.logs.get(record.processId);
      if (channel === undefined) {
        channel = [];
        state.logs.set(record.processId, channel);
      }
      channel.push(record);
      // Anillo acotado: sin esto, un proceso ruidoso agota la memoria.
      if (channel.length > MAX_LOGS_PER_CHANNEL) {
        channel.splice(0, channel.length - MAX_LOGS_PER_CHANNEL);
      }
    }
  });
}

export function clearLogs(processId: string): void {
  store.mutate(['logs'], (state) => {
    state.logs.set(processId, []);
  });
}

export function upsertProcess(info: ProcessInfo): void {
  store.mutate(['processes'], (state) => {
    const index = state.processes.findIndex((entry) => entry.id === info.id);
    if (index === -1) {
      state.processes.push(info);
    } else {
      state.processes[index] = info;
    }
    if (state.activeProcessId === null) {
      state.activeProcessId = info.id;
    }
  });
}

export function pushMetrics(sample: MetricsSnapshot): void {
  store.mutate(['metrics', 'metricsHistory'], (state) => {
    state.metrics = sample;
    state.metricsHistory.push(sample);
    if (state.metricsHistory.length > MAX_METRIC_SAMPLES) {
      state.metricsHistory.splice(0, state.metricsHistory.length - MAX_METRIC_SAMPLES);
    }
  });
}

export function findDocument(path: string): OpenDocument | undefined {
  return store.state.documents.find((document) => document.path === path);
}
