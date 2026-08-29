/**
 * Codec de tramas WebSocket (RFC 6455), solo lo que necesita un cliente CDP.
 *
 * Se implementa a mano en lugar de tirar de una dependencia por dos razones
 * concretas:
 *
 *  - `ws` arrastra compilacion nativa opcional (`bufferutil`,
 *    `utf-8-validate`), y este proyecto no admite dependencias C++
 *    obligatorias.
 *  - El `WebSocket` global de Node existe, pero no deja fijar cabeceras de
 *    la peticion ni inspeccionar el handshake, que es justo lo que hace
 *    falta para hablar con el inspector de Node de forma diagnosticable.
 *
 * El resultado es un modulo puro: entra `Buffer`, sale `Buffer`. Toda la
 * logica delicada (mascaras, longitudes extendidas, fragmentacion) queda
 * cubierta por pruebas sin abrir un socket.
 */

import { createHash, randomBytes } from 'node:crypto';

/** GUID fijo del protocolo; se concatena a la clave para el `accept`. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

/**
 * Cota de seguridad por trama. Un mensaje CDP legitimo no se acerca; un
 * valor absurdo solo puede venir de un flujo corrupto o de un puerto que no
 * es un inspector, y sin este limite reservariamos memoria a ciegas.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface WsFrame {
  readonly fin: boolean;
  readonly opcode: Opcode;
  readonly payload: Buffer;
}

/* -------------------------------------------------------------------------- */
/*  Handshake                                                                  */
/* -------------------------------------------------------------------------- */

/** Clave aleatoria de 16 bytes en base64, como exige el protocolo. */
export function createHandshakeKey(): string {
  return randomBytes(16).toString('base64');
}

/** Valor que el servidor debe devolver en `Sec-WebSocket-Accept`. */
export function acceptValue(key: string): string {
  return createHash('sha1').update(`${key}${WS_GUID}`, 'ascii').digest('base64');
}

export interface HandshakeResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
}

/**
 * Analiza la respuesta del handshake.
 *
 * Devuelve `null` si aun no han llegado todas las cabeceras, para que el
 * llamante siga acumulando en lugar de decidir con datos incompletos.
 */
export function parseHandshakeResponse(text: string): HandshakeResponse | null {
  const end = text.indexOf('\r\n\r\n');
  if (end === -1) {
    return null;
  }
  const lines = text.slice(0, end).split('\r\n');
  const statusLine = lines[0] ?? '';
  const status = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number.isFinite(status) ? status : 0, headers };
}

/**
 * Comprueba que el servidor completo el cambio de protocolo.
 * Devuelve el motivo del rechazo, o `null` si todo esta en orden.
 */
export function handshakeFailure(response: HandshakeResponse, key: string): string | null {
  if (response.status !== 101) {
    return `El servidor respondio ${response.status} en lugar de 101.`;
  }
  if ((response.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    return 'La respuesta no declara "Upgrade: websocket".';
  }
  const accept = response.headers.get('sec-websocket-accept');
  if (accept !== acceptValue(key)) {
    return 'La cabecera Sec-WebSocket-Accept no coincide con la clave enviada.';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Codificacion                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Construye una trama. Las tramas de cliente van SIEMPRE enmascaradas: un
 * servidor conforme cierra la conexion si recibe una sin mascara.
 */
export function encodeFrame(opcode: Opcode, payload: Buffer, mask = true): Buffer {
  const length = payload.byteLength;
  if (length > MAX_FRAME_BYTES) {
    throw new RangeError('Trama WebSocket demasiado grande para enviarse.');
  }
  let header: Buffer;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // Los 32 bits altos van a cero: `MAX_FRAME_BYTES` los mantiene fuera.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  // FIN a 1: este cliente nunca fragmenta lo que envia.
  header[0] = 0x80 | opcode;

  if (!mask) {
    return Buffer.concat([header, payload]);
  }

  header[1] = (header[1] ?? 0) | 0x80;
  const maskKey = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
  }
  return Buffer.concat([header, maskKey, masked]);
}

export function encodeText(text: string): Buffer {
  return encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'));
}

/** Trama de cierre con codigo; 1000 es «cierre normal». */
export function encodeClose(code = 1000): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return encodeFrame(OPCODE.CLOSE, payload);
}

/* -------------------------------------------------------------------------- */
/*  Decodificacion                                                             */
/* -------------------------------------------------------------------------- */

export class FrameDecoderError extends Error {}

/**
 * Decodificador incremental. Se le entregan los fragmentos segun llegan del
 * socket y devuelve las tramas completas que haya podido formar.
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  public push(chunk: Buffer): WsFrame[] {
    this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: WsFrame[] = [];

    for (;;) {
      const frame = this.#readOne();
      if (frame === null) {
        break;
      }
      frames.push(frame);
    }
    return frames;
  }

  public reset(): void {
    this.#buffer = Buffer.alloc(0);
  }

  public get pending(): number {
    return this.#buffer.byteLength;
  }

  /** Lee una trama del buffer, o `null` si aun no esta entera. */
  #readOne(): WsFrame | null {
    const buffer = this.#buffer;
    if (buffer.byteLength < 2) {
      return null;
    }

    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const opcode = (first & 0x0f) as Opcode;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.byteLength < offset + 2) {
        return null;
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.byteLength < offset + 8) {
        return null;
      }
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      if (high !== 0) {
        throw new FrameDecoderError('Trama WebSocket con longitud fuera de rango.');
      }
      length = low;
      offset += 8;
    }

    if (length > MAX_FRAME_BYTES) {
      throw new FrameDecoderError(`Trama WebSocket de ${length} bytes: excede el limite.`);
    }

    const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) {
      offset += 4;
    }
    if (buffer.byteLength < offset + length) {
      return null;
    }

    // Se copia porque `subarray` comparte memoria con el buffer acumulado,
    // que se reasigna en cuanto llega el siguiente fragmento.
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (maskKey !== null) {
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
      }
    }

    this.#buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }
}

/**
 * Ensambla mensajes de texto a partir de tramas, respetando la
 * fragmentacion. El inspector de Node parte las respuestas grandes (un
 * `Runtime.getProperties` sobre un objeto extenso llega en varias tramas),
 * asi que unir continuaciones no es opcional.
 */
export class MessageAssembler {
  #parts: Buffer[] = [];
  #size = 0;

  /** Devuelve el texto completo, o `null` si el mensaje sigue abierto. */
  public accept(frame: WsFrame): string | null {
    if (frame.opcode === OPCODE.TEXT || frame.opcode === OPCODE.BINARY) {
      this.#parts = [frame.payload];
      this.#size = frame.payload.byteLength;
    } else if (frame.opcode === OPCODE.CONTINUATION) {
      this.#parts.push(frame.payload);
      this.#size += frame.payload.byteLength;
    } else {
      return null;
    }

    if (this.#size > MAX_FRAME_BYTES) {
      this.reset();
      throw new FrameDecoderError('Mensaje WebSocket fragmentado demasiado grande.');
    }
    if (!frame.fin) {
      return null;
    }
    const text = Buffer.concat(this.#parts).toString('utf8');
    this.reset();
    return text;
  }

  public reset(): void {
    this.#parts = [];
    this.#size = 0;
  }
}
