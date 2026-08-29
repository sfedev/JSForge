/**
 * Vista de depuracion: sesiones, pila de llamadas, variables y consola.
 *
 * La vista no habla CDP: solo lee el store y llama a `window.forge.debug`.
 * Todo lo que se pinta viene de eventos que ya tradujo el proceso principal.
 *
 * El grafico de heap se dibuja con un `<canvas>` y una polilinea: una
 * grafica de 300 puntos que se repinta cada 2 s no justifica una libreria,
 * y mantenerla en canvas evita crear cientos de nodos por muestra.
 */

import { h, svgIcon, formatClock } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { confirmDialog, promptDialog, selectDialog } from '../core/dialogs.js';
import { defineCommands, runCommand } from '../core/commands.js';
import {
  breakpointsFor,
  store,
  type ForgeState,
} from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import { registerPanelView, type PanelViewContext } from './panel.js';
import { clearStoppedLine, onBreakpointsChanged, showStoppedLine } from '../editor/breakpoints.js';
import { openFile } from './editor-area.js';
import type {
  DebugCallFrameView,
  DebugPauseEvent,
  DebugScopeView,
  HeapSample,
  SourceBreakpoint,
} from '../../shared/contracts.js';

/** Puerto por defecto del inspector de Node. */
const DEFAULT_INSPECTOR_PORT = 9229;

/** Alto del grafico de heap, en pixeles CSS. */
const CHART_HEIGHT = 96;

let sessionCounter = 0;

/* -------------------------------------------------------------------------- */
/*  Acciones                                                                   */
/* -------------------------------------------------------------------------- */

function activeSessionId(): string | null {
  return store.state.activeDebugSession;
}

/** Empuja el juego de puntos de un archivo a todas las sesiones vivas. */
async function pushBreakpoints(path: string, points: readonly { line: number; condition?: string }[]): Promise<void> {
  const payload: SourceBreakpoint[] = points.map((point) => ({
    line: point.line,
    ...(point.condition === undefined ? {} : { condition: point.condition }),
  }));
  for (const session of store.state.debugSessions) {
    const result = await window.forge.debug.setBreakpoints(session.id, path, payload);
    if (!result.ok) {
      toastError('No se pudieron sincronizar los puntos de interrupcion.', result.error);
    }
  }
}

/** Reenvia todos los puntos conocidos: se usa al abrir una sesion nueva. */
async function pushAllBreakpoints(sessionId: string): Promise<void> {
  for (const [path, points] of store.state.breakpoints) {
    const payload: SourceBreakpoint[] = points.map((point) => ({
      line: point.line,
      ...(point.condition === undefined ? {} : { condition: point.condition }),
    }));
    const result = await window.forge.debug.setBreakpoints(sessionId, path, payload);
    if (!result.ok) {
      toastError(`No se pudieron fijar los puntos de ${path}.`, result.error);
    }
  }
}

async function attachToPort(port: number, label?: string, processId?: string): Promise<void> {
  sessionCounter += 1;
  const sessionId = `debug-${sessionCounter}`;
  const result = await window.forge.debug.attach({
    sessionId,
    port,
    host: '127.0.0.1',
    ...(label === undefined ? {} : { label }),
    ...(processId === undefined ? {} : { processId }),
  });
  if (!result.ok) {
    toastError('No se pudo conectar con el inspector.', result.error);
    return;
  }
  store.patch({ activeDebugSession: sessionId });
  await pushAllBreakpoints(sessionId);
  await window.forge.debug.subscribeHeap(sessionId, true);
  toast('info', `Depurador conectado en el puerto ${port}.`);
}

/* -------------------------------------------------------------------------- */
/*  Barra lateral                                                              */
/* -------------------------------------------------------------------------- */

function buildSidebar(context: SidebarViewContext): void {
  const sessionList = h('div', { class: 'list' });
  const stackList = h('div', { class: 'list' });
  const scopeList = h('div', { class: 'list' });
  const breakpointList = h('div', { class: 'list' });

  const attachButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Conectar a un inspector',
    'aria-label': 'Conectar a un inspector',
  });
  attachButton.appendChild(svgIcon(ICONS.plus, 13));
  attachButton.addEventListener('click', () => void runCommand('debug.attach'));
  context.actions.appendChild(attachButton);

  const section = (title: string, body: HTMLElement): HTMLElement =>
    h('div', { class: 'section' }, h('div', { class: 'section__header' }, title), h('div', { class: 'section__body' }, body));

  context.container.replaceChildren(
    section('Sesiones', sessionList),
    section('Pila de llamadas', stackList),
    section('Variables', scopeList),
    section('Puntos de interrupcion', breakpointList),
  );

  /* --- Sesiones --- */
  function renderSessions(state: ForgeState): void {
    if (state.debugSessions.length === 0) {
      sessionList.replaceChildren(
        h(
          'div',
          { class: 'empty-note' },
          'Ninguna sesion activa. Arranca el proceso con --inspect y conecta.',
        ),
      );
      return;
    }

    sessionList.replaceChildren(
      ...state.debugSessions.map((session) => {
        const row = h('div', {
          class: 'list-row',
          'data-active': String(session.id === state.activeDebugSession),
          title: `${session.host}:${session.port}`,
        });
        row.append(
          svgIcon(session.status === 'paused' ? ICONS.stop : ICONS.run, 13),
          h('span', { class: 'list-row__label' }, session.label),
          h(
            'span',
            { class: 'list-row__hint' },
            session.status === 'paused'
              ? `en pausa (${session.pauseReason ?? 'punto'})`
              : session.status,
          ),
        );
        row.addEventListener('click', () => store.patch({ activeDebugSession: session.id }));

        const detach = h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Desconectar',
          'aria-label': 'Desconectar',
        });
        detach.appendChild(svgIcon(ICONS.close, 11));
        detach.addEventListener('click', (event) => {
          event.stopPropagation();
          void window.forge.debug.detach(session.id);
        });
        row.appendChild(detach);
        return row;
      }),
    );
  }

  /* --- Pila --- */
  function renderStack(state: ForgeState): void {
    if (state.debugFrames.length === 0) {
      stackList.replaceChildren(
        h('div', { class: 'empty-note' }, 'La ejecucion no esta detenida.'),
      );
      return;
    }

    stackList.replaceChildren(
      ...state.debugFrames.map((frame) => {
        const row = h('div', {
          class: 'list-row',
          'data-active': String(frame.id === state.activeDebugFrame),
          title: frame.url,
        });
        row.append(
          h('span', { class: 'list-row__label' }, frame.functionName),
          h('span', { class: 'list-row__hint' }, `${frame.url}:${frame.line}`),
        );
        // Los marcos internos de Node no tienen archivo que abrir.
        row.style.opacity = frame.inWorkspace ? '' : '0.55';
        row.addEventListener('click', () => void selectFrame(frame));
        return row;
      }),
    );
  }

  async function selectFrame(frame: DebugCallFrameView): Promise<void> {
    store.patch({ activeDebugFrame: frame.id });
    if (frame.path !== null) {
      await openFile(frame.path, frame.line);
      showStoppedLine(frame.path, frame.line);
    }
    await renderScopes(frame.id);
  }

  /* --- Variables --- */
  async function renderScopes(frameId: string | null): Promise<void> {
    const sessionId = activeSessionId();
    if (sessionId === null || frameId === null) {
      scopeList.replaceChildren(h('div', { class: 'empty-note' }, 'Sin marco seleccionado.'));
      return;
    }
    const result = await window.forge.debug.scopes(sessionId, frameId);
    if (!result.ok) {
      scopeList.replaceChildren(h('div', { class: 'empty-note' }, result.error.message));
      return;
    }
    scopeList.replaceChildren(...result.value.map((scope) => scopeNode(sessionId, scope)));
  }

  function scopeNode(sessionId: string, scope: DebugScopeView): HTMLElement {
    const label = scope.name === undefined ? scope.type : `${scope.type}: ${scope.name}`;
    const children = h('div', { style: 'padding-left:12px' });
    for (const variable of scope.variables) {
      children.appendChild(variableNode(sessionId, variable));
    }
    return h(
      'details',
      { open: scope.type === 'local' ? '' : null },
      h('summary', { class: 'list-row__label' }, label),
      children,
    );
  }

  function variableNode(
    sessionId: string,
    variable: { name: string; value: string; type: string; objectId?: string; expandable: boolean },
  ): HTMLElement {
    const row = h(
      'div',
      { class: 'list-row', title: variable.type },
      h('span', { class: 'list-row__label' }, variable.name),
      h('span', { class: 'list-row__hint' }, variable.value),
    );
    if (!variable.expandable || variable.objectId === undefined) {
      return row;
    }

    const objectId = variable.objectId;
    const children = h('div', { style: 'padding-left:12px' });
    let loaded = false;
    const details = h('details', {}, h('summary', {}, row), children);
    details.addEventListener('toggle', () => {
      if (!details.open || loaded) {
        return;
      }
      loaded = true;
      void window.forge.debug.properties(sessionId, objectId).then((result) => {
        if (!result.ok) {
          children.replaceChildren(h('div', { class: 'empty-note' }, result.error.message));
          return;
        }
        children.replaceChildren(
          ...result.value.map((child) => variableNode(sessionId, child)),
        );
      });
    });
    return details;
  }

  /* --- Puntos --- */
  function renderBreakpoints(state: ForgeState): void {
    const all = [...state.breakpoints.values()].flat();
    if (all.length === 0) {
      breakpointList.replaceChildren(
        h('div', { class: 'empty-note' }, 'Pulsa el margen izquierdo del editor para anadir uno.'),
      );
      return;
    }

    breakpointList.replaceChildren(
      ...all.map((point) => {
        const row = h('div', { class: 'list-row', title: point.verified ? 'Verificado' : 'Sin verificar' });
        row.append(
          h('span', { class: 'list-row__label' }, `${point.path}:${point.line}`),
          h(
            'span',
            { class: 'list-row__hint' },
            point.condition === undefined ? (point.verified ? '' : 'sin verificar') : point.condition,
          ),
        );
        row.addEventListener('click', () => void openFile(point.path, point.line));
        return row;
      }),
    );
  }

  const render = (): void => {
    const state = store.state;
    renderSessions(state);
    renderStack(state);
    renderBreakpoints(state);
  };

  store.subscribe(
    ['debugSessions', 'activeDebugSession', 'debugFrames', 'activeDebugFrame', 'breakpoints'],
    render,
  );
  render();

  // Al detenerse, la vista carga sola las variables del marco superior.
  store.subscribe(['activeDebugFrame'], () => {
    void renderScopes(store.state.activeDebugFrame);
  });
}

/* -------------------------------------------------------------------------- */
/*  Panel inferior: consola y grafico de heap                                  */
/* -------------------------------------------------------------------------- */

function buildPanel(context: PanelViewContext): void {
  const output = h('div', { class: 'logview', style: 'flex:1;overflow:auto' });
  const canvas = h('canvas', {
    style: `width:100%;height:${CHART_HEIGHT}px;display:block`,
    'aria-label': 'Consumo de heap del proceso depurado',
  }) as HTMLCanvasElement;
  const trendLabel = h('span', { class: 'list-row__hint' }, 'Sin muestras.');

  const input = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Evaluar expresion en el marco actual…',
    'aria-label': 'Expresion a evaluar',
  }) as HTMLInputElement;

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }
    const expression = input.value.trim();
    if (expression === '') {
      return;
    }
    input.value = '';
    void evaluateExpression(expression);
  });

  context.container.replaceChildren(
    h(
      'div',
      { style: 'display:flex;flex-direction:column;height:100%;gap:6px' },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:8px;padding:4px 8px 0' },
        h('span', { class: 'section__header' }, 'Memoria'),
        trendLabel,
      ),
      canvas,
      output,
      h('div', { style: 'padding:4px 8px 8px' }, input),
    ),
  );

  const gc = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Forzar recoleccion de basura',
    'aria-label': 'Forzar recoleccion de basura',
  });
  gc.appendChild(svgIcon(ICONS.refresh, 13));
  gc.addEventListener('click', () => void runCommand('debug.collectGarbage'));
  context.actions.appendChild(gc);

  async function evaluateExpression(expression: string): Promise<void> {
    const sessionId = activeSessionId();
    if (sessionId === null) {
      toast('warn', 'No hay ninguna sesion de depuracion activa.');
      return;
    }
    const frameId = store.state.activeDebugFrame;
    const result = await window.forge.debug.evaluate({
      sessionId,
      expression,
      ...(frameId === null ? {} : { callFrameId: frameId }),
    });
    appendLine('info', `› ${expression}`);
    if (!result.ok) {
      appendLine('error', result.error.message);
      return;
    }
    appendLine(result.value.thrown ? 'error' : 'info', result.value.value);
  }

  function appendLine(level: string, text: string): void {
    const row = h(
      'div',
      { class: 'logline', 'data-level': level },
      h('span', { class: 'logline__time' }, formatClock(Date.now())),
      h('span', { class: 'logline__message' }, text),
    );
    output.appendChild(row);
    output.scrollTop = output.scrollHeight;
  }

  /* --- Consola --- */
  let renderedConsole = 0;
  store.subscribe(['debugConsole'], () => {
    const entries = store.state.debugConsole;
    // Solo se pintan las lineas nuevas: repintar 2000 nodos por evento
    // convertiria la consola en el cuello de botella del panel.
    for (const entry of entries.slice(renderedConsole)) {
      appendLine(entry.level, entry.text);
    }
    renderedConsole = entries.length;
  });

  /* --- Grafico --- */
  const drawChart = (): void => {
    const sessionId = activeSessionId();
    const samples = sessionId === null ? [] : (store.state.heapSamples.get(sessionId) ?? []);
    drawHeapChart(canvas, samples);
    trendLabel.textContent = describeTrend(samples);
  };
  store.subscribe(['heapSamples', 'activeDebugSession'], drawChart);
  window.addEventListener('resize', drawChart);
  drawChart();
}

/**
 * Describe la tendencia sin pedirla al proceso principal.
 *
 * El calculo de la pendiente vive en el main (es quien tiene la serie
 * completa), pero para la etiqueta basta con los extremos de la ventana que
 * ya esta en el store: evita una llamada IPC cada dos segundos.
 */
export function describeTrend(samples: readonly HeapSample[]): string {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined || samples.length < 2) {
    return 'Sin muestras suficientes.';
  }
  const minutes = (last.time - first.time) / 60_000;
  const delta = last.usedHeapMb - first.usedHeapMb;
  const slope = minutes > 0 ? delta / minutes : 0;
  const sign = slope >= 0 ? '+' : '';
  return `${last.usedHeapMb.toFixed(1)} MB usados · ${sign}${slope.toFixed(1)} MB/min`;
}

/**
 * Dibuja la serie como polilinea sobre el canvas.
 *
 * El eje Y arranca en cero a proposito: escalarlo al minimo de la ventana
 * haria que cualquier oscilacion pareciera una fuga.
 */
export function drawHeapChart(canvas: HTMLCanvasElement, samples: readonly HeapSample[]): void {
  const context = canvas.getContext('2d');
  if (context === null) {
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = CHART_HEIGHT;
  // El canvas se dimensiona en pixeles fisicos y se escala: si no, la linea
  // sale borrosa en pantallas con densidad alta.
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  if (samples.length < 2) {
    return;
  }

  const styles = getComputedStyle(document.documentElement);
  const stroke = styles.getPropertyValue('--accent-400').trim() || '#8f6bff';
  const maximum = Math.max(...samples.map((sample) => sample.usedHeapMb), 1);
  const step = width / (samples.length - 1);

  context.beginPath();
  samples.forEach((sample, index) => {
    const x = index * step;
    const y = height - (sample.usedHeapMb / maximum) * (height - 4) - 2;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.strokeStyle = stroke;
  context.lineWidth = 1.5;
  context.stroke();

  // Relleno tenue bajo la curva: ayuda a leer la tendencia de un vistazo.
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  context.globalAlpha = 0.12;
  context.fillStyle = stroke;
  context.fill();
  context.globalAlpha = 1;
}

/* -------------------------------------------------------------------------- */
/*  Registro                                                                   */
/* -------------------------------------------------------------------------- */

export function registerDebugView(): void {
  registerSidebarView('debug', buildSidebar);
  registerPanelView('debug', buildPanel);

  // El margen del editor avisa; la vista lo propaga a las sesiones vivas.
  onBreakpointsChanged((path, points) => {
    void pushBreakpoints(path, points);
  });

  defineCommands([
    {
      id: 'debug.attach',
      title: 'Depurar: conectar a un inspector',
      category: 'Depuracion',
      run: async () => {
        const port = await promptDialog({
          title: 'Conectar al inspector de Node',
          label: 'Puerto',
          value: String(DEFAULT_INSPECTOR_PORT),
          detail: 'El proceso debe haberse arrancado con --inspect o --inspect-brk.',
          validate: (value) => {
            const parsed = Number(value);
            return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
              ? null
              : 'Introduce un puerto entre 1 y 65535.';
          },
        });
        if (port === null) {
          return;
        }
        await attachToPort(Number(port));
      },
    },
    {
      id: 'debug.attachToProcess',
      title: 'Depurar: conectar a un proceso en ejecucion',
      category: 'Depuracion',
      enabled: () => store.state.processes.length > 0,
      run: async () => {
        const running = store.state.processes.filter(
          (info) => info.status === 'running' || info.status === 'ready',
        );
        if (running.length === 0) {
          toast('info', 'No hay procesos en ejecucion que depurar.');
          return;
        }
        const choice = await selectDialog({
          title: 'Elige el proceso a depurar',
          items: running.map((info) => ({
            id: info.id,
            label: info.label,
            hint: `${info.command} ${info.args.join(' ')}`,
          })),
        });
        if (choice === null) {
          return;
        }
        const selected = running.find((info) => info.id === choice);
        await attachToPort(DEFAULT_INSPECTOR_PORT, selected?.label, choice);
      },
    },
    {
      id: 'debug.disconnect',
      title: 'Depurar: desconectar',
      category: 'Depuracion',
      enabled: () => activeSessionId() !== null,
      run: async () => {
        const sessionId = activeSessionId();
        if (sessionId === null) {
          return;
        }
        await window.forge.debug.detach(sessionId);
        clearStoppedLine();
      },
    },
    {
      id: 'debug.continue',
      title: 'Depurar: continuar',
      category: 'Depuracion',
      keybinding: 'F5',
      enabled: () => activeSessionId() !== null,
      run: () => withSession((sessionId) => window.forge.debug.resume(sessionId)),
    },
    {
      id: 'debug.pause',
      title: 'Depurar: pausar',
      category: 'Depuracion',
      enabled: () => activeSessionId() !== null,
      run: () => withSession((sessionId) => window.forge.debug.pause(sessionId)),
    },
    {
      id: 'debug.stepOver',
      title: 'Depurar: paso a paso por encima',
      category: 'Depuracion',
      keybinding: 'F10',
      enabled: () => activeSessionId() !== null,
      run: () => withSession((sessionId) => window.forge.debug.step(sessionId, 'over')),
    },
    {
      id: 'debug.stepInto',
      title: 'Depurar: entrar en la funcion',
      category: 'Depuracion',
      keybinding: 'F11',
      enabled: () => activeSessionId() !== null,
      run: () => withSession((sessionId) => window.forge.debug.step(sessionId, 'into')),
    },
    {
      id: 'debug.stepOut',
      title: 'Depurar: salir de la funcion',
      category: 'Depuracion',
      keybinding: 'Shift+F11',
      enabled: () => activeSessionId() !== null,
      run: () => withSession((sessionId) => window.forge.debug.step(sessionId, 'out')),
    },
    {
      id: 'debug.collectGarbage',
      title: 'Depurar: forzar recoleccion de basura',
      category: 'Depuracion',
      enabled: () => activeSessionId() !== null,
      run: () => withSession((sessionId) => window.forge.debug.collectGarbage(sessionId)),
    },
    {
      id: 'debug.clearBreakpoints',
      title: 'Depurar: quitar todos los puntos de interrupcion',
      category: 'Depuracion',
      enabled: () => store.state.breakpoints.size > 0,
      run: async () => {
        const total = [...store.state.breakpoints.values()].reduce(
          (sum, points) => sum + points.length,
          0,
        );
        const confirmed = await confirmDialog({
          title: 'Quitar los puntos de interrupcion',
          message: `Se eliminaran ${total} puntos de interrupcion.`,
          confirmLabel: 'Quitar',
          danger: true,
        });
        if (!confirmed) {
          return;
        }
        const paths = [...store.state.breakpoints.keys()];
        store.mutate(['breakpoints'], (state) => state.breakpoints.clear());
        for (const path of paths) {
          await pushBreakpoints(path, []);
        }
      },
    },
    {
      id: 'debug.toggleBreakpoint',
      title: 'Depurar: alternar punto de interrupcion',
      category: 'Depuracion',
      keybinding: 'F9',
      enabled: () => store.state.activeDocument !== null,
      run: () => {
        // El margen es la via normal; este comando cubre el atajo de teclado
        // y lo delega en la misma logica para no duplicar estado.
        void runCommand('editor.toggleBreakpointAtCursor');
      },
    },
    {
      id: 'debug.handlePaused',
      title: 'Depurar: gestionar una pausa',
      category: 'Depuracion',
      run: async (argument) => {
        const event = argument as DebugPauseEvent | undefined;
        const frame = event?.frames.find((entry) => entry.inWorkspace);
        if (frame?.path == null) {
          return;
        }
        await openFile(frame.path, frame.line);
        showStoppedLine(frame.path, frame.line);
        store.patch({ panelView: 'debug', panelVisible: true, sidebarView: 'debug' });
      },
    },
    {
      id: 'debug.handleResumed',
      title: 'Depurar: gestionar una reanudacion',
      category: 'Depuracion',
      run: () => clearStoppedLine(),
    },
  ]);
}

/** Ejecuta una accion sobre la sesion activa, avisando si no hay ninguna. */
async function withSession(
  action: (sessionId: string) => Promise<{ ok: boolean; error?: { message: string } }>,
): Promise<void> {
  const sessionId = activeSessionId();
  if (sessionId === null) {
    toast('warn', 'No hay ninguna sesion de depuracion activa.');
    return;
  }
  const result = await action(sessionId);
  if (!result.ok && result.error !== undefined) {
    toast('error', result.error.message);
  }
}

/** Puntos del archivo activo; lo usa el comando del atajo de teclado. */
export function activeFileBreakpoints(): readonly { line: number }[] {
  const active = store.state.activeDocument;
  return active === null ? [] : breakpointsFor(active);
}
