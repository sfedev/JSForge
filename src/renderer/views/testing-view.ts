/**
 * Vista de pruebas: arbol de archivos, resultados y cobertura.
 *
 * La barra lateral lista los archivos de prueba con sus bloques; el panel
 * inferior muestra el arbol de la ultima ejecucion, con los tiempos y la
 * traza del error clicable hasta la linea exacta.
 *
 * Ninguna ejecucion bloquea la interfaz: se lanza y se espera al evento
 * `test/finished`, igual que hacen los procesos del gestor.
 */

import { h, svgIcon, formatDuration } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { selectDialog } from '../core/dialogs.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store, type ForgeState } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import { registerPanelView, type PanelViewContext } from './panel.js';
import { openFile } from './editor-area.js';
import { applyCoverage, applyTestResults, renderCoverage } from '../editor/test-lens.js';
import type {
  TestBlock,
  TestCaseResult,
  TestRunSummary,
  TestRunnerId,
} from '../../shared/contracts.js';

/** Puerto que se usa al depurar una prueba con el inspector. */
const DEBUG_INSPECT_PORT = 9229;

const STATUS_TONES: Readonly<Record<string, string>> = {
  passed: 'var(--state-success)',
  failed: 'var(--state-error)',
  skipped: 'var(--text-subtle)',
  running: 'var(--state-info)',
  pending: 'var(--text-subtle)',
};

const STATUS_MARKS: Readonly<Record<string, string>> = {
  passed: '✓',
  failed: '✗',
  skipped: '⊘',
  running: '…',
  pending: '·',
};

let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `run-${runCounter}`;
}

/* -------------------------------------------------------------------------- */
/*  Ejecucion                                                                  */
/* -------------------------------------------------------------------------- */

async function launch(options: {
  path?: string;
  testName?: string;
  coverage?: boolean;
  runner?: TestRunnerId;
}): Promise<void> {
  if (store.state.testRunning !== null) {
    toast('warn', 'Ya hay una ejecucion de pruebas en marcha.');
    return;
  }
  const result = await window.forge.testing.run({
    runId: nextRunId(),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.testName === undefined ? {} : { testName: options.testName }),
    ...(options.coverage === undefined ? {} : { coverage: options.coverage }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  if (!result.ok) {
    // `testRunning` lo limpia el evento `test/finished`, que aqui no llega.
    store.patch({ testRunning: null });
    toastError('La ejecucion de pruebas fallo.', result.error);
    return;
  }
}

/* -------------------------------------------------------------------------- */
/*  Barra lateral                                                              */
/* -------------------------------------------------------------------------- */

function buildSidebar(context: SidebarViewContext): void {
  const summaryLine = h('div', { class: 'empty-note' }, 'Buscando archivos de prueba…');
  const fileList = h('div', { class: 'list' });

  const runAll = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Ejecutar todas las pruebas',
    'aria-label': 'Ejecutar todas las pruebas',
  });
  runAll.appendChild(svgIcon(ICONS.run, 13));
  runAll.addEventListener('click', () => void runCommand('testing.runAll'));

  const runCoverage = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Ejecutar con cobertura',
    'aria-label': 'Ejecutar con cobertura',
  });
  runCoverage.appendChild(svgIcon(ICONS.metrics, 13));
  runCoverage.addEventListener('click', () => void runCommand('testing.runWithCoverage'));

  const reload = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Volver a buscar archivos de prueba',
    'aria-label': 'Volver a buscar archivos de prueba',
  });
  reload.appendChild(svgIcon(ICONS.refresh, 13));
  reload.addEventListener('click', () => void load());

  context.actions.append(runAll, runCoverage, reload);
  context.container.replaceChildren(summaryLine, fileList);

  /** Resultado por ruta, para pintar el estado junto a cada archivo. */
  function fileStatus(state: ForgeState, path: string): string | null {
    const file = state.testRun?.files.find((entry) => entry.path === path);
    return file === undefined ? null : file.status;
  }

  async function load(): Promise<void> {
    const found = await window.forge.testing.discover();
    if (!found.ok) {
      summaryLine.textContent = found.error.message;
      return;
    }
    if (found.value.length === 0) {
      summaryLine.textContent = 'No se encontro ningun archivo *.test.ts ni *.spec.ts.';
      fileList.replaceChildren();
      return;
    }

    const runners = await window.forge.testing.runners();
    if (runners.ok) {
      store.patch({ testRunners: [...runners.value] });
    }
    renderFiles(found.value);
  }

  function renderFiles(paths: readonly string[]): void {
    const state = store.state;
    summaryLine.textContent = `${paths.length} archivos · ejecutor ${state.testRunners[0] ?? 'node'}`;

    fileList.replaceChildren(
      ...paths.map((path) => {
        const status = fileStatus(state, path);
        const children = h('div', { style: 'padding-left:10px' });
        let loaded = false;

        const label = h(
          'span',
          { class: 'list-row__label' },
          path.split('/').pop() ?? path,
        );
        const mark = h(
          'span',
          {
            class: 'list-row__hint',
            style: status === null ? '' : `color:${STATUS_TONES[status] ?? ''}`,
          },
          status === null ? '' : (STATUS_MARKS[status] ?? ''),
        );

        const summary = h('summary', { class: 'list-row', title: path }, mark, label);
        const details = h('details', {}, summary, children);

        // Los bloques se piden al desplegar: analizar 200 archivos al abrir
        // la vista costaria mas que abrir el IDE entero.
        details.addEventListener('toggle', () => {
          if (!details.open || loaded) {
            return;
          }
          loaded = true;
          void window.forge.testing.blocks(path).then((result) => {
            if (!result.ok) {
              children.replaceChildren(h('div', { class: 'empty-note' }, result.error.message));
              return;
            }
            children.replaceChildren(...result.value.map((block) => blockNode(block)));
            if (result.value.length === 0) {
              children.replaceChildren(
                h('div', { class: 'empty-note' }, 'Sin bloques reconocibles.'),
              );
            }
          });
        });

        summary.addEventListener('dblclick', () => void launch({ path }));
        return details;
      }),
    );
  }

  function blockNode(block: TestBlock): HTMLElement {
    const row = h(
      'div',
      { class: 'list-row', title: block.fullName },
      h(
        'span',
        { class: 'list-row__label' },
        block.modifier === 'skip' || block.modifier === 'todo'
          ? `${block.name} (${block.modifier})`
          : block.name,
      ),
    );
    row.addEventListener('click', () => void openFile(block.path, block.line));

    const play = h('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Ejecutar solo esta prueba',
      'aria-label': 'Ejecutar solo esta prueba',
    });
    play.appendChild(svgIcon(ICONS.run, 11));
    play.addEventListener('click', (event) => {
      event.stopPropagation();
      void launch({ path: block.path, testName: block.fullName });
    });
    row.appendChild(play);

    if (block.children.length === 0) {
      return row;
    }
    const children = h('div', { style: 'padding-left:10px' });
    for (const child of block.children) {
      children.appendChild(blockNode(child));
    }
    return h('details', { open: '' }, h('summary', {}, row), children);
  }

  store.subscribe(['testRun', 'testRunning'], () => void load());
  void load();
}

/* -------------------------------------------------------------------------- */
/*  Panel de resultados                                                        */
/* -------------------------------------------------------------------------- */

function buildPanel(context: PanelViewContext): void {
  const summaryLine = h('div', { class: 'empty-note' }, 'Ninguna ejecucion todavia.');
  const tree = h('div', { class: 'list', style: 'overflow:auto' });
  const coverageLine = h('div', { class: 'list-row__hint', style: 'padding:4px 8px' });

  const toggleCoverage = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Alternar el resaltado de cobertura',
    'aria-label': 'Alternar el resaltado de cobertura',
  });
  toggleCoverage.appendChild(svgIcon(ICONS.eye, 13));
  toggleCoverage.addEventListener('click', () => void runCommand('testing.toggleCoverage'));

  const cancel = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Cancelar la ejecucion',
    'aria-label': 'Cancelar la ejecucion',
  });
  cancel.appendChild(svgIcon(ICONS.stop, 13));
  cancel.addEventListener('click', () => void runCommand('testing.cancel'));

  context.actions.append(toggleCoverage, cancel);
  context.container.replaceChildren(
    h(
      'div',
      { style: 'display:flex;flex-direction:column;height:100%' },
      summaryLine,
      coverageLine,
      tree,
    ),
  );

  const render = (): void => {
    const state = store.state;

    if (state.testRunning !== null) {
      summaryLine.textContent = 'Ejecutando las pruebas…';
    }

    const run = state.testRun;
    if (run === null) {
      tree.replaceChildren();
      return;
    }

    summaryLine.replaceChildren(
      h(
        'div',
        { style: `color:${STATUS_TONES[run.status] ?? ''}` },
        `${run.passed} pasadas · ${run.failed} fallidas · ${run.skipped} omitidas`,
      ),
      h(
        'div',
        { class: 'list-row__hint' },
        `${run.runner} · ${run.total} pruebas en ${formatDuration(run.durationMs)}`,
      ),
    );

    const coverage = state.coverage;
    coverageLine.textContent =
      coverage === null
        ? ''
        : `Cobertura: ${coverage.percent}% (${coverage.statementsCovered}/${coverage.statementsTotal} sentencias)`;

    tree.replaceChildren(...run.files.map((file) => fileNode(file)));
  };

  function fileNode(file: TestRunSummary['files'][number]): HTMLElement {
    const cases = h('div', { style: 'padding-left:10px' });
    for (const testCase of file.cases) {
      cases.appendChild(caseNode(testCase));
    }
    const summary = h(
      'summary',
      { class: 'list-row', title: file.path },
      h(
        'span',
        { class: 'list-row__hint', style: `color:${STATUS_TONES[file.status] ?? ''}` },
        STATUS_MARKS[file.status] ?? '',
      ),
      h('span', { class: 'list-row__label' }, file.path),
      h('span', { class: 'list-row__hint' }, formatDuration(file.durationMs)),
    );
    // Los archivos con fallos se abren solos: es lo que se va a mirar.
    return h('details', { open: file.status === 'failed' ? '' : null }, summary, cases);
  }

  function caseNode(testCase: TestCaseResult): HTMLElement {
    const row = h(
      'div',
      { class: 'list-row', title: testCase.fullName },
      h(
        'span',
        { class: 'list-row__hint', style: `color:${STATUS_TONES[testCase.status] ?? ''}` },
        STATUS_MARKS[testCase.status] ?? '',
      ),
      h('span', { class: 'list-row__label' }, testCase.name),
      h('span', { class: 'list-row__hint' }, formatDuration(testCase.durationMs)),
    );
    row.addEventListener('click', () => void reveal(testCase));

    if (testCase.status !== 'failed' || testCase.message === undefined) {
      return row;
    }
    // La traza va en un `<pre>` con `textContent`: el mensaje puede contener
    // cualquier cosa y nunca se interpreta como HTML.
    const trace = h('pre', {
      class: 'logline__message',
      style: 'white-space:pre-wrap;padding:4px 12px;color:var(--state-error);user-select:text',
    });
    trace.textContent = testCase.message;
    trace.addEventListener('click', () => void reveal(testCase));
    return h('div', {}, row, trace);
  }

  store.subscribe(['testRun', 'testRunning', 'coverage'], render);
  render();
}

/** Abre el archivo y la linea donde fallo la prueba. */
async function reveal(testCase: TestCaseResult): Promise<void> {
  const path = testCase.failurePath ?? testCase.path;
  if (path === '') {
    return;
  }
  await openFile(path, testCase.failureLine);
}

/* -------------------------------------------------------------------------- */
/*  Registro                                                                   */
/* -------------------------------------------------------------------------- */

export function registerTestingView(): void {
  registerSidebarView('testing', buildSidebar);
  registerPanelView('testing', buildPanel);

  defineCommands([
    {
      id: 'testing.runAll',
      title: 'Pruebas: ejecutar todas',
      category: 'Pruebas',
      enabled: () => store.state.workspace !== null,
      run: () => launch({}),
    },
    {
      id: 'testing.runFile',
      title: 'Pruebas: ejecutar el archivo activo',
      category: 'Pruebas',
      enabled: () => store.state.activeDocument !== null,
      run: () => {
        const active = store.state.activeDocument;
        if (active === null) {
          return;
        }
        return launch({ path: active });
      },
    },
    {
      id: 'testing.runWithCoverage',
      title: 'Pruebas: ejecutar con cobertura',
      category: 'Pruebas',
      enabled: () => store.state.workspace !== null,
      run: () => launch({ coverage: true }),
    },
    {
      id: 'testing.runBlock',
      title: 'Pruebas: ejecutar el bloque',
      category: 'Pruebas',
      run: (argument) => {
        const block = argument as TestBlock | undefined;
        if (block === undefined) {
          return;
        }
        store.patch({ panelView: 'testing', panelVisible: true });
        return launch({ path: block.path, testName: block.fullName });
      },
    },
    {
      id: 'testing.debugBlock',
      title: 'Pruebas: depurar el bloque',
      category: 'Pruebas',
      run: async (argument) => {
        const block = argument as TestBlock | undefined;
        if (block === undefined) {
          return;
        }
        // Se lanza con el inspector abierto y se conecta el depurador; la
        // sesion se pega al puerto estandar de Node.
        toast(
          'info',
          'Arranca el ejecutor con --inspect-brk y conecta el depurador.',
          `Puerto ${DEBUG_INSPECT_PORT}. La prueba filtrada es "${block.fullName}".`,
        );
        store.patch({ sidebarView: 'debug', sidebarVisible: true });
        await runCommand('debug.attach');
      },
    },
    {
      id: 'testing.showFailure',
      title: 'Pruebas: ver el fallo',
      category: 'Pruebas',
      run: async (argument) => {
        const result = argument as TestCaseResult | undefined;
        if (result === undefined) {
          return;
        }
        store.patch({ panelView: 'testing', panelVisible: true });
        await reveal(result);
      },
    },
    {
      id: 'testing.cancel',
      title: 'Pruebas: cancelar la ejecucion',
      category: 'Pruebas',
      enabled: () => store.state.testRunning !== null,
      run: async () => {
        const runId = store.state.testRunning;
        if (runId === null) {
          return;
        }
        await window.forge.testing.cancel(runId);
        store.patch({ testRunning: null });
      },
    },
    {
      id: 'testing.toggleCoverage',
      title: 'Pruebas: alternar el resaltado de cobertura',
      category: 'Pruebas',
      run: async () => {
        const next = !store.state.coverageVisible;
        if (next && store.state.coverage === null) {
          // Puede haber un informe de una ejecucion anterior en disco.
          const report = await window.forge.testing.coverage();
          if (!report.ok || report.value === null) {
            toast(
              'info',
              'No hay ningun informe de cobertura.',
              'Ejecuta las pruebas con cobertura para generarlo.',
            );
            return;
          }
          store.patch({ coverage: report.value });
        }
        store.patch({ coverageVisible: next });
        renderCoverage();
      },
    },
    {
      id: 'testing.selectRunner',
      title: 'Pruebas: elegir el ejecutor',
      category: 'Pruebas',
      enabled: () => store.state.testRunners.length > 1,
      run: async () => {
        const choice = await selectDialog({
          title: 'Con que ejecutor',
          items: store.state.testRunners.map((runner) => ({ id: runner, label: runner })),
        });
        if (choice === null) {
          return;
        }
        await launch({ runner: choice as TestRunnerId });
      },
    },
    {
      id: 'testing.handleResults',
      title: 'Pruebas: procesar los resultados',
      category: 'Pruebas',
      run: (argument) => {
        const summary = argument as TestRunSummary | undefined;
        if (summary === undefined) {
          return;
        }
        applyTestResults(summary);
        if (summary.failed > 0) {
          store.patch({ panelView: 'testing', panelVisible: true });
          toast('error', `${summary.failed} pruebas fallaron.`, `Ejecutor ${summary.runner}.`);
          return;
        }
        toast('info', `${summary.passed} pruebas pasaron.`, formatDuration(summary.durationMs));
      },
    },
    {
      id: 'testing.handleCoverage',
      title: 'Pruebas: procesar la cobertura',
      category: 'Pruebas',
      run: (argument) => {
        const report = argument as Parameters<typeof applyCoverage>[0] | undefined;
        if (report !== undefined) {
          applyCoverage(report);
        }
      },
    },
  ]);
}
