/**
 * Asistente de scaffolding DotForge.
 *
 * Tres pasos en un solo dialogo: elegir arquitectura, ajustar opciones y
 * revisar el plan. Antes de escribir nada se muestra la lista real de
 * archivos que se van a generar, calculada con una ejecucion en seco.
 */

import { h, svgIcon, formatBytes } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import type {
  Blueprint,
  BlueprintCategory,
  GenerateResult,
  PackageManagerId,
} from '../../shared/contracts.js';

const CATEGORY_LABEL: Readonly<Record<BlueprintCategory, string>> = {
  frontend: 'Interfaz',
  backend: 'Servidor',
  fullstack: 'Fullstack',
  monorepo: 'Monorepo',
};

const MANAGERS: readonly PackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun'];

let overlaysHost: HTMLElement | null = null;
let blueprints: readonly Blueprint[] = [];

export function registerScaffoldWizard(overlays: HTMLElement): void {
  overlaysHost = overlays;

  defineCommands([
    {
      id: 'dotforge.newProject',
      title: 'DotForge: generar un proyecto nuevo…',
      category: 'DotForge',
      run: () => open(),
    },
  ]);
}

async function open(): Promise<void> {
  if (overlaysHost === null) {
    return;
  }
  if (blueprints.length === 0) {
    const result = await window.forge.dotforge.blueprints();
    if (!result.ok) {
      toastError('No se pudo leer el catalogo de arquitecturas.', result.error);
      return;
    }
    blueprints = result.value;
  }

  /* --- Estado del asistente --- */
  let selected: Blueprint | undefined = blueprints[0];
  const options = new Map<string, string | boolean>();
  let plan: GenerateResult | null = null;

  const resetOptions = (blueprint: Blueprint): void => {
    options.clear();
    for (const option of blueprint.options) {
      options.set(option.id, option.default);
    }
  };
  if (selected !== undefined) {
    resetOptions(selected);
  }

  /* --- Controles --- */
  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'mi-proyecto',
    'aria-label': 'Nombre del proyecto',
  }) as HTMLInputElement;

  const targetInput = h('input', {
    class: 'input input--mono',
    type: 'text',
    placeholder: 'Ruta absoluta de la carpeta destino',
    'aria-label': 'Carpeta destino',
  }) as HTMLInputElement;

  const managerSelect = h('select', { class: 'select', 'aria-label': 'Gestor de paquetes' }) as HTMLSelectElement;
  for (const manager of MANAGERS) {
    managerSelect.appendChild(h('option', { value: manager }, manager));
  }
  const toolchain = store.state.toolchain;
  managerSelect.value = toolchain?.preferred ?? 'npm';

  const blueprintList = h('div', { style: 'display:flex;flex-direction:column;gap:2px;max-height:34vh;overflow:auto' });
  const optionsHost = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  const planHost = h('div', {});

  /* --- Pintado --- */
  function renderBlueprints(): void {
    blueprintList.replaceChildren();
    let lastCategory: BlueprintCategory | null = null;

    for (const blueprint of blueprints) {
      if (blueprint.category !== lastCategory) {
        lastCategory = blueprint.category;
        blueprintList.appendChild(
          h('div', { class: 'section__header', style: 'cursor:default' }, CATEGORY_LABEL[blueprint.category]),
        );
      }
      const row = h('div', {
        class: 'palette__item',
        'data-active': String(selected?.id === blueprint.id),
        title: blueprint.description,
        style: 'height:auto;padding:6px 12px;flex-direction:column;align-items:flex-start;gap:2px',
      });
      row.appendChild(h('span', { style: 'font-weight:600' }, blueprint.label));
      row.appendChild(h('span', { class: 'list-row__hint' }, blueprint.description));
      row.addEventListener('click', () => {
        selected = blueprint;
        resetOptions(blueprint);
        plan = null;
        renderBlueprints();
        renderOptions();
        renderPlan();
      });
      blueprintList.appendChild(row);
    }
  }

  function renderOptions(): void {
    optionsHost.replaceChildren();
    if (selected === undefined) {
      return;
    }
    for (const option of selected.options) {
      if (option.type === 'boolean') {
        const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
        input.checked = options.get(option.id) === true;
        input.addEventListener('change', () => {
          options.set(option.id, input.checked);
          plan = null;
          renderPlan();
        });
        optionsHost.appendChild(
          h('label', { class: 'checkbox', title: option.description ?? '' }, input, option.label),
        );
        continue;
      }

      const select = h('select', { class: 'select', 'aria-label': option.label }) as HTMLSelectElement;
      for (const choice of option.choices ?? []) {
        select.appendChild(h('option', { value: choice.id }, choice.label));
      }
      select.value = String(options.get(option.id) ?? option.default);
      select.addEventListener('change', () => {
        options.set(option.id, select.value);
        plan = null;
        renderPlan();
      });

      const field = h('div', { class: 'field' });
      field.appendChild(h('span', { class: 'field__label' }, option.label));
      field.appendChild(select);
      if (option.description !== undefined) {
        field.appendChild(h('span', { class: 'list-row__hint' }, option.description));
      }
      optionsHost.appendChild(field);
    }
  }

  function renderPlan(): void {
    planHost.replaceChildren();
    if (plan === null) {
      planHost.appendChild(
        h('div', { class: 'list-row__hint' }, 'Pulsa "Previsualizar" para ver los archivos que se generaran.'),
      );
      return;
    }
    const total = plan.files.reduce((sum, file) => sum + file.bytes, 0);
    planHost.appendChild(
      h(
        'div',
        { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px' },
        h('span', { class: 'chip', 'data-tone': 'accent' }, `${plan.files.length} archivos`),
        h('span', { class: 'chip' }, formatBytes(total)),
      ),
    );
    const list = h('div', {
      style:
        'max-height:26vh;overflow:auto;font-family:var(--font-mono);font-size:var(--font-size-xs);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);padding:6px',
    });
    for (const file of plan.files) {
      const row = h('div', { style: 'display:flex;justify-content:space-between;gap:8px' });
      row.append(
        h('span', {}, file.path),
        h('span', { style: 'color:var(--text-subtle)' }, formatBytes(file.bytes)),
      );
      list.appendChild(row);
    }
    planHost.appendChild(list);
  }

  /* --- Acciones --- */
  async function preview(): Promise<void> {
    if (selected === undefined) {
      return;
    }
    if (targetInput.value.trim() === '') {
      toast('warn', 'Indica la carpeta destino.');
      return;
    }
    const result = await window.forge.dotforge.generate({
      blueprintId: selected.id,
      targetDir: targetInput.value.trim(),
      projectName: nameInput.value.trim() === '' ? 'proyecto' : nameInput.value.trim(),
      packageManager: managerSelect.value as PackageManagerId,
      options: Object.fromEntries(options),
      dryRun: true,
    });
    if (!result.ok) {
      toastError('No se pudo calcular el plan.', result.error);
      return;
    }
    plan = result.value;
    renderPlan();
  }

  async function create(): Promise<void> {
    if (selected === undefined) {
      return;
    }
    const target = targetInput.value.trim();
    if (target === '') {
      toast('warn', 'Indica la carpeta destino.');
      return;
    }
    const result = await window.forge.dotforge.generate({
      blueprintId: selected.id,
      targetDir: target,
      projectName: nameInput.value.trim() === '' ? 'proyecto' : nameInput.value.trim(),
      packageManager: managerSelect.value as PackageManagerId,
      options: Object.fromEntries(options),
    });
    if (!result.ok) {
      toastError('No se pudo generar el proyecto.', result.error);
      return;
    }

    close();
    toast(
      'info',
      `Proyecto generado: ${result.value.files.length} archivos.`,
      result.value.nextSteps.join('  ·  '),
    );

    // Abrir el proyecto recien creado es lo que casi siempre se quiere.
    const opened = await window.forge.workspace.open(result.value.targetDir);
    if (opened.ok) {
      store.patch({ workspace: opened.value });
      await runCommand('workspace.refresh');
    }
  }

  /* --- Dialogo --- */
  const previewButton = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Previsualizar');
  previewButton.addEventListener('click', () => void preview());

  const createButton = h('button', { class: 'btn btn--primary', type: 'button' }, 'Generar proyecto');
  createButton.addEventListener('click', () => void create());

  const cancelButton = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancelar');
  cancelButton.addEventListener('click', () => close());

  const pickButton = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' });
  pickButton.append(svgIcon(ICONS.folder, 13), 'Elegir…');
  pickButton.addEventListener('click', async () => {
    // Se reutiliza el selector de carpeta nativo del proceso principal.
    const picked = await window.forge.workspace.pick();
    if (picked.ok && picked.value !== null) {
      targetInput.value = picked.value.root;
      store.patch({ workspace: picked.value });
    }
  });

  const dialog = h(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-label': 'Generar un proyecto', style: 'width:min(960px,94vw)' },
    h('div', { class: 'dialog__header' }, 'Generar un proyecto con DotForge'),
    h(
      'div',
      { class: 'dialog__body', style: 'display:grid;grid-template-columns:300px 1fr;gap:16px' },
      h(
        'div',
        { style: 'display:flex;flex-direction:column;gap:8px;min-width:0' },
        h('span', { class: 'field__label' }, 'Arquitectura'),
        blueprintList,
      ),
      h(
        'div',
        { style: 'display:flex;flex-direction:column;gap:12px;min-width:0' },
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field__label' }, 'Nombre del proyecto'),
          nameInput,
        ),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field__label' }, 'Carpeta destino (debe estar vacia)'),
          h('div', { style: 'display:flex;gap:6px' }, targetInput, pickButton),
        ),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field__label' }, 'Gestor de paquetes'),
          managerSelect,
        ),
        h('div', { style: 'border-top:1px solid var(--border-subtle);padding-top:10px' }, optionsHost),
        h('div', { style: 'border-top:1px solid var(--border-subtle);padding-top:10px' }, planHost),
      ),
    ),
    h('div', { class: 'dialog__footer' }, cancelButton, previewButton, createButton),
  );

  const overlay = h('div', { class: 'overlay overlay--center' }, dialog);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  overlaysHost.appendChild(overlay);

  function close(): void {
    overlay.remove();
  }

  renderBlueprints();
  renderOptions();
  renderPlan();
  nameInput.focus();
}
