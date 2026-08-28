/**
 * Preferencias del IDE.
 *
 * Los cambios se aplican al instante y se persisten en el proceso principal;
 * no hay boton de guardar porque no hay estado intermedio que confirmar.
 */

import { h } from '../core/dom.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import type { AiProviderId, ForgeSettings, ThemeId } from '../../shared/contracts.js';

let overlaysHost: HTMLElement | null = null;
let openOverlay: HTMLElement | null = null;

const THEMES: readonly { id: ThemeId; label: string }[] = [
  { id: 'forge-dark', label: 'Oscuro (DotForge)' },
  { id: 'forge-light', label: 'Claro' },
  { id: 'forge-high-contrast', label: 'Alto contraste' },
];

export function registerSettingsView(overlays: HTMLElement): void {
  overlaysHost = overlays;

  defineCommands([
    {
      id: 'settings.open',
      title: 'Abrir las preferencias',
      category: 'Aplicacion',
      run: () => open(),
    },
    {
      id: 'settings.openFile',
      title: 'Abrir el archivo de preferencias',
      category: 'Aplicacion',
      run: async () => {
        const info = await window.forge.app.info();
        if (info.ok) {
          toast('info', 'Las preferencias se guardan en:', `${info.value.userDataPath}\\settings.json`);
        }
      },
    },
  ]);
}

/** Aplica un cambio y refleja el resultado en el store. */
async function update(patch: Partial<ForgeSettings>): Promise<void> {
  const result = await window.forge.settings.set(patch);
  if (!result.ok) {
    toastError('No se pudo guardar la preferencia.', result.error);
    return;
  }
  store.patch({ settings: result.value });
  if (patch.theme !== undefined) {
    document.documentElement.dataset['theme'] = patch.theme;
  }
  if (patch.fontFamily !== undefined) {
    document.documentElement.style.setProperty('--font-mono', patch.fontFamily);
  }
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const element = h('div', { class: 'field' });
  element.appendChild(h('span', { class: 'field__label' }, label));
  element.appendChild(control);
  if (hint !== undefined) {
    element.appendChild(h('span', { class: 'list-row__hint' }, hint));
  }
  return element;
}

function selectField<T extends string>(
  label: string,
  value: T,
  choices: readonly { id: T; label: string }[],
  onChange: (value: T) => void,
  hint?: string,
): HTMLElement {
  const select = h('select', { class: 'select', 'aria-label': label }) as HTMLSelectElement;
  for (const choice of choices) {
    select.appendChild(h('option', { value: choice.id }, choice.label));
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value as T));
  return field(label, select, hint);
}

function toggleField(
  label: string,
  value: boolean,
  onChange: (value: boolean) => void,
  hint?: string,
): HTMLElement {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));

  const wrapper = h('div', { class: 'field' });
  wrapper.appendChild(h('label', { class: 'checkbox' }, input, label));
  if (hint !== undefined) {
    wrapper.appendChild(h('span', { class: 'list-row__hint' }, hint));
  }
  return wrapper;
}

function numberField(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (value: number) => void,
): HTMLElement {
  const input = h('input', {
    class: 'input',
    type: 'number',
    min: String(min),
    max: String(max),
    'aria-label': label,
  }) as HTMLInputElement;
  input.value = String(value);
  input.addEventListener('change', () => {
    const parsed = Number.parseInt(input.value, 10);
    if (Number.isFinite(parsed)) {
      onChange(Math.min(max, Math.max(min, parsed)));
    }
  });
  return field(label, input);
}

function open(): void {
  if (overlaysHost === null) {
    return;
  }
  openOverlay?.remove();

  const settings = store.state.settings;
  const providers = store.state.aiProviders;

  const body = h('div', { class: 'dialog__body', style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' });

  /* --- Apariencia --- */
  const appearance = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  appearance.appendChild(h('div', { class: 'section__header', style: 'cursor:default' }, 'Apariencia'));
  appearance.appendChild(
    selectField('Tema', settings.theme, THEMES, (theme) => void update({ theme })),
  );
  appearance.appendChild(
    field(
      'Fuente del editor',
      (() => {
        const input = h('input', { class: 'input input--mono', type: 'text', 'aria-label': 'Fuente' }) as HTMLInputElement;
        input.value = settings.fontFamily;
        input.addEventListener('change', () => void update({ fontFamily: input.value }));
        return input;
      })(),
      'Se aplica al editor y a la terminal.',
    ),
  );
  appearance.appendChild(numberField('Tamano de fuente', settings.fontSize, 8, 40, (fontSize) => void update({ fontSize })));
  appearance.appendChild(numberField('Tamano de tabulacion', settings.tabSize, 1, 8, (tabSize) => void update({ tabSize })));
  appearance.appendChild(
    toggleField('Minimapa', settings.minimap, (minimap) => void update({ minimap })),
  );
  appearance.appendChild(
    toggleField('Ajuste de linea', settings.wordWrap, (wordWrap) => void update({ wordWrap })),
  );
  appearance.appendChild(
    toggleField(
      'Resaltado semantico',
      settings.semanticHighlighting,
      (semanticHighlighting) => void update({ semanticHighlighting }),
      'Usa los tokens del servidor de lenguaje en vez de solo la gramatica.',
    ),
  );

  /* --- Editor y herramientas --- */
  const tooling = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  tooling.appendChild(h('div', { class: 'section__header', style: 'cursor:default' }, 'Editor y herramientas'));
  tooling.appendChild(
    toggleField('Formatear al guardar', settings.formatOnSave, (formatOnSave) => void update({ formatOnSave })),
  );
  tooling.appendChild(
    selectField(
      'Formateador',
      settings.formatter,
      [
        { id: 'prettier' as const, label: 'Prettier' },
        { id: 'biome' as const, label: 'Biome' },
        { id: 'none' as const, label: 'Ninguno' },
      ],
      (formatter) => void update({ formatter }),
      'Si el proyecto declara biome.json, Biome tiene prioridad.',
    ),
  );
  tooling.appendChild(
    numberField(
      'Freno de refresco de registros (ms)',
      settings.logThrottleMs,
      50,
      5000,
      (logThrottleMs) => void update({ logThrottleMs }),
    ),
  );

  tooling.appendChild(h('div', { class: 'section__header', style: 'cursor:default' }, 'Forge AI'));
  tooling.appendChild(
    toggleField(
      'Activar Forge AI',
      settings.aiEnabled,
      (aiEnabled) => {
        // Al desactivarla se cierra el panel, para que no quede abierto e inerte.
        void update({ aiEnabled });
        if (!aiEnabled) {
          store.patch({ auxVisible: false });
        }
      },
      'Al desactivarla, el boton de la barra queda inhabilitado y los atajos no responden.',
    ),
  );
  tooling.appendChild(
    selectField(
      'Proveedor',
      settings.aiProvider,
      providers.length > 0
        ? providers.map((provider) => ({ id: provider.id, label: provider.label }))
        : [
            { id: 'anthropic' as AiProviderId, label: 'Anthropic Claude' },
            { id: 'openai' as AiProviderId, label: 'OpenAI' },
            { id: 'ollama' as AiProviderId, label: 'Ollama / LocalAI' },
          ],
      (aiProvider) => void update({ aiProvider }),
    ),
  );
  const keyButton = h('button', {
    class: 'btn btn--ghost btn--sm',
    type: 'button',
    ...(settings.aiEnabled ? {} : { disabled: 'true' }),
  }, 'Configurar la clave API…') as HTMLButtonElement;
  keyButton.disabled = !settings.aiEnabled;
  keyButton.addEventListener('click', () => void runCommand('ai.configureKey'));
  tooling.appendChild(keyButton);

  tooling.appendChild(h('div', { class: 'section__header', style: 'cursor:default' }, 'Actualizaciones'));
  tooling.appendChild(
    selectField(
      'Canal',
      settings.updateChannel,
      [
        { id: 'stable' as const, label: 'Estable' },
        { id: 'beta' as const, label: 'Beta' },
        { id: 'nightly' as const, label: 'Nightly' },
      ],
      (updateChannel) => {
        void window.forge.updater.setChannel(updateChannel).then((result) => {
          if (result.ok) {
            store.patch({ updater: result.value });
          }
        });
        void update({ updateChannel });
      },
    ),
  );
  tooling.appendChild(
    toggleField(
      'Instalar automaticamente al salir',
      settings.autoInstallUpdates,
      (autoInstallUpdates) => void update({ autoInstallUpdates }),
    ),
  );

  body.append(appearance, tooling);

  const close = h('button', { class: 'btn btn--primary', type: 'button' }, 'Cerrar');
  const overlay = h(
    'div',
    { class: 'overlay overlay--center' },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-label': 'Preferencias', style: 'width:min(860px,94vw)' },
      h('div', { class: 'dialog__header' }, 'Preferencias de ForgeJS IDE'),
      body,
      h('div', { class: 'dialog__footer' }, close),
    ),
  );

  const dismiss = (): void => {
    overlay.remove();
    openOverlay = null;
  };
  close.addEventListener('click', dismiss);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      dismiss();
    }
  });

  overlaysHost.appendChild(overlay);
  openOverlay = overlay;
}
