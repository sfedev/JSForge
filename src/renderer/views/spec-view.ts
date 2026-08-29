/**
 * Visor de contratos: especificaciones OpenAPI y auditoria de tipos.
 *
 * La vista lateral lista las operaciones agrupadas por etiqueta y permite
 * generar codigo desde cualquiera de ellas. El panel inferior muestra el
 * informe de cambios que rompen a los consumidores de `src/shared/`.
 *
 * Nada se escribe sin confirmacion: la generacion siempre se previsualiza
 * primero en una pestana de diferencias, porque sobrescribir un archivo de
 * tipos que alguien edito a mano seria una perdida silenciosa.
 */

import { h, svgIcon } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { confirmDialog, selectDialog } from '../core/dialogs.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import { registerPanelView, type PanelViewContext } from './panel.js';
import { openDiff, openFile } from './editor-area.js';
import type {
  BreakingChange,
  ContractAuditReport,
  OpenApiDocumentView,
  OpenApiOperation,
  SpecGenerationTarget,
} from '../../shared/contracts.js';

/** Objetivos de generacion ofrecidos en el selector. */
const TARGETS: readonly { id: SpecGenerationTarget; label: string; hint: string }[] = [
  { id: 'types', label: 'Tipos TypeScript', hint: 'interfaces de components.schemas' },
  { id: 'client', label: 'Cliente tipado', hint: 'clase con un metodo por operacion' },
  { id: 'react-hooks', label: 'Hooks de React', hint: 'useQuery/useMutation con AbortController' },
  { id: 'vue-composables', label: 'Composables de Vue', hint: 'refs con cancelacion por scope' },
];

/** Color del metodo HTTP en la lista de operaciones. */
const METHOD_TONES: Readonly<Record<string, string>> = {
  get: 'var(--state-info)',
  post: 'var(--state-success)',
  put: 'var(--state-warning)',
  patch: 'var(--state-warning)',
  delete: 'var(--state-error)',
};

let currentDocument: OpenApiDocumentView | null = null;
let currentReport: ContractAuditReport | null = null;

/** Suscriptores del panel de auditoria: se avisa al recalcular el informe. */
const reportListeners = new Set<() => void>();

function setReport(report: ContractAuditReport | null): void {
  currentReport = report;
  for (const listener of reportListeners) {
    listener();
  }
}

/* -------------------------------------------------------------------------- */
/*  Barra lateral: especificacion                                              */
/* -------------------------------------------------------------------------- */

function buildSidebar(context: SidebarViewContext): void {
  const header = h('div', { class: 'empty-note' }, 'Buscando especificaciones…');
  const operationList = h('div', { class: 'list' });
  const schemaList = h('div', { class: 'list' });

  const reload = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Volver a buscar especificaciones',
    'aria-label': 'Volver a buscar especificaciones',
  });
  reload.appendChild(svgIcon(ICONS.refresh, 13));
  reload.addEventListener('click', () => void load());
  context.actions.appendChild(reload);

  const generateButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Generar codigo desde la especificacion',
    'aria-label': 'Generar codigo desde la especificacion',
  });
  generateButton.appendChild(svgIcon(ICONS.layers, 13));
  generateButton.addEventListener('click', () => void runCommand('spec.generate'));
  context.actions.appendChild(generateButton);

  const section = (title: string, body: HTMLElement): HTMLElement =>
    h(
      'div',
      { class: 'section' },
      h('div', { class: 'section__header' }, title),
      h('div', { class: 'section__body' }, body),
    );

  context.container.replaceChildren(
    header,
    section('Operaciones', operationList),
    section('Esquemas', schemaList),
  );

  async function load(): Promise<void> {
    const found = await window.forge.spec.discover();
    if (!found.ok) {
      header.textContent = found.error.message;
      return;
    }
    const first = found.value[0];
    if (first === undefined) {
      header.textContent = 'No se encontro ningun openapi.json ni openapi.yaml.';
      operationList.replaceChildren();
      schemaList.replaceChildren();
      currentDocument = null;
      return;
    }
    await select(first);
  }

  async function select(path: string): Promise<void> {
    const parsed = await window.forge.spec.parse(path);
    if (!parsed.ok) {
      header.textContent = parsed.error.message;
      return;
    }
    currentDocument = parsed.value;
    render(parsed.value);
  }

  function render(document_: OpenApiDocumentView): void {
    header.replaceChildren(
      h('div', { class: 'list-row__label' }, `${document_.title} v${document_.version}`),
      h('div', { class: 'list-row__hint' }, `${document_.path} · OpenAPI ${document_.openapi}`),
    );
    header.className = 'section__body';

    // Los avisos del analisis se muestran: callarlos haria pensar que la
    // especificacion se entendio entera cuando no fue asi.
    for (const warning of document_.warnings) {
      header.appendChild(
        h('div', { class: 'list-row__hint', style: 'color:var(--state-warning)' }, warning),
      );
    }

    /* --- Operaciones agrupadas por etiqueta --- */
    const groups = new Map<string, OpenApiOperation[]>();
    for (const operation of document_.operations) {
      const tag = operation.tags[0] ?? 'Sin etiqueta';
      const list = groups.get(tag) ?? [];
      list.push(operation);
      groups.set(tag, list);
    }

    operationList.replaceChildren(
      ...[...groups.entries()].map(([tag, operations]) => {
        const body = h('div', {});
        for (const operation of operations) {
          body.appendChild(operationRow(document_, operation));
        }
        return h(
          'details',
          { open: '' },
          h('summary', { class: 'list-row__label' }, `${tag} (${operations.length})`),
          body,
        );
      }),
    );

    if (document_.operations.length === 0) {
      operationList.replaceChildren(h('div', { class: 'empty-note' }, 'Sin operaciones.'));
    }

    /* --- Esquemas --- */
    schemaList.replaceChildren(
      ...document_.schemas.map((schema) => {
        const fields = h('div', { style: 'padding-left:12px' });
        for (const field of schema.fields) {
          fields.appendChild(
            h(
              'div',
              { class: 'list-row', title: field.description ?? '' },
              h(
                'span',
                { class: 'list-row__label' },
                `${field.name}${field.required ? '' : '?'}`,
              ),
              h(
                'span',
                { class: 'list-row__hint' },
                field.nullable ? `${field.type} | null` : field.type,
              ),
            ),
          );
        }
        return h(
          'details',
          {},
          h(
            'summary',
            { class: 'list-row__label' },
            `${schema.name} (${schema.fields.length})`,
          ),
          fields,
        );
      }),
    );
    if (document_.schemas.length === 0) {
      schemaList.replaceChildren(h('div', { class: 'empty-note' }, 'Sin esquemas declarados.'));
    }
  }

  function operationRow(
    document_: OpenApiDocumentView,
    operation: OpenApiOperation,
  ): HTMLElement {
    const method = h(
      'span',
      {
        class: 'list-row__hint',
        style: `color:${METHOD_TONES[operation.method] ?? 'var(--text-muted)'};font-weight:600;min-width:44px`,
      },
      operation.method.toUpperCase(),
    );
    const row = h(
      'div',
      {
        class: 'list-row',
        title: operation.summary ?? operation.id,
        style: operation.deprecated ? 'text-decoration:line-through;opacity:0.6' : '',
      },
      method,
      h('span', { class: 'list-row__label' }, operation.path),
    );
    // Un clic lleva a la linea de la operacion dentro del propio documento.
    row.addEventListener('click', () => void openFile(document_.path, operation.line));
    return row;
  }

  void load();
}

/* -------------------------------------------------------------------------- */
/*  Panel: auditoria de contratos                                              */
/* -------------------------------------------------------------------------- */

const CHANGE_LABELS: Readonly<Record<BreakingChange['kind'], string>> = {
  'removed-export': 'Export eliminado',
  'removed-field': 'Campo eliminado',
  'required-field-added': 'Campo obligatorio nuevo',
  'optional-became-required': 'Opcional ahora obligatorio',
  'type-changed': 'Tipo cambiado',
  'enum-value-removed': 'Variante eliminada',
};

function buildPanel(context: PanelViewContext): void {
  const summary = h('div', { class: 'empty-note' }, 'Ejecuta la auditoria de contratos.');
  const changeList = h('div', { class: 'list' });
  const dependentList = h('div', { class: 'list' });

  const run = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Auditar los contratos compartidos',
    'aria-label': 'Auditar los contratos compartidos',
  });
  run.appendChild(svgIcon(ICONS.check, 13));
  run.addEventListener('click', () => void runCommand('spec.audit'));
  context.actions.appendChild(run);

  const section = (title: string, body: HTMLElement): HTMLElement =>
    h(
      'div',
      { class: 'section' },
      h('div', { class: 'section__header' }, title),
      h('div', { class: 'section__body' }, body),
    );

  context.container.replaceChildren(
    h(
      'div',
      { style: 'overflow:auto;height:100%' },
      summary,
      section('Cambios que rompen', changeList),
      section('Archivos afectados', dependentList),
    ),
  );

  const render = (): void => {
    const report = currentReport;
    if (report === null) {
      summary.textContent = 'Ejecuta la auditoria de contratos.';
      changeList.replaceChildren();
      dependentList.replaceChildren();
      return;
    }

    if (report.changes.length === 0) {
      summary.replaceChildren(
        h(
          'div',
          { style: 'color:var(--state-success)' },
          `${report.path}: ningun cambio rompe a los consumidores frente a ${report.comparedAgainst}.`,
        ),
      );
      changeList.replaceChildren();
      dependentList.replaceChildren();
      return;
    }

    summary.replaceChildren(
      h(
        'div',
        { style: 'color:var(--state-error)' },
        `${report.path}: ${report.changes.length} cambios rompen el tipado frente a ${report.comparedAgainst}.`,
      ),
      h(
        'div',
        { class: 'list-row__hint' },
        `${report.dependents.length} archivos importan alguno de los tipos afectados.`,
      ),
    );

    changeList.replaceChildren(
      ...report.changes.map((change) => {
        const row = h(
          'div',
          { class: 'list-row', title: change.detail },
          h(
            'span',
            { class: 'list-row__hint', style: 'color:var(--state-error);min-width:150px' },
            CHANGE_LABELS[change.kind],
          ),
          h(
            'span',
            { class: 'list-row__label' },
            change.member === undefined ? change.symbol : `${change.symbol}.${change.member}`,
          ),
          h('span', { class: 'list-row__hint' }, change.detail),
        );
        row.addEventListener('click', () => void openFile(report.path, change.line));
        return row;
      }),
    );

    dependentList.replaceChildren(
      ...report.dependents.map((dependent) => {
        const row = h(
          'div',
          { class: 'list-row', title: dependent.symbols.join(', ') },
          h('span', { class: 'list-row__label' }, dependent.path),
          h('span', { class: 'list-row__hint' }, dependent.symbols.join(', ')),
        );
        row.addEventListener('click', () => void openFile(dependent.path, dependent.line));
        return row;
      }),
    );
    if (report.dependents.length === 0) {
      dependentList.replaceChildren(
        h('div', { class: 'empty-note' }, 'Ningun archivo del proyecto importa esos tipos.'),
      );
    }
  };

  reportListeners.add(render);
  render();
}

/* -------------------------------------------------------------------------- */
/*  Registro                                                                   */
/* -------------------------------------------------------------------------- */

export function registerSpecView(): void {
  registerSidebarView('spec', buildSidebar);
  registerPanelView('spec', buildPanel);

  defineCommands([
    {
      id: 'spec.generate',
      title: 'Contratos: generar codigo desde OpenAPI',
      category: 'Contratos',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        const document_ = currentDocument ?? (await loadFirstSpec());
        if (document_ === null) {
          toast('warn', 'No hay ninguna especificacion OpenAPI cargada.');
          return;
        }

        const target = await selectDialog({
          title: 'Que quieres generar',
          items: TARGETS.map((entry) => ({
            id: entry.id,
            label: entry.label,
            hint: entry.hint,
          })),
        });
        if (target === null) {
          return;
        }

        // Primero se calcula sin escribir, para poder ensenar el resultado.
        const preview = await window.forge.spec.generate({
          specPath: document_.path,
          target: target as SpecGenerationTarget,
          write: false,
        });
        if (!preview.ok) {
          toastError('No se pudo generar el codigo.', preview.error);
          return;
        }

        const existing = await window.forge.fileSystem.readFile(preview.value.path);
        openDiff(
          preview.value.path,
          existing.ok ? existing.value.content : '',
          preview.value.content,
          `Generado: ${preview.value.path}`,
        );

        const write = await confirmDialog({
          title: 'Escribir el archivo generado',
          message: `Se va a escribir "${preview.value.path}".`,
          detail: existing.ok
            ? 'El archivo ya existe y se sobrescribira. La pestana abierta muestra las diferencias.'
            : 'Es un archivo nuevo.',
          confirmLabel: 'Escribir',
          danger: existing.ok,
        });
        if (!write) {
          return;
        }

        const written = await window.forge.spec.generate({
          specPath: document_.path,
          target: target as SpecGenerationTarget,
          outputPath: preview.value.path,
          write: true,
        });
        if (!written.ok) {
          toastError('No se pudo escribir el archivo.', written.error);
          return;
        }
        toast('info', `Generado ${written.value.path}.`);
        await openFile(written.value.path);
      },
    },
    {
      id: 'spec.audit',
      title: 'Contratos: auditar cambios que rompen',
      category: 'Contratos',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        const targets = await window.forge.spec.auditTargets();
        if (!targets.ok) {
          toastError('No se pudieron listar los contratos.', targets.error);
          return;
        }
        if (targets.value.length === 0) {
          toast('info', 'Este proyecto no tiene modulos en src/shared/.');
          return;
        }

        const choice =
          targets.value.length === 1
            ? targets.value[0]
            : await selectDialog({
                title: 'Que contrato auditar',
                items: targets.value.map((path) => ({ id: path, label: path })),
              });
        if (choice === null || choice === undefined) {
          return;
        }

        const report = await window.forge.spec.audit(choice);
        if (!report.ok) {
          toastError('La auditoria fallo.', report.error);
          return;
        }
        setReport(report.value);
        store.patch({ panelView: 'spec', panelVisible: true });

        if (report.value.changes.length === 0) {
          toast('info', `${choice}: ningun cambio rompe el tipado.`);
          return;
        }
        toast(
          'warn',
          `${report.value.changes.length} cambios rompen el tipado en ${choice}.`,
          `${report.value.dependents.length} archivos consumen los tipos afectados.`,
        );
      },
    },
    {
      id: 'spec.open',
      title: 'Contratos: abrir la especificacion OpenAPI',
      category: 'Contratos',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        const document_ = currentDocument ?? (await loadFirstSpec());
        if (document_ === null) {
          toast('warn', 'No se encontro ninguna especificacion.');
          return;
        }
        await openFile(document_.path);
      },
    },
  ]);
}

/** Carga la primera especificacion detectada; `null` si no hay ninguna. */
async function loadFirstSpec(): Promise<OpenApiDocumentView | null> {
  const found = await window.forge.spec.discover();
  const first = found.ok ? found.value[0] : undefined;
  if (first === undefined) {
    return null;
  }
  const parsed = await window.forge.spec.parse(first);
  if (!parsed.ok) {
    toastError('No se pudo leer la especificacion.', parsed.error);
    return null;
  }
  currentDocument = parsed.value;
  return parsed.value;
}
