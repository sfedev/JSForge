/**
 * Bus de eventos main -> renderer.
 *
 * Todo lo que el proceso principal empuja al renderer viaja por un unico
 * canal (`IPC_EVENT_CHANNEL`) con una union discriminada, de forma que el
 * preload solo necesita reenviar un mensaje y no puede convertirse en un
 * vector para exponer canales arbitrarios.
 */

import type { BrowserWindow, WebContents } from 'electron';

import { IPC_EVENT_CHANNEL, type ForgeEvent } from '../../shared/contracts.js';

type Target = { readonly webContents: WebContents } | null;

let target: Target = null;

/** Asocia el bus a la ventana principal. */
export function bindEventTarget(window: BrowserWindow): void {
  target = window;
}

export function unbindEventTarget(): void {
  target = null;
}

/** Envia un evento tipado al renderer. No lanza si la ventana ya no existe. */
export function emit(event: ForgeEvent): void {
  const current = target;
  if (current === null) {
    return;
  }
  const contents = current.webContents;
  if (contents.isDestroyed()) {
    return;
  }
  try {
    contents.send(IPC_EVENT_CHANNEL, event);
  } catch {
    // La ventana pudo cerrarse entre la comprobacion y el envio.
  }
}

/** Atajo para notificaciones visibles en la UI. */
export function notify(
  level: 'info' | 'warn' | 'error',
  message: string,
  detail?: string,
): void {
  emit({
    type: 'notification',
    payload: detail === undefined ? { level, message } : { level, message, detail },
  });
}

/**
 * Agrupa eventos de alta frecuencia (logs, cambios de archivo) en lotes con
 * un freno de refresco configurable. Evita saturar el hilo del renderer.
 */
export class ThrottledBatcher<T> {
  readonly #flush: (items: readonly T[]) => void;
  #intervalMs: number;
  #buffer: T[] = [];
  #timer: NodeJS.Timeout | null = null;
  #maxBuffer: number;

  public constructor(
    flush: (items: readonly T[]) => void,
    intervalMs: number,
    maxBuffer = 5000,
  ) {
    this.#flush = flush;
    this.#intervalMs = Math.max(16, intervalMs);
    this.#maxBuffer = maxBuffer;
  }

  public setInterval(intervalMs: number): void {
    this.#intervalMs = Math.max(16, intervalMs);
  }

  public push(item: T): void {
    this.#buffer.push(item);
    if (this.#buffer.length >= this.#maxBuffer) {
      this.flushNow();
      return;
    }
    this.#schedule();
  }

  public pushAll(items: readonly T[]): void {
    for (const item of items) {
      this.push(item);
    }
  }

  public flushNow(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#buffer.length === 0) {
      return;
    }
    const items = this.#buffer;
    this.#buffer = [];
    this.#flush(items);
  }

  public dispose(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#buffer = [];
  }

  #schedule(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const items = this.#buffer;
      this.#buffer = [];
      if (items.length > 0) {
        this.#flush(items);
      }
    }, this.#intervalMs);
    this.#timer.unref?.();
  }
}
