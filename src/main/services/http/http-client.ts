/**
 * Ejecutor de peticiones del cliente HTTP integrado.
 *
 * Corre en el proceso principal por dos motivos: el renderer tiene
 * `connect-src 'self'` y no puede salir a la red, y asi las peticiones no
 * quedan sujetas a CORS ni al mismo origen, que es justo lo que se necesita
 * para probar una API local.
 */

import { forgeError, type HttpRequestSpec, type HttpResponseView } from '../../../shared/contracts.js';

const TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Peticiones en vuelo, para poder cancelarlas desde la interfaz. */
const inFlight = new Map<string, AbortController>();

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

/** Solo se permiten esquemas HTTP; nada de `file:` ni protocolos raros. */
function assertValidUrl(candidate: string): URL {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    failure('E_INVALID_ARGUMENT', `La URL no es valida: ${candidate}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    failure('E_INVALID_ARGUMENT', `Esquema no permitido: ${url.protocol}`);
  }
  return url;
}

function prettyPrint(body: string, contentType: string): string | undefined {
  if (!/json/i.test(contentType)) {
    return undefined;
  }
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return undefined;
  }
}

export async function sendRequest(request: HttpRequestSpec): Promise<HttpResponseView> {
  if (typeof request?.url !== 'string' || request.url.trim() === '') {
    failure('E_INVALID_ARGUMENT', 'La peticion no declara URL.');
  }
  const url = assertValidUrl(request.url.trim());
  const method = (request.method ?? 'GET').toUpperCase();

  const controller = new AbortController();
  inFlight.set(request.id, controller);
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const started = Date.now();
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      // Se filtran las cabeceras que el runtime debe controlar.
      if (/^(host|content-length|connection)$/i.test(name)) {
        continue;
      }
      headers.set(name, value);
    }

    const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== undefined;
    if (hasBody && !headers.has('content-type')) {
      // Un cuerpo que parece JSON casi siempre lo es.
      const trimmed = (request.body ?? '').trimStart();
      headers.set(
        'content-type',
        trimmed.startsWith('{') || trimmed.startsWith('[')
          ? 'application/json'
          : 'text/plain; charset=utf-8',
      );
    }

    const response = await fetch(url, {
      method,
      headers,
      ...(hasBody ? { body: request.body } : {}),
      signal: controller.signal,
      redirect: 'follow',
    });

    const buffer = await response.arrayBuffer();
    const size = buffer.byteLength;
    const truncated = size > MAX_BODY_BYTES;
    const decoder = new TextDecoder('utf8');
    const body = decoder.decode(truncated ? buffer.slice(0, MAX_BODY_BYTES) : buffer);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    const contentType = response.headers.get('content-type') ?? '';

    const pretty = prettyPrint(body, contentType);
    return {
      id: request.id,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: truncated ? `${body}\n\n… respuesta recortada (${size} bytes en total).` : body,
      contentType,
      size,
      elapsedMs: Date.now() - started,
      ...(pretty === undefined ? {} : { prettyBody: pretty }),
    };
  } catch (cause) {
    if (controller.signal.aborted) {
      failure('E_CANCELLED', 'La peticion se cancelo o agoto el tiempo de espera.');
    }
    failure(
      'E_NETWORK',
      'La peticion HTTP fallo.',
      cause instanceof Error ? cause.message : String(cause),
    );
  } finally {
    clearTimeout(timer);
    inFlight.delete(request.id);
  }
}

export function cancelRequest(id: string): true {
  const controller = inFlight.get(id);
  if (controller !== undefined) {
    controller.abort();
    inFlight.delete(id);
  }
  return true;
}

export function cancelAllRequests(): void {
  for (const controller of inFlight.values()) {
    controller.abort();
  }
  inFlight.clear();
}
