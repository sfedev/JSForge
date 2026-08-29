/**
 * Estado global del renderer.
 *
 * Contenedor observable minimo: sin dependencias, sin proxies y con
 * notificacion agrupada por frame. Las vistas se suscriben a las claves que
 * les interesan, de modo que un lote de logs no repinta el arbol de archivos.
 */

import type {
  AiProviderInfo,
  BreakpointState,
  DebugCallFrameView,
  DebugConsoleEvent,
  DebugSessionInfo,
  DotForgeManifest,
  HeapSample,
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
  | 'metrics'
  | 'debug';

export type PanelView = 'output' | 'terminal' | 'problems' | 'http' | 'metrics' | 'debug';

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

  /**
   * Puntos de interrupcion por ruta relativa.
   *
   * Los posee el renderer, no la sesion: se pueden marcar sin estar
   * depurando y se empujan al motor en cuanto hay sesion. Es lo que permite
   * poner un punto, arrancar el proceso y que pare a la primera.
   */
  breakpoints: Map<string, BreakpointState[]>;
  debugSessions: DebugSessionInfo[];
  activeDebugSession: string | null;
  debugFrames: DebugCallFrameView[];
  activeDebugFrame: string | null;
  debugConsole: DebugConsoleEvent[];
  /** Muestras de heap por sesion, para la grafica de fugas. */
  heapSamples: Map<string, HeapSample[]>;
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

    breakpoints: new Map(),
    debugSessions: [],
    activeDebugSession: null,
    debugFrames: [],
    activeDebugFrame: null,
    debugConsole: [],
    heapSamples: new Map(),
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

/* -------------------------------------------------------------------------- */
/*  Depuracion                                                                 */
/* -------------------------------------------------------------------------- */

/** Anillo de la consola de depuracion: acotado igual que el de logs. */
const MAX_DEBUG_CONSOLE = 2000;

/** Ventana de muestras de heap conservada por sesion (10 min a 2 s). */
const MAX_HEAP_SAMPLES = 300;

export function upsertDebugSession(info: DebugSessionInfo): void {
  store.mutate(['debugSessions', 'activeDebugSession'], (state) => {
    const index = state.debugSessions.findIndex((entry) => entry.id === info.id);
    if (info.status === 'detached') {
      if (index !== -1) {
        state.debugSessions.splice(index, 1);
      }
      if (state.activeDebugSession === info.id) {
        state.activeDebugSession = state.debugSessions[0]?.id ?? null;
      }
      return;
    }
    if (index === -1) {
      state.debugSessions.push(info);
    } else {
      state.debugSessions[index] = info;
    }
    if (state.activeDebugSession === null) {
      state.activeDebugSession = info.id;
    }
  });
}

export function pushDebugConsole(entry: DebugConsoleEvent): void {
  store.mutate(['debugConsole'], (state) => {
    state.debugConsole.push(entry);
    if (state.debugConsole.length > MAX_DEBUG_CONSOLE) {
      state.debugConsole.splice(0, state.debugConsole.length - MAX_DEBUG_CONSOLE);
    }
  });
}

export function pushHeapSample(sample: HeapSample): void {
  store.mutate(['heapSamples'], (state) => {
    let series = state.heapSamples.get(sample.sessionId);
    if (series === undefined) {
      series = [];
      state.heapSamples.set(sample.sessionId, series);
    }
    series.push(sample);
    if (series.length > MAX_HEAP_SAMPLES) {
      series.splice(0, series.length - MAX_HEAP_SAMPLES);
    }
  });
}

export function breakpointsFor(path: string): readonly BreakpointState[] {
  return store.state.breakpoints.get(path) ?? [];
}

/**
 * Alterna el punto de una linea y devuelve el juego resultante del archivo.
 *
 * Devolver el estado final (y no solo mutar) es lo que permite al llamante
 * empujarlo al motor sin volver a leer el store, que aun no ha notificado.
 */
export function toggleBreakpoint(path: string, line: number): readonly BreakpointState[] {
  const current = [...(store.state.breakpoints.get(path) ?? [])];
  const index = current.findIndex((entry) => entry.line === line);
  if (index === -1) {
    current.push({ path, line, verified: false });
    current.sort((a, b) => a.line - b.line);
  } else {
    current.splice(index, 1);
  }
  setBreakpointsFor(path, current);
  return current;
}

export function setBreakpointsFor(path: string, points: readonly BreakpointState[]): void {
  store.mutate(['breakpoints'], (state) => {
    if (points.length === 0) {
      state.breakpoints.delete(path);
    } else {
      state.breakpoints.set(path, [...points]);
    }
  });
}

/**
 * Aplica el estado de verificacion que devuelve el motor.
 *
 * Solo toca `verified`: la lista de lineas la manda el editor, y machacarla
 * con la respuesta del motor haria desaparecer los puntos de archivos que
 * esa sesion todavia no ha cargado.
 */
export function applyBreakpointVerification(states: readonly BreakpointState[]): void {
  const byPath = new Map<string, Set<number>>();
  for (const state of states) {
    if (!state.verified) {
      continue;
    }
    let lines = byPath.get(state.path);
    if (lines === undefined) {
      lines = new Set();
      byPath.set(state.path, lines);
    }
    lines.add(state.line);
  }

  store.mutate(['breakpoints'], (state) => {
    for (const [path, points] of state.breakpoints) {
      const verifiedLines = byPath.get(path);
      state.breakpoints.set(
        path,
        points.map((point) => ({ ...point, verified: verifiedLines?.has(point.line) === true })),
      );
    }
  });
}
