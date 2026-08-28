/**
 * Utilidades de DOM del renderer.
 *
 * El shell no usa ningun framework: construye el arbol con estas funciones.
 * Todo el texto se inserta con `textContent`, nunca con `innerHTML`, de modo
 * que ningun contenido de archivo, log o respuesta de IA puede inyectar HTML.
 */

type Attributes = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type Child = Node | string | number | null | undefined | false;

/** Crea un elemento con atributos y descendientes en una sola expresion. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === 'class') {
      element.className = String(value);
    } else if (value === true) {
      element.setAttribute(key, '');
    } else {
      element.setAttribute(key, String(value));
    }
  }
  append(element, ...children);
  return element;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function clear(element: Element): void {
  while (element.firstChild !== null) {
    element.removeChild(element.firstChild);
  }
}

export function replaceChildren(element: Element, ...children: Child[]): void {
  clear(element);
  append(element, ...children);
}

/** Icono SVG del set interno. Los paths viven en `icons.ts`. */
export function svgIcon(path: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

export function query<E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E {
  const found = root.querySelector<E>(selector);
  if (found === null) {
    throw new Error(`Elemento no encontrado: ${selector}`);
  }
  return found;
}

export type Disposable = () => void;

/** `addEventListener` que devuelve su propia funcion de baja. */
export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Document | Window,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): Disposable {
  const handler = listener as EventListener;
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Agrupa suscripciones para liberarlas de una vez. */
export class DisposableStore {
  #items: Disposable[] = [];

  public add(disposable: Disposable): Disposable {
    this.#items.push(disposable);
    return disposable;
  }

  public dispose(): void {
    const items = this.#items;
    this.#items = [];
    for (const item of items.reverse()) {
      try {
        item();
      } catch (cause) {
        console.error('[forge] fallo al liberar recurso', cause);
      }
    }
  }
}

/** Ejecuta `fn` como maximo una vez por frame de pintado. */
export function rafThrottle<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  let scheduled = false;
  let lastArgs: T | null = null;
  return (...args: T) => {
    lastArgs = args;
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (lastArgs !== null) {
        fn(...lastArgs);
      }
    });
  };
}

/** Retrasa la ejecucion hasta que pasen `waitMs` sin nuevas llamadas. */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  waitMs: number,
): ((...args: T) => void) & { cancel(): void } {
  let timer: number | null = null;
  const wrapped = (...args: T): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  wrapped.cancel = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

/** Formatea bytes con la unidad mas legible. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${seconds} s`;
}

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

/**
 * Copia al portapapeles informando del resultado.
 *
 * `navigator.clipboard` rechaza la promesa si el permiso esta denegado o el
 * documento no tiene foco; ignorarla dejaba botones que no hacian nada sin
 * decir por que.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
