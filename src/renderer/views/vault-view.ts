/**
 * Forge Vault: editor tabular de variables de entorno.
 *
 * Una tabla por archivo, con el valor enmascarado si es sensible y un boton
 * para revelarlo bajo peticion. Los avisos (claves que faltan respecto al
 * ejemplo, formatos raros, marcadores sin sustituir) se listan aparte y son
 * clicables hasta la linea del archivo.
 *
 * Todo lo que sale de aqui pasa por `core/dialogs.ts`: no hay ningun
 * `prompt` ni `confirm` del navegador, que en Electron o no existen o
 * bloquean el hilo.
 */

import { append, h, svgIcon, copyToClipboard } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { confirmDialog, promptDialog } from '../core/dialogs.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import { registerSidebarView, type SidebarViewContext } from './sidebar.js';
import { openFile } from './editor-area.js';
import type { EnvIssue, VaultFileView, VaultVariable } from '../../shared/contracts.js';

const SEVERITY_TONES: Readonly<Record<EnvIssue['severity'], string>> = {
  error: 'var(--state-error)',
  warning: 'var(--state-warning)',
  info: 'var(--text-muted)',
};

/** Claves reveladas en esta sesion; se olvidan al recargar la vista. */
const revealed = new Map<string, string>();

function revealKey(file: string, key: string): string {
  return `${file}::${key}`;
}

/* -------------------------------------------------------------------------- */
/*  Vista                                                                      */
/* -------------------------------------------------------------------------- */

function buildSidebar(context: SidebarViewContext): void {
  const status = h('div', { class: 'empty-note' }, 'Cargando variables de entorno…');
  const body = h('div', {});
  const issueList = h('div', { class: 'list' });

  const reload = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Recargar',
    'aria-label': 'Recargar',
  });
  reload.appendChild(svgIcon(ICONS.refresh, 13));
  reload.addEventListener('click', () => void load());

  const add = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Anadir una variable',
    'aria-label': 'Anadir una variable',
  });
  add.appendChild(svgIcon(ICONS.plus, 13));
  add.addEventListener('click', () => void runCommand('vault.addVariable'));

  const sync = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Actualizar .env.example con las claves actuales',
    'aria-label': 'Actualizar .env.example',
  });
  sync.appendChild(svgIcon(ICONS.copy, 13));
  sync.addEventListener('click', () => void runCommand('vault.syncExample'));

  context.actions.append(add, sync, reload);
  context.container.replaceChildren(
    status,
    body,
    h(
      'div',
      { class: 'section' },
      h('div', { class: 'section__header' }, 'Avisos'),
      h('div', { class: 'section__body' }, issueList),
    ),
  );

  async function load(): Promise<void> {
    const result = await window.forge.vault.read();
    if (!result.ok) {
      status.textContent = result.error.message;
      return;
    }
    revealed.clear();
    store.patch({ vault: result.value });
  }

  const render = (): void => {
    const view = store.state.vault;
    if (view === null) {
      return;
    }

    if (view.files.length === 0) {
      status.textContent = 'Este proyecto no tiene ningun archivo .env.';
      body.replaceChildren();
      issueList.replaceChildren();
      return;
    }

    status.replaceChildren(
      h(
        'div',
        { class: 'list-row__hint' },
        view.secureStorageAvailable
          ? `${view.vaultKeys.length} secretos en el almacen cifrado del sistema.`
          : 'El sistema no ofrece cifrado: no se pueden guardar secretos.',
      ),
    );

    body.replaceChildren(...view.files.map((file) => fileSection(file, view.vaultKeys)));
    renderIssues(view.issues);
  };

  function fileSection(file: VaultFileView, vaultKeys: readonly string[]): HTMLElement {
    const table = h('table', { class: 'kv-table' });
    const head = h(
      'tr',
      {},
      h('th', {}, 'Clave'),
      h('th', {}, 'Valor'),
      h('th', { style: 'width:96px' }, ''),
    );
    table.appendChild(head);

    for (const variable of file.variables) {
      table.appendChild(variableRow(file, variable));
    }
    if (file.variables.length === 0) {
      table.appendChild(
        h('tr', {}, h('td', { colspan: '3' }, h('div', { class: 'empty-note' }, 'Vacio.'))),
      );
    }

    const title = h(
      'div',
      { class: 'section__header' },
      file.path,
      file.isExample ? h('span', { class: 'section__count' }, 'ejemplo') : null,
    );
    title.addEventListener('click', () => void openFile(file.path));

    const inVault = vaultKeys.length > 0 && !file.isExample;
    return h(
      'div',
      { class: 'section' },
      title,
      h(
        'div',
        { class: 'section__body' },
        table,
        inVault
          ? h(
              'div',
              { class: 'list-row__hint', style: 'padding:4px 8px' },
              `${vaultKeys.length} claves adicionales se inyectan cifradas al lanzar procesos.`,
            )
          : null,
      ),
    );
  }

  function variableRow(file: VaultFileView, variable: VaultVariable): HTMLElement {
    const cacheKey = revealKey(file.path, variable.key);
    const shown = revealed.get(cacheKey);

    const valueCell = h('td', { style: 'font-family:var(--font-mono);word-break:break-all' });
    valueCell.textContent = shown ?? variable.value;
    if (variable.value === '') {
      valueCell.textContent = '(vacio)';
      valueCell.style.color = 'var(--text-subtle)';
    }

    const actions = h('td', { style: 'white-space:nowrap' });

    if (variable.secret) {
      const eye = h('button', {
        class: 'icon-btn',
        type: 'button',
        title: shown === undefined ? 'Revelar el valor' : 'Ocultar el valor',
        'aria-label': shown === undefined ? 'Revelar el valor' : 'Ocultar el valor',
      });
      eye.appendChild(svgIcon(shown === undefined ? ICONS.eye : ICONS.eyeOff, 12));
      eye.addEventListener('click', () => {
        if (shown !== undefined) {
          revealed.delete(cacheKey);
          render();
          return;
        }
        void window.forge.vault.reveal(file.path, variable.key).then((result) => {
          if (!result.ok) {
            toastError('No se pudo revelar el valor.', result.error);
            return;
          }
          revealed.set(cacheKey, result.value);
          render();
        });
      });
      actions.appendChild(eye);

      // Promover solo tiene sentido sobre archivos reales, no sobre el
      // ejemplo, que por definicion no guarda valores.
      if (!file.isExample) {
        const promote = h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Cifrar en el almacen del sistema y quitar del archivo',
          'aria-label': 'Cifrar en el almacen del sistema',
        });
        promote.appendChild(svgIcon(ICONS.lock, 12));
        promote.addEventListener('click', () => void promoteVariable(file.path, variable.key));
        actions.appendChild(promote);
      }
    }

    const copy = h('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Copiar el valor',
      'aria-label': 'Copiar el valor',
    });
    copy.appendChild(svgIcon(ICONS.copy, 12));
    copy.addEventListener('click', () => void copyValue(file.path, variable));
    actions.appendChild(copy);

    const edit = h('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Editar el valor',
      'aria-label': 'Editar el valor',
    });
    edit.appendChild(svgIcon(ICONS.settings, 12));
    edit.addEventListener('click', () => void editVariable(file.path, variable));
    actions.appendChild(edit);

    const remove = h('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Eliminar la variable',
      'aria-label': 'Eliminar la variable',
    });
    remove.appendChild(svgIcon(ICONS.trash, 12));
    remove.addEventListener('click', () => void removeVariable(file.path, variable.key));
    actions.appendChild(remove);

    const keyCell = h('td', { title: variable.comment ?? variable.format });
    append(
      keyCell,
      h('span', { style: 'font-family:var(--font-mono)' }, variable.key),
      variable.format === 'text'
        ? null
        : h('span', { class: 'section__count', style: 'margin-left:6px' }, variable.format),
    );
    keyCell.addEventListener('click', () => void openFile(file.path, variable.line));

    return h('tr', {}, keyCell, valueCell, actions);
  }

  function renderIssues(issues: readonly EnvIssue[]): void {
    if (issues.length === 0) {
      issueList.replaceChildren(
        h('div', { class: 'empty-note' }, 'Sin avisos: el entorno esta completo y bien formado.'),
      );
      return;
    }
    issueList.replaceChildren(
      ...issues.map((issue) => {
        const row = h(
          'div',
          { class: 'list-row', title: issue.message },
          h(
            'span',
            { class: 'list-row__hint', style: `color:${SEVERITY_TONES[issue.severity]};min-width:90px` },
            issue.kind,
          ),
          h('span', { class: 'list-row__label' }, issue.key),
          h('span', { class: 'list-row__hint' }, issue.message),
        );
        row.addEventListener('click', () => void openFile(issue.file));
        return row;
      }),
    );
  }

  store.subscribe(['vault'], render);
  void load();
}

/* -------------------------------------------------------------------------- */
/*  Acciones                                                                   */
/* -------------------------------------------------------------------------- */

/** Valor real de una variable: revelado si es secreta, tal cual si no. */
async function actualValue(file: string, variable: VaultVariable): Promise<string | null> {
  if (!variable.secret) {
    return variable.value;
  }
  const cached = revealed.get(revealKey(file, variable.key));
  if (cached !== undefined) {
    return cached;
  }
  const result = await window.forge.vault.reveal(file, variable.key);
  if (!result.ok) {
    toastError('No se pudo leer el valor.', result.error);
    return null;
  }
  return result.value;
}

async function copyValue(file: string, variable: VaultVariable): Promise<void> {
  const value = await actualValue(file, variable);
  if (value === null) {
    return;
  }
  // `copyToClipboard` informa del fallo: `navigator.clipboard` rechaza en
  // silencio si el documento no tiene foco.
  const copied = await copyToClipboard(value);
  toast(
    copied ? 'info' : 'warn',
    copied ? `Copiado el valor de ${variable.key}.` : 'No se pudo copiar al portapapeles.',
  );
}

async function editVariable(file: string, variable: VaultVariable): Promise<void> {
  const current = await actualValue(file, variable);
  if (current === null) {
    return;
  }
  const next = await promptDialog({
    title: `Editar ${variable.key}`,
    label: 'Valor',
    value: current,
    detail: variable.comment ?? `Formato esperado: ${variable.format}.`,
    secret: variable.secret,
    // Se valida en el propio modal, sin cerrarlo, para no perder lo escrito.
    validate: () => null,
  });
  if (next === null) {
    return;
  }
  await applyEdits(file, [{ key: variable.key, value: next }]);
}

async function removeVariable(file: string, key: string): Promise<void> {
  const confirmed = await confirmDialog({
    title: 'Eliminar la variable',
    message: `Se quitara "${key}" de ${file}.`,
    detail: 'El resto del archivo, comentarios incluidos, se conserva.',
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  await applyEdits(file, [{ key, value: null }]);
}

async function promoteVariable(file: string, key: string): Promise<void> {
  const confirmed = await confirmDialog({
    title: 'Cifrar en el almacen del sistema',
    message: `"${key}" se cifrara con el almacen del sistema operativo.`,
    detail:
      'La linea desaparecera de ' +
      file +
      '. El valor seguira llegando a los procesos que lance el IDE.',
    confirmLabel: 'Cifrar y quitar del archivo',
  });
  if (!confirmed) {
    return;
  }
  const result = await window.forge.vault.promote(file, key);
  if (!result.ok) {
    toastError('No se pudo cifrar el secreto.', result.error);
    return;
  }
  store.patch({ vault: result.value });
  revealed.delete(revealKey(file, key));
  toast('info', `"${key}" se guardo cifrado y salio de ${file}.`);
}

async function applyEdits(
  file: string,
  edits: readonly { key: string; value: string | null }[],
): Promise<void> {
  const result = await window.forge.vault.write({ path: file, edits });
  if (!result.ok) {
    toastError('No se pudo escribir el archivo de entorno.', result.error);
    return;
  }
  revealed.clear();
  store.patch({ vault: result.value });
}

/* -------------------------------------------------------------------------- */
/*  Registro                                                                   */
/* -------------------------------------------------------------------------- */

export function registerVaultView(): void {
  registerSidebarView('vault', buildSidebar);

  defineCommands([
    {
      id: 'vault.open',
      title: 'Vault: abrir el editor de entorno',
      category: 'Entorno',
      run: () => store.patch({ sidebarView: 'vault', sidebarVisible: true }),
    },
    {
      id: 'vault.addVariable',
      title: 'Vault: anadir una variable',
      category: 'Entorno',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        const view = store.state.vault;
        const target = view?.files.find((file) => !file.isExample)?.path ?? '.env';

        const key = await promptDialog({
          title: 'Nueva variable de entorno',
          label: 'Nombre',
          detail: `Se anadira a ${target}.`,
          validate: (value) =>
            /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value)
              ? null
              : 'Solo letras, digitos, guion bajo y punto, sin empezar por digito.',
        });
        if (key === null) {
          return;
        }

        const value = await promptDialog({
          title: `Valor de ${key}`,
          label: 'Valor',
          validate: () => null,
        });
        if (value === null) {
          return;
        }
        await applyEdits(target, [{ key, value }]);
        toast('info', `Anadida ${key} a ${target}.`);
      },
    },
    {
      id: 'vault.syncExample',
      title: 'Vault: actualizar .env.example',
      category: 'Entorno',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        const confirmed = await confirmDialog({
          title: 'Actualizar el archivo de ejemplo',
          message: 'Se anadiran a .env.example las claves que falten.',
          detail: 'Los valores sensibles se dejan VACIOS: nunca se copian al ejemplo.',
          confirmLabel: 'Actualizar',
        });
        if (!confirmed) {
          return;
        }
        const result = await window.forge.vault.syncExample();
        if (!result.ok) {
          toastError('No se pudo actualizar el ejemplo.', result.error);
          return;
        }
        store.patch({ vault: result.value });
        toast('info', 'El archivo de ejemplo esta al dia.');
      },
    },
    {
      id: 'vault.addSecret',
      title: 'Vault: guardar un secreto cifrado',
      category: 'Entorno',
      enabled: () => store.state.workspace !== null,
      run: async () => {
        if (store.state.vault?.secureStorageAvailable === false) {
          toast(
            'error',
            'El sistema no ofrece cifrado.',
            'No se guardara nada: dejarlo en claro seria peor.',
          );
          return;
        }
        const key = await promptDialog({
          title: 'Nuevo secreto cifrado',
          label: 'Nombre de la variable',
          detail: 'Se cifrara con el almacen del sistema y no tocara ningun archivo.',
          validate: (value) =>
            /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value) ? null : 'Nombre de variable no valido.',
        });
        if (key === null) {
          return;
        }
        const value = await promptDialog({
          title: `Valor de ${key}`,
          label: 'Valor',
          secret: true,
        });
        if (value === null) {
          return;
        }
        const result = await window.forge.vault.setSecret(key, value);
        if (!result.ok) {
          toastError('No se pudo guardar el secreto.', result.error);
          return;
        }
        const view = await window.forge.vault.read();
        if (view.ok) {
          store.patch({ vault: view.value });
        }
        toast('info', `"${key}" guardado cifrado.`);
      },
    },
    {
      id: 'vault.deleteSecret',
      title: 'Vault: eliminar un secreto cifrado',
      category: 'Entorno',
      enabled: () => (store.state.vault?.vaultKeys.length ?? 0) > 0,
      run: async () => {
        const keys = store.state.vault?.vaultKeys ?? [];
        const key = await promptDialog({
          title: 'Eliminar un secreto cifrado',
          label: 'Nombre de la variable',
          detail: `Guardados: ${keys.join(', ')}.`,
          validate: (value) =>
            keys.includes(value) ? null : 'Ese nombre no esta en el almacen.',
        });
        if (key === null) {
          return;
        }
        const result = await window.forge.vault.deleteSecret(key);
        if (!result.ok) {
          toastError('No se pudo eliminar el secreto.', result.error);
          return;
        }
        const view = await window.forge.vault.read();
        if (view.ok) {
          store.patch({ vault: view.value });
        }
        toast('info', `"${key}" eliminado del almacen.`);
      },
    },
  ]);
}
