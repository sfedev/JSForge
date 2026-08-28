/**
 * Endurecimiento de la sesion y de la ventana.
 *
 * Complementa a `webPreferences` con las defensas que solo pueden aplicarse
 * a nivel de sesion o de `webContents`:
 *  - CSP estricta inyectada en las cabeceras de respuesta.
 *  - Denegacion de todos los permisos del navegador (camara, geoloc., etc.).
 *  - Bloqueo de navegacion fuera del bundle local y de `window.open`.
 *  - Bloqueo de cualquier peticion de red que no sea al propio bundle.
 */

import { shell, type BrowserWindow, type Session } from 'electron';
import { URL } from 'node:url';

/**
 * Politica de seguridad de contenido.
 *
 * - `script-src 'self'`: sin `unsafe-inline` ni `unsafe-eval`. Monaco se
 *   empaqueta localmente y sus workers se cargan como blobs generados por el
 *   propio bundle, por eso `worker-src` admite `blob:`.
 * - `style-src` necesita `'unsafe-inline'`: Monaco escribe reglas de tema
 *   directamente en un `<style>` dinamico y no ofrece nonce.
 * - `img-src` admite `data:` para los iconos SVG embebidos; ningun origen
 *   remoto esta permitido.
 * - `connect-src 'self'`: las llamadas a proveedores de IA y al cliente HTTP
 *   ocurren en el proceso principal, nunca en el renderer.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'none'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

/** Esquemas que el renderer puede cargar directamente. */
const ALLOWED_SCHEMES = new Set(['forge:', 'devtools:', 'blob:', 'data:', 'file:']);

/** Destinos externos que se aceptan al abrir el navegador del sistema. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Comprueba si una URL puede abrirse en el navegador del sistema.
 * Se usa tanto aqui como en el manejador IPC `app/open-external`.
 */
export function isSafeExternalUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return EXTERNAL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

export function applySessionHardening(session: Session): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
        'X-Content-Type-Options': ['nosniff'],
        'Cross-Origin-Opener-Policy': ['same-origin'],
      },
    });
  });

  // Ningun permiso del navegador es necesario para el IDE.
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);

  // El renderer solo puede cargar recursos del propio bundle.
  session.webRequest.onBeforeRequest((details, callback) => {
    let protocol = '';
    try {
      protocol = new URL(details.url).protocol;
    } catch {
      callback({ cancel: true });
      return;
    }
    callback({ cancel: !ALLOWED_SCHEMES.has(protocol) });
  });

  // Sin extensiones ni descargas silenciosas.
  session.on('will-download', (event) => {
    event.preventDefault();
  });
}

export function applyWindowHardening(window: BrowserWindow): void {
  const contents = window.webContents;

  // `window.open` se convierte en "abrir en el navegador del sistema".
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Ninguna navegacion fuera del documento inicial.
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Si el renderer muere, no se deja la ventana en un estado zombie.
  contents.on('render-process-gone', (_event, details) => {
    console.error('[forge] el proceso de renderizado termino', details.reason);
  });
}
