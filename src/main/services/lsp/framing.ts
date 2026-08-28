/**
 * Framing del protocolo de servidor de lenguaje.
 *
 * Cada mensaje va precedido de cabeceras al estilo HTTP terminadas en una
 * linea vacia:
 *
 *   Content-Length: 128\r\n
 *   Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n
 *   \r\n
 *   {"jsonrpc":"2.0", ...}
 *
 * `Content-Length` cuenta BYTES en UTF-8, no caracteres: un mensaje con
 * acentos o emoji se corta si se mide con `string.length`. Por eso el
 * decodificador trabaja sobre `Buffer` y solo convierte a texto cuando ya
 * tiene el cuerpo completo.
 */

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');
const CONTENT_LENGTH = 'content-length';

/** Cota de seguridad: un mensaje LSP legitimo nunca llega a esto. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function encodeMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, payload]);
}

export interface DecodedMessage {
  readonly value: unknown;
  /** Texto crudo, util para diagnosticar respuestas malformadas. */
  readonly raw: string;
}

/**
 * Decodificador incremental. Se le van entregando los fragmentos que llegan
 * por `stdout` y devuelve los mensajes completos que haya podido formar.
 */
export class MessageDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #expected: number | null = null;

  /** Anade un fragmento y devuelve los mensajes ya completos. */
  public push(chunk: Buffer): DecodedMessage[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages: DecodedMessage[] = [];

    for (;;) {
      if (this.#expected === null) {
        const separator = this.#buffer.indexOf(HEADER_SEPARATOR);
        if (separator === -1) {
          // Cabeceras incompletas: se espera al siguiente fragmento.
          if (this.#buffer.byteLength > MAX_MESSAGE_BYTES) {
            this.reset();
          }
          break;
        }
        const headerText = this.#buffer.subarray(0, separator).toString('ascii');
        const length = parseContentLength(headerText);
        if (length === null || length < 0 || length > MAX_MESSAGE_BYTES) {
          // Cabecera invalida: se descarta hasta el separador y se sigue,
          // en vez de bloquear el flujo para siempre.
          this.#buffer = this.#buffer.subarray(separator + HEADER_SEPARATOR.byteLength);
          continue;
        }
        this.#expected = length;
        this.#buffer = this.#buffer.subarray(separator + HEADER_SEPARATOR.byteLength);
      }

      if (this.#buffer.byteLength < this.#expected) {
        break;
      }
      const body = this.#buffer.subarray(0, this.#expected);
      this.#buffer = this.#buffer.subarray(this.#expected);
      this.#expected = null;

      const raw = body.toString('utf8');
      try {
        messages.push({ value: JSON.parse(raw) as unknown, raw });
      } catch {
        // Un cuerpo no JSON solo puede venir de un servidor roto; se ignora
        // ese mensaje pero el flujo continua sincronizado.
      }
    }

    return messages;
  }

  public reset(): void {
    this.#buffer = Buffer.alloc(0);
    this.#expected = null;
  }

  /** Bytes pendientes de consumir; util en pruebas y diagnostico. */
  public get pending(): number {
    return this.#buffer.byteLength;
  }
}

/** Extrae `Content-Length` de un bloque de cabeceras. */
export function parseContentLength(headerText: string): number | null {
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    if (line.slice(0, colon).trim().toLowerCase() !== CONTENT_LENGTH) {
      continue;
    }
    const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}
