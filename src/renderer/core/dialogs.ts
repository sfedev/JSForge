/**
 * Dialogos del IDE.
 *
 * Electron NO implementa `window.prompt()`: llamarlo lanza
 * «prompt() is not supported». Y `window.confirm()`, aunque funciona, bloquea
 * el hilo del renderer y muestra un cuadro del sistema que rompe el tema.
 *
 * Este modulo los sustituye por dialogos propios, asincronos y con las
 * mismas garantias de siempre: el texto se inserta con `textContent`, nunca
 * con `innerHTML`.
 */

import { h, svgIcon } from './dom.js';
import { ICONS } from './icons.js';

let host: HTMLElement | null = null;

export function mountDialogs(overlays: HTMLElement): void {
  host = overlays;
}

/** Cierra el dialogo devolviendo un valor. */
type Resolver<T> = (value: T) => void;

interface DialogParts<T> {
  readonly title: string;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  readonly cancelValue: T;
  /** Se invoca al abrir, para poner el foco donde toque. */
  readonly onOpen?: () => void;
  /** Enter dentro del dialogo: devuelve el valor a resolver, o `undefined`. */
  readonly onEnter?: () => T | undefined;
}

/** Armazon comun: overlay, escape, clic fuera y limpieza. */
function present<T>(parts: DialogParts<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    if (host === null) {
      resolve(parts.cancelValue);
      return;
    }

    const dialog = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': parts.title, style: 'width:min(520px,92vw)' },
      h('div', { class: 'dialog__header' }, parts.title),
      parts.body,
      parts.footer,
    );
    const overlay = h('div', { class: 'overlay overlay--center' }, dialog);

    // El foco vuelve a donde estaba al cerrar; si no, se pierde en el body.
    const previouslyFocused = document.activeElement;

    let settled = false;
    const finish: Resolver<T> = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
      resolve(value);
    };

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(parts.cancelValue);
        return;
      }
      if (event.key === 'Enter' && parts.onEnter !== undefined) {
        // En un textarea, Enter escribe una linea; solo confirma con Ctrl.
        const target = event.target;
        const isTextarea = target instanceof HTMLTextAreaElement;
        if (isTextarea && !event.ctrlKey && !event.metaKey) {
          return;
        }
        const value = parts.onEnter();
        if (value !== undefined) {
          event.preventDefault();
          finish(value);
        }
      }
    }

    // En captura: el dialogo tiene prioridad sobre los atajos globales.
    document.addEventListener('keydown', onKeyDown, true);

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) {
        finish(parts.cancelValue);
      }
    });

    // Se expone el cierre a los botones del pie.
    (dialog as HTMLElement & { __finish?: Resolver<T> }).__finish = finish;

    host.appendChild(overlay);
    parts.onOpen?.();
  });
}

function button(label: string, variant: 'primary' | 'ghost' | 'danger'): HTMLButtonElement {
  const classes =
    variant === 'primary' ? 'btn btn--primary' : variant === 'danger' ? 'btn btn--danger btn--ghost' : 'btn btn--ghost';
  return h('button', { class: classes, type: 'button' }, label) as HTMLButtonElement;
}

/* -------------------------------------------------------------------------- */
/*  Entrada de texto                                                           */
/* -------------------------------------------------------------------------- */

export interface PromptOptions {
  readonly title: string;
  /** Etiqueta del campo. */
  readonly label?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly detail?: string;
  readonly confirmLabel?: string;
  /** Oculta lo escrito; para claves API. */
  readonly secret?: boolean;
  readonly multiline?: boolean;
  /** Devuelve un mensaje de error, o `null` si el valor es valido. */
  readonly validate?: (value: string) => string | null;
}

/** Sustituto de `window.prompt`. Resuelve `null` si se cancela. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  const input = options.multiline === true
    ? (h('textarea', {
        class: 'textarea',
        rows: '4',
        placeholder: options.placeholder ?? '',
        'aria-label': options.label ?? options.title,
      }) as HTMLTextAreaElement)
    : (h('input', {
        class: options.secret === true ? 'input' : 'input input--mono',
        type: options.secret === true ? 'password' : 'text',
        placeholder: options.placeholder ?? '',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': options.label ?? options.title,
      }) as HTMLInputElement);

  input.value = options.value ?? '';

  const error = h('div', { style: 'color:var(--state-error);font-size:var(--font-size-xs);min-height:14px' });

  const body = h('div', { class: 'dialog__body' });
  if (options.detail !== undefined) {
    body.appendChild(h('div', { class: 'list-row__hint' }, options.detail));
  }
  const field = h('div', { class: 'field' });
  if (options.label !== undefined) {
    field.appendChild(h('span', { class: 'field__label' }, options.label));
  }
  field.append(input, error);
  body.appendChild(field);

  /** Valida y devuelve el valor, o `undefined` si no es aceptable. */
  const evaluate = (): string | undefined => {
    const value = input.value.trim();
    const message = options.validate?.(value) ?? (value === '' ? 'Escribe un valor.' : null);
    if (message !== null) {
      error.textContent = message;
      input.focus();
      return undefined;
    }
    return value;
  };

  const cancel = button('Cancelar', 'ghost');
  const accept = button(options.confirmLabel ?? 'Aceptar', 'primary');
  const footer = h('div', { class: 'dialog__footer' }, cancel, accept);

  input.addEventListener('input', () => {
    error.textContent = '';
  });

  const promise = present<string | null>({
    title: options.title,
    body,
    footer,
    cancelValue: null,
    onOpen: () => {
      input.focus();
      if (input instanceof HTMLInputElement) {
        input.select();
      }
    },
    onEnter: () => evaluate(),
  });

  const finish = (value: string | null): void => {
    const dialog = footer.parentElement as (HTMLElement & { __finish?: Resolver<string | null> }) | null;
    dialog?.__finish?.(value);
  };
  cancel.addEventListener('click', () => finish(null));
  accept.addEventListener('click', () => {
    const value = evaluate();
    if (value !== undefined) {
      finish(value);
    }
  });

  return promise;
}

/* -------------------------------------------------------------------------- */
/*  Confirmacion                                                               */
/* -------------------------------------------------------------------------- */

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly detail?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Pinta la accion como destructiva. */
  readonly danger?: boolean;
}

/** Sustituto de `window.confirm`, sin bloquear el hilo. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const body = h('div', { class: 'dialog__body' });
  const row = h('div', { style: 'display:flex;gap:10px;align-items:flex-start' });
  const icon = svgIcon(options.danger === true ? ICONS.warning : ICONS.info, 18);
  icon.setAttribute(
    'style',
    `color: var(--state-${options.danger === true ? 'warning' : 'info'}); flex: 0 0 auto; margin-top: 2px;`,
  );
  const text = h('div', {}, h('div', {}, options.message));
  if (options.detail !== undefined) {
    text.appendChild(h('div', { class: 'list-row__hint', style: 'margin-top:4px' }, options.detail));
  }
  row.append(icon, text);
  body.appendChild(row);

  const cancel = button(options.cancelLabel ?? 'Cancelar', 'ghost');
  const accept = button(options.confirmLabel ?? 'Aceptar', options.danger === true ? 'danger' : 'primary');
  const footer = h('div', { class: 'dialog__footer' }, cancel, accept);

  const promise = present<boolean>({
    title: options.title,
    body,
    footer,
    cancelValue: false,
    onOpen: () => accept.focus(),
    onEnter: () => true,
  });

  const finish = (value: boolean): void => {
    const dialog = footer.parentElement as (HTMLElement & { __finish?: Resolver<boolean> }) | null;
    dialog?.__finish?.(value);
  };
  cancel.addEventListener('click', () => finish(false));
  accept.addEventListener('click', () => finish(true));

  return promise;
}

/* -------------------------------------------------------------------------- */
/*  Seleccion de una lista                                                     */
/* -------------------------------------------------------------------------- */

export interface SelectItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** Marca el elemento actual (por ejemplo, la rama activa). */
  readonly current?: boolean;
}

export interface SelectOptions {
  readonly title: string;
  readonly items: readonly SelectItem[];
  readonly placeholder?: string;
  readonly emptyMessage?: string;
}

/**
 * Selector filtrable. Sustituye a los `prompt` que listaban opciones en el
 * mensaje y obligaban a teclear el nombre exacto.
 */
export function selectDialog(options: SelectOptions): Promise<string | null> {
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: options.placeholder ?? 'Filtrar…',
    spellcheck: 'false',
    'aria-label': options.title,
  }) as HTMLInputElement;

  const list = h('div', { class: 'palette__list', style: 'max-height:40vh;padding:0' });

  let filtered = [...options.items];
  let active = Math.max(0, filtered.findIndex((item) => item.current === true));

  const body = h('div', { class: 'dialog__body' }, search, list);

  const cancel = button('Cancelar', 'ghost');
  const footer = h('div', { class: 'dialog__footer' }, cancel);

  const finish = (value: string | null): void => {
    const dialog = footer.parentElement as (HTMLElement & { __finish?: Resolver<string | null> }) | null;
    dialog?.__finish?.(value);
  };

  function paint(): void {
    list.replaceChildren();
    if (filtered.length === 0) {
      list.appendChild(
        h('div', { class: 'empty-note' }, options.emptyMessage ?? 'Sin coincidencias.'),
      );
      return;
    }
    filtered.forEach((item, index) => {
      const row = h('div', {
        class: 'palette__item',
        role: 'option',
        'data-active': String(index === active),
        'aria-selected': String(index === active),
      });
      row.appendChild(h('span', {}, item.label));
      if (item.current === true) {
        row.appendChild(h('span', { class: 'chip', style: 'margin-left:6px' }, 'actual'));
      }
      if (item.hint !== undefined) {
        row.appendChild(h('span', { class: 'palette__item-hint' }, item.hint));
      }
      row.addEventListener('mouseenter', () => {
        active = index;
        paint();
      });
      row.addEventListener('click', () => finish(item.id));
      list.appendChild(row);
    });
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  search.addEventListener('input', () => {
    const needle = search.value.trim().toLowerCase();
    filtered = options.items.filter(
      (item) =>
        needle === '' ||
        item.label.toLowerCase().includes(needle) ||
        (item.hint ?? '').toLowerCase().includes(needle),
    );
    active = 0;
    paint();
  });

  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
      paint();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      paint();
    }
  });

  const promise = present<string | null>({
    title: options.title,
    body,
    footer,
    cancelValue: null,
    onOpen: () => {
      search.focus();
      paint();
    },
    onEnter: () => filtered[active]?.id,
  });

  cancel.addEventListener('click', () => finish(null));
  return promise;
}
