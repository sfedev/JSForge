/**
 * Cliente del Chrome DevTools Protocol sobre WebSocket.
 *
 * Habla con el inspector que expone Node al arrancar con `--inspect` o
 * `--inspect-brk`. El transporte es un socket TCP plano mas el codec de
 * `ws-frame.ts`: sin dependencias, sin compilacion nativa.
 *
 * Decisiones que importan:
 *  - Solo se admiten destinos en el bucle local. El inspector de Node no
 *    pide autenticacion: quien puede hablar con el ejecuta codigo arbitrario
 *    en ese proceso, asi que abrirlo a la red seria un agujero.
 *  - Cada peticion lleva su temporizador. Un inspector detenido en un
 *    `debugger` no responde a segun que comandos, y sin plazo la promesa
 *    quedaria colgada para siempre.
 *  - Los `ping` del servidor se responden con `pong` en el propio cliente:
 *    si no, el inspector cierra la conexion por inactividad.
 */

import { connect, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';

import type { DebugTarget } from '../../shared/contracts.js';
import {
  FrameDecoder,
  MessageAssembler,
  OPCODE,
  createHandshakeKey,
  encodeClose,
  encodeFrame,
  encodeText,
  handshakeFailure,
  parseHandshakeResponse,
} from './ws-frame.js';

/** Plazo por defecto de una peticion CDP. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Plazo del handshake: si el puerto no es un inspector, se nota enseguida. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Anfitriones aceptados. El inspector no autentica, de modo que permitir un
 * host arbitrario convertiria al IDE en un puente hacia procesos ajenos.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export interface CdpEvent {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

type EventListener = (event: CdpEvent) => void;
type CloseListener = (reason: string) => void;

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class CdpError extends Error {
  public readonly cdpCode: number;

  public constructor(message: string, code: number) {
    super(message);
    this.name = 'CdpError';
    this.cdpCode = code;
  }
}

/* -------------------------------------------------------------------------- */
/*  Descubrimiento de destinos                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Interpreta la respuesta de `/json/list`.
 *
 * Se valida campo a campo en vez de confiar en la forma: el cuerpo lo emite
 * un proceso externo y puede ser cualquier cosa si el puerto esta ocupado
 * por otro servicio.
 */
export function parseTargetList(body: string): readonly DebugTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const targets: DebugTarget[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const webSocketDebuggerUrl = record['webSocketDebuggerUrl'];
    if (typeof webSocketDebuggerUrl !== 'string' || webSocketDebuggerUrl === '') {
      continue;
    }
    targets.push({
      id: typeof record['id'] === 'string' ? record['id'] : webSocketDebuggerUrl,
      title: typeof record['title'] === 'string' ? record['title'] : 'Proceso Node',
      url: typeof record['url'] === 'string' ? record['url'] : '',
      webSocketDebuggerUrl,
    });
  }
  return targets;
}

/** Ruta del WebSocket dentro de una URL `ws://host:puerto/uuid`. */
export function debuggerPath(webSocketDebuggerUrl: string): string {
  const match = /^wss?:\/\/[^/]+(\/.*)$/.exec(webSocketDebuggerUrl);
  return match?.[1] ?? '/';
}

/** Consulta `/json/list` en el inspector y devuelve sus destinos. */
export async function discoverTargets(
  host: string,
  port: number,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<readonly DebugTarget[]> {
  if (!isLoopbackHost(host)) {
    throw new Error('Solo se admiten inspectores en el bucle local.');
  }
  const body = await new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      { host, port, path: '/json/list', method: 'GET', timeout: timeoutMs },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => resolve(text));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('El inspector no respondio a tiempo.'));
    });
    req.on('error', reject);
    req.end();
  });
  return parseTargetList(body);
}

/* -------------------------------------------------------------------------- */
/*  Cliente                                                                    */
/* -------------------------------------------------------------------------- */

export class CdpClient {
  readonly #host: string;
  readonly #port: number;
  readonly #path: string;

  #socket: Socket | null = null;
  #decoder = new FrameDecoder();
  #assembler = new MessageAssembler();
  #pending = new Map<number, PendingRequest>();
  #eventListeners = new Set<EventListener>();
  #closeListeners = new Set<CloseListener>();
  #nextId = 1;
  #closed = false;

  public constructor(host: string, port: number, path: string) {
    if (!isLoopbackHost(host)) {
      throw new Error('Solo se admiten inspectores en el bucle local.');
    }
    this.#host = host;
    this.#port = port;
    this.#path = path;
  }

  public get connected(): boolean {
    return this.#socket !== null && !this.#closed;
  }

  public onEvent(listener: EventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  public onClose(listener: CloseListener): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** Abre el socket y completa el handshake WebSocket. */
  public connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const key = createHandshakeKey();
      const socket = connect({ host: this.#host, port: this.#port });
      socket.setNoDelay(true);

      let handshakeDone = false;
      let headerText = '';

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Se agoto el tiempo de conexion con el inspector.'));
      }, timeoutMs);
      timer.unref();

      const failEarly = (cause: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        if (!handshakeDone) {
          reject(cause);
        }
      };

      socket.on('error', failEarly);

      socket.on('connect', () => {
        const lines = [
          `GET ${this.#path} HTTP/1.1`,
          `Host: ${this.#host}:${this.#port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ];
        socket.write(lines.join('\r\n'), 'ascii');
      });

      socket.on('data', (chunk: Buffer) => {
        if (handshakeDone) {
          this.#consume(chunk);
          return;
        }

        // Las cabeceras pueden llegar partidas, y el primer fragmento de
        // tramas puede venir pegado a ellas en el mismo paquete.
        headerText += chunk.toString('binary');
        const response = parseHandshakeResponse(headerText);
        if (response === null) {
          if (headerText.length > 64 * 1024) {
            failEarly(new Error('Respuesta de handshake desmesurada.'));
          }
          return;
        }

        const failure = handshakeFailure(response, key);
        if (failure !== null) {
          failEarly(new Error(failure));
          return;
        }

        clearTimeout(timer);
        handshakeDone = true;
        this.#socket = socket;
        socket.off('error', failEarly);
        socket.on('error', (cause: Error) => this.#shutdown(cause.message));
        socket.on('close', () => this.#shutdown('El inspector cerro la conexion.'));

        const separator = headerText.indexOf('\r\n\r\n') + 4;
        const rest = Buffer.from(headerText.slice(separator), 'binary');
        if (rest.byteLength > 0) {
          this.#consume(rest);
        }
        resolve();
      });
    });
  }

  /** Envia un comando CDP y espera su respuesta. */
  public send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const socket = this.#socket;
    if (socket === null || this.#closed) {
      return Promise.reject(new Error('No hay conexion con el inspector.'));
    }

    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`El inspector no respondio a "${method}".`));
      }, timeoutMs);
      timer.unref();

      this.#pending.set(id, { resolve, reject, timer });
      try {
        socket.write(encodeText(JSON.stringify({ id, method, params })));
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  public close(): void {
    const socket = this.#socket;
    if (socket !== null && !this.#closed) {
      try {
        socket.write(encodeClose(1000));
      } catch {
        // El socket ya podia estar roto; el cierre sigue igualmente.
      }
    }
    this.#shutdown('Sesion cerrada por el IDE.');
    socket?.destroy();
  }

  /* ------------------------------------------------------------------ */

  #consume(chunk: Buffer): void {
    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (cause) {
      this.#shutdown(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    for (const frame of frames) {
      if (frame.opcode === OPCODE.CLOSE) {
        this.#shutdown('El inspector cerro la sesion.');
        return;
      }
      if (frame.opcode === OPCODE.PING) {
        // Sin `pong` el inspector da la conexion por muerta.
        try {
          this.#socket?.write(encodeFrame(OPCODE.PONG, frame.payload));
        } catch {
          // Si el socket ya no admite escrituras, el cierre llega solo.
        }
        continue;
      }
      if (frame.opcode === OPCODE.PONG) {
        continue;
      }

      let text: string | null;
      try {
        text = this.#assembler.accept(frame);
      } catch (cause) {
        this.#shutdown(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      if (text !== null) {
        this.#dispatch(text);
      }
    }
  }

  #dispatch(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      // Un mensaje no JSON solo puede venir de un extremo roto; se ignora
      // sin perder la sincronizacion del flujo.
      return;
    }
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const record = message as Record<string, unknown>;

    const id = record['id'];
    if (typeof id === 'number') {
      const pending = this.#pending.get(id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);

      const error = record['error'];
      if (typeof error === 'object' && error !== null) {
        const detail = error as Record<string, unknown>;
        const message_ = typeof detail['message'] === 'string' ? detail['message'] : 'Error CDP.';
        const code = typeof detail['code'] === 'number' ? detail['code'] : 0;
        pending.reject(new CdpError(message_, code));
        return;
      }
      const result = record['result'];
      pending.resolve(
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {},
      );
      return;
    }

    const method = record['method'];
    if (typeof method !== 'string') {
      return;
    }
    const params = record['params'];
    const event: CdpEvent = {
      method,
      params:
        typeof params === 'object' && params !== null
          ? (params as Record<string, unknown>)
          : {},
    };
    for (const listener of this.#eventListeners) {
      try {
        listener(event);
      } catch (cause) {
        console.error('[forge] fallo un oyente CDP', cause);
      }
    }
  }

  /** Cierre unico e idempotente: rechaza lo pendiente y avisa una sola vez. */
  #shutdown(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    this.#decoder.reset();
    this.#assembler.reset();

    const listeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    this.#eventListeners.clear();
    for (const listener of listeners) {
      try {
        listener(reason);
      } catch (cause) {
        console.error('[forge] fallo un oyente de cierre CDP', cause);
      }
    }
  }
}
