/**
 * Selector de inicio DotForge.
 *
 * Reune en una sola vista los pipelines del manifiesto, las tareas sueltas,
 * los scripts reales de package.json y el gestor visual de variables de
 * entorno con enmascarado de credenciales.
 */

import { h, svgIcon } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import type {
  EnvFileView,
  ProcessInfo,
  ProcessStatus,
  ScriptEntry,
} from '../../shared/contracts.js';

let container: HTMLElement;
let scripts: readonly ScriptEntry[] = [];
let envViews: readonly EnvFileView[] = [];
const revealed = new Map<string, string>();

export function registerPipelinesView(): void {
  registerSidebarView('pipelines', mount);

  defineCommands([
    {
      id: 'dotforge.reload',
      title: 'DotForge: recargar el manifiesto',
      category: 'DotForge',
      run: () => reloadManifest(),
    },
    {
      id: 'dotforge.sync',
      title: 'DotForge: sincronizar con package.json',
      category: 'DotForge',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        const result = await window.forge.dotforge.sync();
        if (!result.ok) {
          toastError('No se pudo sincronizar el manifiesto.', result.error);
          return;
        }
        store.patch({ manifest: result.value });
        toast('info', 'dotforge.config.json sincronizado con el proyecto.');
        render();
      },
    },
    {
      id: 'dotforge.openConfig',
      title: 'DotForge: abrir el manifiesto',
      category: 'DotForge',
      run: async () => {
        const manifest = store.state.manifest;
        if (manifest?.found === true && manifest.path !== undefined) {
          await runCommand('editor.openFile', manifest.path);
          return;
        }
        const created = await window.forge.dotforge.sync();
        if (!created.ok) {
          toastError('No se pudo crear el manifiesto.', created.error);
          return;
        }
        store.patch({ manifest: created.value });
        await runCommand('editor.openFile', created.value.path ?? 'dotforge.config.json');
      },
    },
    {
      id: 'toolchain.reload',
      title: 'Toolchain: volver a detectar',
      category: 'DotForge',
      run: () => reloadToolchain(),
    },
    {
      id: 'pipeline.runDefault',
      title: 'Ejecutar el pipeline principal',
      category: 'Ejecutar',
      run: () => runDefaultPipeline(),
    },
    {
      id: 'pipeline.stopAll',
      title: 'Detener todos los procesos',
      category: 'Ejecutar',
      run: async () => {
        for (const info of store.state.processes) {
          if (info.status === 'running' || info.status === 'ready' || info.status === 'starting') {
            await window.forge.process.stop(info.id);
          }
        }
      },
    },
  ]);
}

function mount(context: SidebarViewContext): void {
  container = h('div', {});
  context.container.replaceChildren(container);

  const actions: [string, keyof typeof ICONS, string][] = [
    ['pipeline.runDefault', 'run', 'Ejecutar el pipeline principal'],
    ['dotforge.sync', 'refresh', 'Sincronizar el manifiesto'],
    ['dotforge.openConfig', 'settings', 'Abrir dotforge.config.json'],
  ];
  for (const [commandId, icon, label] of actions) {
    const button = h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label });
    button.appendChild(svgIcon(ICONS[icon], 13));
    button.addEventListener('click', () => void runCommand(commandId));
    context.actions.appendChild(button);
  }

  store.subscribe(['manifest', 'processes', 'workspace', 'toolchain'], render);
  void reloadManifest();
  void reloadToolchain();
  void reloadScripts();
  void reloadEnv();
  render();
}

async function reloadManifest(): Promise<void> {
  if (store.state.workspace === null) {
    store.patch({ manifest: null });
    return;
  }
  const result = await window.forge.dotforge.readConfig();
  if (result.ok) {
    store.patch({ manifest: result.value });
  }
}

async function reloadToolchain(): Promise<void> {
  if (store.state.workspace === null) {
    store.patch({ toolchain: null, project: null });
    return;
  }
  const [toolchain, project] = await Promise.all([
    window.forge.toolchain.detect(),
    window.forge.toolchain.manifest(),
  ]);
  store.patch({
    toolchain: toolchain.ok ? toolchain.value : null,
    project: project.ok ? project.value : null,
  });
}

async function reloadScripts(): Promise<void> {
  const result = await window.forge.toolchain.scripts();
  scripts = result.ok ? result.value : [];
  render();
}

async function reloadEnv(): Promise<void> {
  const result = await window.forge.process.readEnv();
  envViews = result.ok ? result.value : [];
  render();
}

/* -------------------------------------------------------------------------- */
/*  Ejecucion                                                                  */
/* -------------------------------------------------------------------------- */

async function runPipeline(pipelineId: string): Promise<void> {
  const result = await window.forge.dotforge.runPipeline(pipelineId);
  if (!result.ok) {
    toastError(`No se pudo iniciar el pipeline "${pipelineId}".`, result.error);
    return;
  }
  store.patch({ panelView: 'output', panelVisible: true });
  if (result.value.length > 0) {
    store.patch({ activeProcessId: result.value[0]?.id ?? null });
  }
}

async function runDefaultPipeline(): Promise<void> {
  const pipelines = store.state.manifest?.config.pipelines ?? {};
  const first = Object.keys(pipelines)[0];
  if (first === undefined) {
    toast('warn', 'El proyecto no declara ningun pipeline DotForge.');
    return;
  }
  await runPipeline(first);
}

async function runScript(entry: ScriptEntry): Promise<void> {
  const toolchain = store.state.toolchain;
  const manager = toolchain?.preferred ?? 'npm';
  const id = `script:${entry.workspace ?? 'root'}:${entry.name}`;
  const result = await window.forge.process.start({
    id,
    label: entry.workspace === undefined ? entry.name : `${entry.workspace} · ${entry.name}`,
    command: manager,
    args: ['run', entry.name],
    logFormat: 'auto',
  });
  if (!result.ok) {
    toastError(`No se pudo ejecutar "${entry.name}".`, result.error);
    return;
  }
  store.patch({ panelView: 'output', panelVisible: true, activeProcessId: id });
}

async function runTask(taskId: string): Promise<void> {
  const manifest = store.state.manifest;
  const task = manifest?.config.tasks?.[taskId];
  if (task === undefined) {
    return;
  }
  const toolchain = store.state.toolchain;
  const manager = toolchain?.preferred ?? 'npm';

  const request =
    task.script !== undefined
      ? { command: manager, args: ['run', task.script, ...(task.args ?? [])] }
      : splitCommand(task.command ?? '', task.args ?? []);

  const id = `task:${taskId}`;
  const result = await window.forge.process.start({
    id,
    label: task.label ?? taskId,
    command: request.command,
    args: request.args,
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    ...(task.env === undefined ? {} : { env: task.env }),
    ...(task.logFormat === undefined ? {} : { logFormat: task.logFormat }),
    ...(task.readyPattern === undefined ? {} : { readyPattern: task.readyPattern }),
    ...(task.port === undefined ? {} : { port: task.port }),
  });
  if (!result.ok) {
    toastError(`No se pudo iniciar la tarea "${taskId}".`, result.error);
    return;
  }
  store.patch({ panelView: 'output', panelVisible: true, activeProcessId: id });
}

/** Igual que el partidor del main: respeta comillas, no usa shell. */
function splitCommand(line: string, extra: readonly string[]): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const character of line) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (current !== '') {
    parts.push(current);
  }
  return { command: parts[0] ?? '', args: [...parts.slice(1), ...extra] };
}

/* -------------------------------------------------------------------------- */
/*  Pintado                                                                    */
/* -------------------------------------------------------------------------- */

function statusOf(id: string): ProcessStatus | null {
  return store.state.processes.find((info: ProcessInfo) => info.id === id)?.status ?? null;
}

function isLive(status: ProcessStatus | null): boolean {
  return status === 'running' || status === 'ready' || status === 'starting';
}

function section(title: string, count: number, body: HTMLElement, collapsed = false): HTMLElement {
  const element = h('div', { class: 'section', 'data-collapsed': String(collapsed) });
  const header = h('div', { class: 'section__header' }, title);
  header.appendChild(h('span', { class: 'section__count' }, String(count)));
  header.addEventListener('click', () => {
    element.dataset['collapsed'] = element.dataset['collapsed'] === 'true' ? 'false' : 'true';
  });
  element.append(header, h('div', { class: 'section__body' }, body));
  return element;
}

function actionRow(
  label: string,
  hint: string,
  id: string,
  onRun: () => void,
): HTMLElement {
  const status = statusOf(id);
  const row = h('div', { class: 'list-row', title: hint });
  row.appendChild(h('span', { class: 'pill-tab__dot', 'data-status': status ?? 'idle' }));
  row.appendChild(h('span', { class: 'list-row__label' }, label));
  if (hint !== '') {
    row.appendChild(h('span', { class: 'list-row__hint' }, hint));
  }

  const actions = h('div', { class: 'list-row__actions' });
  const live = isLive(status);

  const runButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: live ? 'Detener' : 'Ejecutar',
    'aria-label': live ? 'Detener' : 'Ejecutar',
  });
  runButton.appendChild(svgIcon(live ? ICONS.stop : ICONS.run, 12));
  runButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (live) {
      void window.forge.process.stop(id);
    } else {
      onRun();
    }
  });
  actions.appendChild(runButton);

  if (live) {
    const restart = h('button', { class: 'icon-btn', type: 'button', title: 'Reiniciar' });
    restart.appendChild(svgIcon(ICONS.refresh, 12));
    restart.addEventListener('click', (event) => {
      event.stopPropagation();
      void window.forge.process.restart(id);
    });
    actions.appendChild(restart);
  }

  row.appendChild(actions);
  row.addEventListener('click', () => {
    if (live) {
      store.patch({ panelView: 'output', panelVisible: true, activeProcessId: id });
    } else {
      onRun();
    }
  });
  return row;
}

function render(): void {
  if (container === undefined) {
    return;
  }
  container.replaceChildren();

  if (store.state.workspace === null) {
    container.appendChild(h('div', { class: 'empty-note' }, 'Abre una carpeta para ver sus pipelines.'));
    return;
  }

  const manifest = store.state.manifest;
  const toolchain = store.state.toolchain;

  /* --- Cabecera con el estado del toolchain --- */
  const chips = h('div', { class: 'chat__context', style: 'padding:8px' });
  if (toolchain !== null) {
    chips.appendChild(
      h(
        'span',
        { class: 'chip', 'data-tone': 'accent', title: `Origen: ${toolchain.preferredReason}` },
        toolchain.preferred,
      ),
    );
    if (toolchain.nodeVersion !== undefined) {
      chips.appendChild(h('span', { class: 'chip' }, `node ${toolchain.nodeVersion}`));
    }
    if (toolchain.dockerVersion !== undefined) {
      chips.appendChild(h('span', { class: 'chip' }, 'docker'));
    }
  }
  if (manifest !== null) {
    chips.appendChild(
      h(
        'span',
        { class: 'chip', title: manifest.inferred ? 'Derivado de package.json' : manifest.path },
        manifest.inferred ? 'manifiesto inferido' : (manifest.path ?? 'dotforge'),
      ),
    );
  }
  for (const framework of store.state.project?.frameworks ?? []) {
    chips.appendChild(h('span', { class: 'chip' }, framework.label));
  }
  container.appendChild(chips);

  /* --- Pipelines --- */
  const pipelines = Object.entries(manifest?.config.pipelines ?? {});
  const pipelineBody = h('div', {});
  for (const [id, pipeline] of pipelines) {
    const row = h('div', { class: 'list-row', title: pipeline.description ?? '' });
    row.appendChild(svgIcon(ICONS.pipeline, 13));
    row.appendChild(h('span', { class: 'list-row__label' }, pipeline.label ?? id));
    row.appendChild(
      h('span', { class: 'list-row__hint' }, `${pipeline.tasks.length} tareas${pipeline.parallel === false ? ' · en cadena' : ''}`),
    );
    const actions = h('div', { class: 'list-row__actions' });
    const runButton = h('button', { class: 'icon-btn', type: 'button', title: 'Ejecutar el pipeline' });
    runButton.appendChild(svgIcon(ICONS.run, 12));
    runButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void runPipeline(id);
    });
    actions.appendChild(runButton);
    row.appendChild(actions);
    row.addEventListener('click', () => void runPipeline(id));
    pipelineBody.appendChild(row);
  }
  if (pipelines.length === 0) {
    pipelineBody.appendChild(
      h('div', { class: 'empty-note' }, 'Sin pipelines. Sincroniza el manifiesto para generarlos.'),
    );
  }
  container.appendChild(section('Pipelines', pipelines.length, pipelineBody));

  /* --- Tareas --- */
  const tasks = Object.entries(manifest?.config.tasks ?? {});
  const taskBody = h('div', {});
  for (const [id, task] of tasks) {
    taskBody.appendChild(
      actionRow(
        task.label ?? id,
        task.script !== undefined ? `script: ${task.script}` : (task.command ?? ''),
        `task:${id}`,
        () => void runTask(id),
      ),
    );
  }
  if (tasks.length === 0) {
    taskBody.appendChild(h('div', { class: 'empty-note' }, 'Sin tareas declaradas.'));
  }
  container.appendChild(section('Tareas DotForge', tasks.length, taskBody));

  /* --- Scripts de package.json --- */
  const scriptBody = h('div', {});
  for (const entry of scripts) {
    scriptBody.appendChild(
      actionRow(
        entry.workspace === undefined ? entry.name : `${entry.workspace} · ${entry.name}`,
        entry.command,
        `script:${entry.workspace ?? 'root'}:${entry.name}`,
        () => void runScript(entry),
      ),
    );
  }
  if (scripts.length === 0) {
    scriptBody.appendChild(h('div', { class: 'empty-note' }, 'package.json no declara scripts.'));
  }
  container.appendChild(section('Scripts de package.json', scripts.length, scriptBody, true));

  /* --- Variables de entorno --- */
  const envBody = h('div', {});
  let variableCount = 0;
  for (const file of envViews) {
    variableCount += file.variables.length;
    envBody.appendChild(
      h('div', { class: 'list-row__hint', style: 'padding:4px 8px;font-family:var(--font-mono)' }, file.path),
    );
    for (const variable of file.variables) {
      envBody.appendChild(renderEnvRow(file.path, variable));
    }
  }
  if (envViews.length === 0) {
    envBody.appendChild(h('div', { class: 'empty-note' }, 'No se encontraron archivos .env.'));
  }
  container.appendChild(section('Variables de entorno', variableCount, envBody, true));
}

function renderEnvRow(
  file: string,
  variable: EnvFileView['variables'][number],
): HTMLElement {
  const key = `${file}::${variable.key}`;
  const shown = revealed.get(key);
  const row = h('div', { class: 'list-row', title: variable.key });
  row.appendChild(
    h('span', { class: 'list-row__label', style: 'font-family:var(--font-mono);flex:0 0 auto;max-width:45%' }, variable.key),
  );
  row.appendChild(
    h(
      'span',
      {
        class: 'list-row__hint',
        style: `font-family:var(--font-mono);flex:1;${variable.secret ? 'color:var(--state-warning)' : ''}`,
      },
      shown ?? variable.value,
    ),
  );

  if (variable.secret) {
    const actions = h('div', { class: 'list-row__actions' });
    const toggle = h('button', {
      class: 'icon-btn',
      type: 'button',
      title: shown === undefined ? 'Revelar el valor' : 'Volver a ocultar',
    });
    toggle.appendChild(svgIcon(shown === undefined ? ICONS.eye : ICONS.eyeOff, 12));
    toggle.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (shown !== undefined) {
        revealed.delete(key);
        render();
        return;
      }
      const result = await window.forge.process.revealEnv(file, variable.key);
      if (result.ok) {
        revealed.set(key, result.value);
        render();
      }
    });
    actions.appendChild(toggle);
    row.appendChild(actions);
  }
  return row;
}
