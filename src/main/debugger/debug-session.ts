/**
 * Sesiones de depuracion.
 *
 * Cada sesion envuelve un `CdpClient` y traduce el protocolo crudo a los
 * DTO que entiende el renderer. Aqui se concentra el estado que el cliente
 * deliberadamente no guarda: puntos de interrupcion pedidos, marcos de la
 * ultima pausa y muestras de heap.
 *
 * Dos invariantes que conviene no perder de vista:
 *  - Los `objectId` que devuelve el motor caducan al reanudar. Se limpian en
 *    cada `resume` para que la vista no intente expandir referencias muertas.
 *  - Los puntos se registran por URL (`setBreakpointByUrl`), no por script,
 *    de modo que sobreviven a una recarga del modulo y se pueden fijar antes
 *    incluso de que el archivo se haya cargado.
 */

import {
  forgeError,
  type BreakpointState,
  type DebugAttachRequest,
  type DebugCallFrameView,
  type DebugEvaluateResult,
  type DebugScopeView,
  type DebugSessionInfo,
  type DebugSessionStatus,
  type DebugStepKind,
  type DebugVariableView,
  type HeapSample,
  type HeapTrend,
  type LogLevel,
  type SourceBreakpoint,
} from '../../shared/contracts.js';
import { emit } from '../ipc/event-bus.js';
import { requireWorkspaceRoot } from '../services/workspace-service.js';
import { assertInsideWorkspace } from '../security/workspace-guard.js';
import { CdpClient, discoverTargets, debuggerPath, isLoopbackHost } from './cdp-client.js';
import {
  frameLabel,
  scriptUrlToWorkspaceRelative,
  workspaceRelativeToScriptUrl,
} from './source-map.js';
import { MIN_SAMPLES_FOR_TREND, heapSlopeMbPerMinute, isLeakSuspected } from './heap-trend.js';

/** Cadencia del muestreo de heap. Coincide con el panel de metricas. */
const HEAP_INTERVAL_MS = 2000;

/** Ventana de muestras conservada por sesion (10 min a 2 s). */
const MAX_HEAP_SAMPLES = 300;

/** Tope de variables mostradas por ambito: mas satura la vista sin aportar. */
const MAX_VARIABLES_PER_SCOPE = 200;

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

/** Ambito tal y como lo anuncia el motor, antes de resolver sus variables. */
interface ScopeRef {
  readonly type: string;
  readonly name?: string;
  readonly objectId?: string;
}

interface Session {
  info: DebugSessionInfo;
  readonly client: CdpClient;
  /** Ruta relativa -> puntos pedidos por el usuario. */
  readonly requested: Map<string, SourceBreakpoint[]>;
  /** Ruta relativa -> `breakpointId` que devolvio el motor, por linea. */
  readonly resolved: Map<string, Map<number, string>>;
  frames: DebugCallFrameView[];
  /** `callFrameId` de CDP por identificador expuesto al renderer. */
  frameIds: Map<string, string>;
  /** Cadena de ambitos por marco, capturada en la pausa. */
  scopeChains: Map<string, readonly ScopeRef[]>;
  heap: HeapSample[];
  heapTimer: NodeJS.Timeout | null;
}

const sessions = new Map<string, Session>();

/* -------------------------------------------------------------------------- */
/*  Publicacion de estado                                                      */
/* -------------------------------------------------------------------------- */

function publish(session: Session, status: DebugSessionStatus, patch: Partial<DebugSessionInfo> = {}): void {
  session.info = { ...session.info, status, ...patch };
  emit({ type: 'debug/session', payload: session.info });
}

function publishBreakpoints(session: Session): void {
  const breakpoints: BreakpointState[] = [];
  for (const [path, points] of session.requested) {
    const resolved = session.resolved.get(path);
    for (const point of points) {
      breakpoints.push({
        path,
        line: point.line,
        verified: resolved?.has(point.line) === true,
        ...(point.condition === undefined ? {} : { condition: point.condition }),
      });
    }
  }
  emit({
    type: 'debug/breakpoints',
    payload: { sessionId: session.info.id, breakpoints },
  });
}

function console_(session: Session, level: LogLevel, text: string): void {
  emit({
    type: 'debug/console',
    payload: { sessionId: session.info.id, level, text, time: Date.now() },
  });
}

/* -------------------------------------------------------------------------- */
/*  Conversion de valores CDP                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Describe un `RemoteObject` en una linea.
 *
 * Se prefiere la descripcion que ya calcula el motor: reconstruirla aqui
 * daria `[object Object]` para casi todo lo interesante.
 */
export function describeRemoteObject(value: unknown): DebugVariableView['value'] {
  if (typeof value !== 'object' || value === null) {
    return String(value);
  }
  const record = value as Record<string, unknown>;
  if (typeof record['unserializableValue'] === 'string') {
    return record['unserializableValue'];
  }
  if (typeof record['description'] === 'string') {
    return record['description'];
  }
  if ('value' in record) {
    const raw = record['value'];
    if (typeof raw === 'string') {
      return JSON.stringify(raw);
    }
    return String(raw);
  }
  const subtype = record['subtype'];
  if (subtype === 'null') {
    return 'null';
  }
  return typeof record['type'] === 'string' ? String(record['type']) : 'undefined';
}

function toVariable(name: string, remote: unknown): DebugVariableView {
  const record = (typeof remote === 'object' && remote !== null ? remote : {}) as Record<string, unknown>;
  const objectId = typeof record['objectId'] === 'string' ? record['objectId'] : undefined;
  const type = typeof record['type'] === 'string' ? record['type'] : 'undefined';
  return {
    name,
    value: describeRemoteObject(remote),
    type: typeof record['subtype'] === 'string' ? String(record['subtype']) : type,
    ...(objectId === undefined ? {} : { objectId }),
    // Solo se puede expandir lo que conserva identidad en el motor.
    expandable: objectId !== undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  Conexion                                                                   */
/* -------------------------------------------------------------------------- */

export async function attach(request: DebugAttachRequest): Promise<DebugSessionInfo> {
  const sessionId = request.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    failure('E_INVALID_ARGUMENT', 'La sesion de depuracion no declara identificador.');
  }
  if (sessions.has(sessionId)) {
    failure('E_ALREADY_EXISTS', `Ya hay una sesion de depuracion "${sessionId}".`);
  }

  const host = request.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    failure(
      'E_PERMISSION',
      'Solo se puede depurar en el bucle local.',
      'El inspector de Node no autentica: exponerlo a la red permitiria ejecutar codigo remoto.',
    );
  }
  const port = Number(request.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    failure('E_INVALID_ARGUMENT', `Puerto de inspector no valido: ${String(request.port)}.`);
  }

  let targets;
  try {
    targets = await discoverTargets(host, port);
  } catch (cause) {
    failure(
      'E_NETWORK',
      `No se encontro ningun inspector en ${host}:${port}.`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const target = targets[0];
  if (target === undefined) {
    failure(
      'E_NOT_FOUND',
      `El inspector de ${host}:${port} no anuncia ningun destino.`,
      'Arranca el proceso con --inspect o --inspect-brk.',
    );
  }

  const client = new CdpClient(host, port, debuggerPath(target.webSocketDebuggerUrl));
  const session: Session = {
    info: {
      id: sessionId,
      label: request.label ?? target.title,
      host,
      port,
      status: 'connecting',
      ...(request.processId === undefined ? {} : { processId: request.processId }),
    },
    client,
    requested: new Map(),
    resolved: new Map(),
    frames: [],
    frameIds: new Map(),
    scopeChains: new Map(),
    heap: [],
    heapTimer: null,
  };
  sessions.set(sessionId, session);
  publish(session, 'connecting');

  try {
    await client.connect();
  } catch (cause) {
    sessions.delete(sessionId);
    const detail = cause instanceof Error ? cause.message : String(cause);
    publish(session, 'failed', { detail });
    failure('E_NETWORK', `No se pudo conectar con el inspector de ${host}:${port}.`, detail);
  }

  client.onEvent((event) => handleCdpEvent(session, event.method, event.params));
  client.onClose((reason) => {
    stopHeapSampling(session);
    sessions.delete(sessionId);
    publish(session, 'detached', { detail: reason });
  });

  // `Debugger.enable` debe preceder a cualquier punto de interrupcion, y
  // `Runtime.runIfWaitingForDebugger` es lo que libera un `--inspect-brk`.
  await client.send('Runtime.enable');
  await client.send('Debugger.enable');
  await client.send('Runtime.runIfWaitingForDebugger');

  publish(session, 'attached', { attachedAt: Date.now() });
  console_(session, 'info', `Conectado al inspector de ${host}:${port} (${target.title}).`);
  return session.info;
}

export async function detach(sessionId: string): Promise<true> {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    return true;
  }
  stopHeapSampling(session);
  sessions.delete(sessionId);
  session.client.close();
  publish(session, 'detached');
  return true;
}

export function listSessions(): readonly DebugSessionInfo[] {
  return [...sessions.values()].map((session) => session.info);
}

export async function discover(host: string, port: number) {
  if (!isLoopbackHost(host)) {
    failure('E_PERMISSION', 'Solo se puede sondear el bucle local.');
  }
  try {
    return await discoverTargets(host, port);
  } catch (cause) {
    failure(
      'E_NETWORK',
      `No hay ningun inspector escuchando en ${host}:${port}.`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

function requireSession(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    failure('E_NOT_FOUND', `No hay ninguna sesion de depuracion "${sessionId}".`);
  }
  return session;
}

/* -------------------------------------------------------------------------- */
/*  Eventos del motor                                                          */
/* -------------------------------------------------------------------------- */

function handleCdpEvent(
  session: Session,
  method: string,
  params: Readonly<Record<string, unknown>>,
): void {
  switch (method) {
    case 'Debugger.paused':
      handlePaused(session, params);
      break;

    case 'Debugger.resumed':
      // Los `objectId` caducan al reanudar: conservarlos invitaria a la
      // vista a expandir referencias que el motor ya libero.
      session.frames = [];
      session.frameIds.clear();
      session.scopeChains.clear();
      publish(session, 'attached');
      emit({ type: 'debug/resumed', payload: { sessionId: session.info.id } });
      break;

    case 'Runtime.consoleAPICalled':
      handleConsole(session, params);
      break;

    case 'Runtime.exceptionThrown': {
      const details = params['exceptionDetails'];
      const text =
        typeof details === 'object' && details !== null
          ? String((details as Record<string, unknown>)['text'] ?? 'Excepcion no capturada.')
          : 'Excepcion no capturada.';
      console_(session, 'error', text);
      break;
    }

    default:
      // El CDP emite muchisimos eventos; solo interesan los de arriba.
      break;
  }
}

function handlePaused(session: Session, params: Readonly<Record<string, unknown>>): void {
  const root = getRootOrNull();
  const rawFrames = Array.isArray(params['callFrames']) ? params['callFrames'] : [];
  const frames: DebugCallFrameView[] = [];
  session.frameIds.clear();
  session.scopeChains.clear();

  rawFrames.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const frame = raw as Record<string, unknown>;
    const location = (frame['location'] ?? {}) as Record<string, unknown>;
    const url = typeof frame['url'] === 'string' ? frame['url'] : '';
    const relative = root === null ? null : scriptUrlToWorkspaceRelative(root, url);

    // El renderer recibe un id propio y estable; el `callFrameId` real no
    // sale del proceso principal, igual que no salen los `objectId` crudos.
    const id = `frame-${index}`;
    const callFrameId = frame['callFrameId'];
    if (typeof callFrameId === 'string') {
      session.frameIds.set(id, callFrameId);
    }
    // La cadena de ambitos SOLO viaja con este evento. Si no se guarda
    // ahora, expandir las variables obligaria a volver a pausar.
    session.scopeChains.set(id, readScopeChain(frame['scopeChain']));

    frames.push({
      id,
      functionName:
        typeof frame['functionName'] === 'string' && frame['functionName'] !== ''
          ? frame['functionName']
          : '(anonima)',
      url: frameLabel(url, relative),
      path: relative,
      // El CDP cuenta lineas desde 0; el editor, desde 1.
      line: Number(location['lineNumber'] ?? 0) + 1,
      column: Number(location['columnNumber'] ?? 0) + 1,
      inWorkspace: relative !== null,
    });
  });

  session.frames = frames;
  const reason = typeof params['reason'] === 'string' ? params['reason'] : 'other';
  const hitBreakpoints = Array.isArray(params['hitBreakpoints'])
    ? params['hitBreakpoints'].filter((entry): entry is string => typeof entry === 'string')
    : [];

  publish(session, 'paused', { pauseReason: reason });
  emit({
    type: 'debug/paused',
    payload: { sessionId: session.info.id, reason, frames, hitBreakpoints },
  });
}

/**
 * Extrae la cadena de ambitos de un marco.
 *
 * Se descarta el ambito global: son miles de propiedades que nadie mira y
 * que harian inservible el arbol de variables.
 */
export function readScopeChain(raw: unknown): readonly ScopeRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const chain: ScopeRef[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const scope = entry as Record<string, unknown>;
    const type = typeof scope['type'] === 'string' ? scope['type'] : 'other';
    if (type === 'global') {
      continue;
    }
    const object = (scope['object'] ?? {}) as Record<string, unknown>;
    const objectId = typeof object['objectId'] === 'string' ? object['objectId'] : undefined;
    const name = typeof scope['name'] === 'string' ? scope['name'] : undefined;
    chain.push({
      type,
      ...(name === undefined ? {} : { name }),
      ...(objectId === undefined ? {} : { objectId }),
    });
  }
  return chain;
}

const CONSOLE_LEVELS: Readonly<Record<string, LogLevel>> = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  warning: 'warn',
  error: 'error',
  trace: 'trace',
};

function handleConsole(session: Session, params: Readonly<Record<string, unknown>>): void {
  const args = Array.isArray(params['args']) ? params['args'] : [];
  const text = args.map((arg) => describeRemoteObject(arg)).join(' ');
  const type = typeof params['type'] === 'string' ? params['type'] : 'log';
  console_(session, CONSOLE_LEVELS[type] ?? 'info', text);
}

/** Raiz del workspace sin lanzar: durante el apagado puede no haber ninguna. */
function getRootOrNull(): string | null {
  try {
    return requireWorkspaceRoot();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Puntos de interrupcion                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fija el juego completo de puntos de un archivo.
 *
 * Se reemplaza en bloque en lugar de anadir y quitar uno a uno: el margen de
 * Monaco emite el estado final del archivo, y sincronizar diferencias
 * dejaria puntos huerfanos en cuanto se perdiera un evento.
 */
export async function setBreakpoints(
  sessionId: string,
  relativePath: string,
  points: readonly SourceBreakpoint[],
): Promise<readonly BreakpointState[]> {
  const session = requireSession(sessionId);
  const root = requireWorkspaceRoot();
  // Aunque la ruta venga del propio editor, pasa por el guardian: es la
  // unica frontera que garantiza que no se salga del workspace.
  const guarded = assertInsideWorkspace(root, relativePath);
  const url = workspaceRelativeToScriptUrl(root, guarded.relative);

  const previous = session.resolved.get(guarded.relative);
  if (previous !== undefined) {
    for (const breakpointId of previous.values()) {
      try {
        await session.client.send('Debugger.removeBreakpoint', { breakpointId });
      } catch {
        // Si el script se descargo, el motor ya lo olvido; da igual.
      }
    }
  }

  const resolved = new Map<number, string>();
  const accepted: SourceBreakpoint[] = [];

  for (const point of points) {
    const line = Number(point.line);
    if (!Number.isInteger(line) || line < 1) {
      continue;
    }
    accepted.push(point);
    try {
      const result = await session.client.send('Debugger.setBreakpointByUrl', {
        url,
        lineNumber: line - 1,
        ...(point.condition === undefined || point.condition === ''
          ? {}
          : { condition: point.condition }),
      });
      const breakpointId = result['breakpointId'];
      if (typeof breakpointId === 'string') {
        resolved.set(line, breakpointId);
      }
    } catch (cause) {
      // Un punto rechazado no invalida los demas: se deja sin verificar y
      // el margen lo pinta hueco.
      console_(
        session,
        'warn',
        `No se pudo fijar el punto en ${guarded.relative}:${line}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  if (accepted.length === 0) {
    session.requested.delete(guarded.relative);
    session.resolved.delete(guarded.relative);
  } else {
    session.requested.set(guarded.relative, accepted);
    session.resolved.set(guarded.relative, resolved);
  }

  publishBreakpoints(session);
  return accepted.map((point) => ({
    path: guarded.relative,
    line: point.line,
    verified: resolved.has(point.line),
    ...(point.condition === undefined ? {} : { condition: point.condition }),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Control de ejecucion                                                       */
/* -------------------------------------------------------------------------- */

export async function resume(sessionId: string): Promise<true> {
  const session = requireSession(sessionId);
  await session.client.send('Debugger.resume');
  return true;
}

export async function pause(sessionId: string): Promise<true> {
  const session = requireSession(sessionId);
  await session.client.send('Debugger.pause');
  return true;
}

const STEP_METHODS: Readonly<Record<DebugStepKind, string>> = {
  over: 'Debugger.stepOver',
  into: 'Debugger.stepInto',
  out: 'Debugger.stepOut',
};

export async function step(sessionId: string, kind: DebugStepKind): Promise<true> {
  const session = requireSession(sessionId);
  const method = STEP_METHODS[kind];
  if (method === undefined) {
    failure('E_INVALID_ARGUMENT', `Paso de depuracion desconocido: ${String(kind)}.`);
  }
  await session.client.send(method);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Inspeccion                                                                 */
/* -------------------------------------------------------------------------- */

export async function evaluate(
  sessionId: string,
  expression: string,
  frameId?: string,
): Promise<DebugEvaluateResult> {
  const session = requireSession(sessionId);
  if (typeof expression !== 'string' || expression.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'La expresion a evaluar esta vacia.');
  }

  const callFrameId = frameId === undefined ? undefined : session.frameIds.get(frameId);
  const result =
    callFrameId === undefined
      ? await session.client.send('Runtime.evaluate', {
          expression,
          returnByValue: false,
          // La consola de depuracion es interactiva: `await` debe funcionar.
          awaitPromise: true,
          // `$0`, `copy()` y demas ayudas del inspector.
          includeCommandLineAPI: true,
        })
      : await session.client.send('Debugger.evaluateOnCallFrame', {
          callFrameId,
          expression,
          returnByValue: false,
          includeCommandLineAPI: true,
        });

  const details = result['exceptionDetails'];
  if (typeof details === 'object' && details !== null) {
    const record = details as Record<string, unknown>;
    const exception = record['exception'];
    return {
      value:
        exception === undefined
          ? String(record['text'] ?? 'La expresion lanzo una excepcion.')
          : describeRemoteObject(exception),
      type: 'error',
      expandable: false,
      thrown: true,
    };
  }

  const view = toVariable('resultado', result['result']);
  return {
    value: view.value,
    type: view.type,
    ...(view.objectId === undefined ? {} : { objectId: view.objectId }),
    expandable: view.expandable,
    thrown: false,
  };
}

/**
 * Ambitos del marco, ya con sus variables resueltas.
 *
 * La cadena se capturo en la pausa; aqui solo se piden las propiedades de
 * cada objeto de ambito. Si el motor ya reanudo, las referencias han
 * caducado y se informa en lugar de devolver un arbol vacio y silencioso.
 */
export async function scopes(sessionId: string, frameId: string): Promise<readonly DebugScopeView[]> {
  const session = requireSession(sessionId);
  const chain = session.scopeChains.get(frameId);
  if (chain === undefined) {
    failure('E_NOT_FOUND', 'El marco pedido ya no existe: la ejecucion continuo.');
  }

  const views: DebugScopeView[] = [];
  for (const scope of chain) {
    const objectId = scope.objectId;
    const variables = objectId === undefined ? [] : await properties(sessionId, objectId);
    views.push({
      type: scope.type,
      ...(scope.name === undefined ? {} : { name: scope.name }),
      ...(objectId === undefined ? {} : { objectId }),
      variables,
    });
  }
  return views;
}

/** Propiedades propias de un objeto remoto, para expandir en el arbol. */
export async function properties(
  sessionId: string,
  objectId: string,
): Promise<readonly DebugVariableView[]> {
  const session = requireSession(sessionId);
  if (typeof objectId !== 'string' || objectId === '') {
    failure('E_INVALID_ARGUMENT', 'Referencia de objeto vacia.');
  }

  const result = await session.client.send('Runtime.getProperties', {
    objectId,
    ownProperties: true,
    // Sin esto llega la cadena de prototipos entera y la vista se ahoga.
    accessorPropertiesOnly: false,
    generatePreview: false,
  });

  const raw = Array.isArray(result['result']) ? result['result'] : [];
  const views: DebugVariableView[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    if (name === '') {
      continue;
    }
    views.push(toVariable(name, record['value']));
    if (views.length >= MAX_VARIABLES_PER_SCOPE) {
      break;
    }
  }
  return views;
}

/* -------------------------------------------------------------------------- */
/*  Perfilado de memoria                                                       */
/* -------------------------------------------------------------------------- */

export function setHeapSubscription(sessionId: string, enabled: boolean): true {
  const session = requireSession(sessionId);
  if (!enabled) {
    stopHeapSampling(session);
    return true;
  }
  if (session.heapTimer !== null) {
    return true;
  }
  const timer = setInterval(() => {
    void sampleHeap(session);
  }, HEAP_INTERVAL_MS);
  timer.unref();
  session.heapTimer = timer;
  // Primera muestra inmediata: la grafica no debe tardar 2 s en aparecer.
  void sampleHeap(session);
  return true;
}

function stopHeapSampling(session: Session): void {
  if (session.heapTimer !== null) {
    clearInterval(session.heapTimer);
    session.heapTimer = null;
  }
}

async function sampleHeap(session: Session): Promise<void> {
  if (!session.client.connected) {
    stopHeapSampling(session);
    return;
  }
  try {
    // `Runtime.getHeapUsage` es barato: no fuerza recoleccion ni pausa el
    // proceso, a diferencia de tomar una instantanea del monton.
    const result = await session.client.send('Runtime.getHeapUsage', {}, 4000);
    const used = Number(result['usedSize'] ?? 0);
    const total = Number(result['totalSize'] ?? 0);
    const sample: HeapSample = {
      sessionId: session.info.id,
      time: Date.now(),
      usedHeapMb: Number((used / (1024 * 1024)).toFixed(2)),
      totalHeapMb: Number((total / (1024 * 1024)).toFixed(2)),
    };
    session.heap.push(sample);
    if (session.heap.length > MAX_HEAP_SAMPLES) {
      session.heap.splice(0, session.heap.length - MAX_HEAP_SAMPLES);
    }
    emit({ type: 'debug/heap', payload: sample });
  } catch {
    // Un fallo puntual del sondeo no debe tumbar la sesion: la siguiente
    // muestra lo intenta de nuevo, y si el socket murio, `connected` lo dice.
  }
}

export function heapTrend(sessionId: string): HeapTrend {
  const session = requireSession(sessionId);
  const samples = [...session.heap];
  return {
    sessionId,
    samples,
    slopeMbPerMinute: samples.length >= MIN_SAMPLES_FOR_TREND ? heapSlopeMbPerMinute(samples) : 0,
    leakSuspected: isLeakSuspected(samples),
  };
}

/** Fuerza una recoleccion para distinguir un pico de una fuga real. */
export async function collectGarbage(sessionId: string): Promise<true> {
  const session = requireSession(sessionId);
  await session.client.send('HeapProfiler.collectGarbage');
  return true;
}

/** Cierra todas las sesiones al apagar la aplicacion. */
export function disposeAllSessions(): void {
  for (const session of sessions.values()) {
    stopHeapSampling(session);
    session.client.close();
  }
  sessions.clear();
}
