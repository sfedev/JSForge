/**
 * Protocolo `forge://app/...` para servir el bundle del renderer.
 *
 * Cargar la UI desde `file://` daria un origen opaco, con el que `'self'`
 * en la CSP no significa nada y el almacenamiento web queda deshabilitado.
 * Registrando un esquema estandar y seguro obtenemos un origen real
 * (`forge://app`), la CSP pasa a ser efectiva y seguimos sin abrir ningun
 * puerto local.
 *
 * El manejador resuelve cada peticion dentro del directorio del bundle y
 * rechaza cualquier ruta que intente escapar de el.
 */

import { protocol, net } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_SCHEME = 'forge';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

/**
 * Debe llamarse ANTES de `app.whenReady()`; de lo contrario Chromium ya ha
 * fijado la tabla de esquemas y el registro no surte efecto.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function contentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Registra el manejador. `rendererRoot` es el directorio del bundle servido. */
export function registerAppProtocol(rendererRoot: string): void {
  const root = path.resolve(rendererRoot);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);

    if (url.hostname !== APP_HOST) {
      return new Response('Not found', { status: 404 });
    }

    const requestedPath = decodeURIComponent(url.pathname);
    const relative = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');
    const resolved = path.resolve(root, relative);

    // El recurso debe quedar dentro del directorio del bundle.
    const relativeToRoot = path.relative(root, resolved);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!existsSync(resolved)) {
      return new Response('Not found', { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(resolved).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Type', contentType(resolved));
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  });
}
