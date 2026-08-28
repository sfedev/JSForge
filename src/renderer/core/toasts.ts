/** Notificaciones efimeras de la esquina inferior derecha. */

import { h, svgIcon } from './dom.js';
import { ICONS } from './icons.js';

let host: HTMLElement | null = null;

const DEFAULT_TIMEOUT_MS = 6000;
const ERROR_TIMEOUT_MS = 12_000;

export function mountToasts(container: HTMLElement): void {
  host = container;
}

export type ToastLevel = 'info' | 'warn' | 'error';

export function toast(level: ToastLevel, message: string, detail?: string): void {
  if (host === null) {
    console.log(`[forge:${level}] ${message}${detail === undefined ? '' : ` — ${detail}`}`);
    return;
  }
  const iconName = level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info';
  const body = h('div', { class: 'toast__body' }, h('div', {}, message));
  if (detail !== undefined && detail !== '') {
    body.appendChild(h('div', { class: 'toast__detail' }, detail));
  }

  const element = h('div', { class: 'toast', 'data-level': level, role: 'alert' });
  const icon = svgIcon(ICONS[iconName]);
  icon.setAttribute(
    'style',
    `color: var(--state-${level === 'warn' ? 'warning' : level}); flex: 0 0 auto;`,
  );
  element.append(icon, body);

  const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Descartar' });
  close.appendChild(svgIcon(ICONS.close, 14));
  close.addEventListener('click', () => element.remove());
  element.appendChild(close);

  host.appendChild(element);

  const timeout = level === 'error' ? ERROR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  window.setTimeout(() => {
    element.remove();
  }, timeout);

  // Como maximo cinco visibles: mas que eso es ruido, no informacion.
  while (host.childElementCount > 5) {
    host.firstElementChild?.remove();
  }
}

/** Atajo para reportar un `ForgeError` devuelto por el puente. */
export function toastError(message: string, error: { message: string; detail?: string }): void {
  toast('error', message, error.detail === undefined ? error.message : `${error.message} (${error.detail})`);
}
