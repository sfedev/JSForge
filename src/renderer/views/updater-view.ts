/**
 * Interfaz del actualizador.
 *
 * El aviso es deliberadamente discreto: un elemento en la barra de estado,
 * nunca un modal que interrumpa. El modal solo aparece cuando el usuario
 * pulsa, y muestra las notas de version antes de decidir.
 */

import { h, formatBytes } from '../core/dom.js';
import { defineCommands } from '../core/commands.js';
import { store } from '../core/store.js';
import { toast, toastError } from '../core/toasts.js';
import type { UpdateChannel, UpdaterState } from '../../shared/contracts.js';

const CHANNELS: readonly { id: UpdateChannel; label: string; hint: string }[] = [
  { id: 'stable', label: 'Estable', hint: 'Solo versiones publicadas.' },
  { id: 'beta', label: 'Beta', hint: 'Candidatas a version, con novedades antes.' },
  { id: 'nightly', label: 'Nightly', hint: 'Compilaciones diarias; puede romperse.' },
];

let overlaysHost: HTMLElement | null = null;
let openDialog: HTMLElement | null = null;

export function registerUpdaterView(overlays: HTMLElement): void {
  overlaysHost = overlays;

  defineCommands([
    {
      id: 'updater.show',
      title: 'Actualizaciones: ver el estado',
      category: 'Aplicacion',
      run: () => showDialog(),
    },
    {
      id: 'updater.check',
      title: 'Actualizaciones: buscar ahora',
      category: 'Aplicacion',
      run: async () => {
        const result = await window.forge.updater.check();
        if (!result.ok) {
          toastError('No se pudo comprobar si hay actualizaciones.', result.error);
          return;
        }
        store.patch({ updater: result.value });
        if (result.value.phase === 'not-available') {
          toast('info', 'ForgeJS IDE ya esta actualizado.');
        } else if (result.value.phase === 'unsupported') {
          toast('info', 'Las actualizaciones solo funcionan en la aplicacion empaquetada.');
        }
      },
    },
  ]);

  // Estado inicial, para que la barra pueda mostrar el aviso si procede.
  void window.forge.updater.state().then((result) => {
    if (result.ok) {
      store.patch({ updater: result.value });
    }
  });

  // Si llega una actualizacion lista mientras el modal esta abierto, se
  // vuelve a pintar con el estado nuevo.
  store.subscribe(['updater'], () => {
    if (openDialog !== null) {
      showDialog();
    }
  });
}

function phaseLabel(state: UpdaterState): string {
  switch (state.phase) {
    case 'idle':
      return 'Sin comprobar';
    case 'checking':
      return 'Comprobando…';
    case 'available':
      return `Version ${state.available?.version ?? ''} disponible`;
    case 'not-available':
      return 'Estas en la ultima version';
    case 'downloading':
      return `Descargando… ${state.progressPercent ?? 0} %`;
    case 'verifying':
      return 'Verificando la firma y la suma SHA-256…';
    case 'ready':
      return `Version ${state.available?.version ?? ''} lista para instalar`;
    case 'error':
      return 'La comprobacion fallo';
    case 'unsupported':
      return 'No disponible en modo desarrollo';
    default:
      return '';
  }
}

function showDialog(): void {
  if (overlaysHost === null) {
    return;
  }
  openDialog?.remove();

  const state = store.state.updater;
  const body = h('div', { class: 'dialog__body' });

  if (state === null) {
    body.appendChild(h('div', { class: 'empty-note' }, 'Todavia no hay informacion del actualizador.'));
  } else {
    /* --- Resumen --- */
    const summary = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' });
    summary.appendChild(h('span', { class: 'chip', 'data-tone': 'accent' }, `Instalada: ${state.currentVersion}`));
    summary.appendChild(h('span', { class: 'chip' }, phaseLabel(state)));
    if (state.available?.sizeBytes !== undefined) {
      summary.appendChild(h('span', { class: 'chip' }, formatBytes(state.available.sizeBytes)));
    }
    body.appendChild(summary);

    if (state.error !== undefined) {
      body.appendChild(
        h(
          'div',
          { style: 'color:var(--state-error)' },
          state.error.detail === undefined ? state.error.message : `${state.error.message} — ${state.error.detail}`,
        ),
      );
    }

    /* --- Barra de progreso --- */
    if (state.phase === 'downloading') {
      const track = h('div', {
        style: 'height:6px;background:var(--surface-3);border-radius:var(--radius-full);overflow:hidden',
      });
      track.appendChild(
        h('div', {
          style: `height:100%;width:${state.progressPercent ?? 0}%;background:var(--accent-500);transition:width 200ms var(--ease-out)`,
        }),
      );
      body.appendChild(track);
      if (state.bytesPerSecond !== undefined) {
        body.appendChild(
          h('div', { class: 'list-row__hint' }, `${formatBytes(state.bytesPerSecond)}/s`),
        );
      }
    }

    /* --- Canal --- */
    const channelField = h('div', { class: 'field' });
    channelField.appendChild(h('span', { class: 'field__label' }, 'Canal de publicacion'));
    const select = h('select', { class: 'select', 'aria-label': 'Canal de publicacion' }) as HTMLSelectElement;
    for (const channel of CHANNELS) {
      select.appendChild(h('option', { value: channel.id, title: channel.hint }, channel.label));
    }
    select.value = state.channel;
    select.addEventListener('change', async () => {
      const result = await window.forge.updater.setChannel(select.value as UpdateChannel);
      if (result.ok) {
        store.patch({ updater: result.value });
      }
    });
    channelField.appendChild(select);
    channelField.appendChild(
      h('span', { class: 'list-row__hint' }, CHANNELS.find((entry) => entry.id === state.channel)?.hint ?? ''),
    );
    body.appendChild(channelField);

    /* --- Notas de version --- */
    const notes = state.available?.releaseNotes;
    if (notes !== undefined && notes !== '') {
      const box = h('div', { class: 'field' });
      box.appendChild(h('span', { class: 'field__label' }, 'Notas de la version'));
      box.appendChild(
        h(
          'pre',
          {
            style:
              'margin:0;padding:8px;background:var(--surface-0);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);max-height:32vh;overflow:auto;white-space:pre-wrap;user-select:text',
          },
          // Se pinta como texto: las notas vienen de un servidor remoto.
          h('code', {}, notes),
        ),
      );
      body.appendChild(box);
    }
  }

  /* --- Acciones --- */
  const footer = h('div', { class: 'dialog__footer' });

  const close = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Cerrar');
  close.addEventListener('click', () => closeDialog());
  footer.appendChild(close);

  if (state?.phase === 'available') {
    const download = h('button', { class: 'btn btn--primary', type: 'button' }, 'Descargar');
    download.addEventListener('click', async () => {
      const result = await window.forge.updater.download();
      if (!result.ok) {
        toastError('La descarga no pudo iniciarse.', result.error);
      }
    });
    footer.appendChild(download);
  } else if (state?.phase === 'ready') {
    const later = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Instalar al salir');
    later.addEventListener('click', async () => {
      const result = await window.forge.updater.install(false);
      if (result.ok) {
        toast('info', 'La actualizacion se aplicara la proxima vez que cierres el IDE.');
        closeDialog();
      } else {
        toastError('No se pudo programar la instalacion.', result.error);
      }
    });

    const now = h('button', { class: 'btn btn--primary', type: 'button' }, 'Actualizar y reiniciar');
    now.addEventListener('click', async () => {
      const result = await window.forge.updater.install(true);
      if (!result.ok) {
        toastError('No se pudo instalar la actualizacion.', result.error);
      }
    });
    footer.append(later, now);
  } else if (state?.phase !== 'unsupported') {
    const check = h('button', { class: 'btn btn--primary', type: 'button' }, 'Buscar actualizaciones');
    check.addEventListener('click', async () => {
      const result = await window.forge.updater.check();
      if (result.ok) {
        store.patch({ updater: result.value });
      }
    });
    footer.appendChild(check);
  }

  const dialog = h(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-label': 'Actualizaciones' },
    h('div', { class: 'dialog__header' }, 'Actualizaciones de ForgeJS IDE'),
    body,
    footer,
  );
  const overlay = h('div', { class: 'overlay overlay--center' }, dialog);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      closeDialog();
    }
  });

  overlaysHost.appendChild(overlay);
  openDialog = overlay;
}

function closeDialog(): void {
  openDialog?.remove();
  openDialog = null;
}
