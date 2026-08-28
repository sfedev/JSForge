/**
 * Cliente JSON-RPC sobre stdio para servidores de lenguaje.
 *
 * Responsabilidades:
 *  - Numerar peticiones y casar respuestas con su promesa.
 *  - Reenviar al renderer las notificaciones del servidor (diagnosticos,
 *    progreso) a traves de una devolucion de llamada.
 *  - Responder a las peticiones que el servidor hace al cliente
 *    (`workspace/configuration`, `client/registerCapability`), sin las cuales
 *    `typescript-language-server` se queda esperando indefinidamente.
 *  - Apagarse de forma ordenada: `shutdown` y `exit` antes de matar.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { forgeError, type LanguageServerId } from '../../../shared/contracts.js';
import { MessageDecoder, encodeMessage } from './framing.js';

const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 3000;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface LspClientOptions {
  readonly id: LanguageServerId;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Notificaciones del servidor hacia el cliente. */
  readonly onNotification: (method: string, params: unknown) => void;
  /** Se invoca cuando el proceso muere de forma inesperada. */
  readonly onExit: (code: number | null, stderr: string) => void;
  /** Configuracion devuelta ante `workspace/configuration`. */
  readonly configuration?: Readonly<Record<string, unknown>>;
}

export class LspClient {
  readonly #options: LspClientOptions;
  readonly #decoder = new MessageDecoder();
  readonly #pending = new Map<number, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #stderr = '';
  #closing = false;

  public constructor(options: LspClientOptions) {
    this.#options = options;
  }

  public get id(): LanguageServerId {
    return this.#options.id;
  }

  public get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  public get pid(): number | undefined {
    return this.#child?.pid;
  }

  /* ------------------------------------------------------------------ */
  /*  Ciclo de vida                                                      */
  /* ------------------------------------------------------------------ */

  public start(): void {
    if (this.#child !== null) {
      return;
    }
    const child = spawn(this.#options.command, [...this.#options.args], {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env },
      windowsHide: true,
      // Los servidores se distribuyen como `.cmd` en Windows.
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.#child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      for (const message of this.#decoder.push(chunk)) {
        this.#dispatch(message.value);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Se conserva solo la cola: algunos servidores son muy verbosos.
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8000);
    });

    child.on('error', (cause: Error) => {
      this.#failAll(cause);
      this.#child = null;
      this.#options.onExit(null, cause.message);
    });

    child.on('close', (code) => {
      this.#failAll(new Error(`El servidor de lenguaje termino con codigo ${code ?? -1}.`));
      this.#child = null;
      if (!this.#closing) {
        this.#options.onExit(code, this.#stderr);
      }
    });
  }

  /** Apagado cortes: `shutdown`, `exit` y, si no responde, senal. */
  public async stop(): Promise<void> {
    const child = this.#child;
    if (child === null) {
      return;
    }
    this.#closing = true;
    try {
      await Promise.race([
        this.request('shutdown', null),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
      this.notify('exit', null);
    } catch {
      // Un servidor que ya no responde no impide continuar.
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    child.kill();
    this.#child = null;
  }

  /* ------------------------------------------------------------------ */
  /*  Envio                                                              */
  /* ------------------------------------------------------------------ */

  public request(method: string, params: unknown): Promise<unknown> {
    const child = this.#child;
    if (child === null) {
      return Promise.reject(
        Object.assign(new Error('El servidor de lenguaje no esta en ejecucion.'), {
          forge: forgeError('E_NOT_AVAILABLE', 'El servidor de lenguaje no esta en ejecucion.'),
        }),
      );
    }
    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          Object.assign(new Error(`El servidor no respondio a "${method}".`), {
            forge: forgeError('E_TIMEOUT', `El servidor no respondio a "${method}".`),
          }),
        );
      }, REQUEST_TIMEOUT_MS);
      timer.unref();

      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  public notify(method: string, params: unknown): void {
    if (this.#child === null) {
      return;
    }
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (child === null || child.stdin.destroyed) {
      return;
    }
    child.stdin.write(encodeMessage(message));
  }

  /* ------------------------------------------------------------------ */
  /*  Recepcion                                                          */
  /* ------------------------------------------------------------------ */

  #dispatch(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const record = message as {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };

    /* Respuesta a una peticion nuestra. */
    if (record.id !== undefined && record.method === undefined) {
      const id = typeof record.id === 'number' ? record.id : Number.parseInt(String(record.id), 10);
      const pending = this.#pending.get(id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (record.error !== undefined) {
        pending.reject(
          Object.assign(new Error(record.error.message), {
            forge: forgeError('E_PROCESS_FAILED', record.error.message, `LSP ${record.error.code}`),
          }),
        );
      } else {
        pending.resolve(record.result ?? null);
      }
      return;
    }

    /* Peticion del servidor hacia el cliente: hay que contestar siempre. */
    if (record.id !== undefined && record.method !== undefined) {
      this.#answerServerRequest(record.id, record.method, record.params);
      return;
    }

    /* Notificacion. */
    if (record.method !== undefined) {
      this.#options.onNotification(record.method, record.params);
    }
  }

  #answerServerRequest(id: number | string, method: string, params: unknown): void {
    switch (method) {
      case 'workspace/configuration': {
        // Se devuelve un elemento por seccion solicitada.
        const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
        const configuration = this.#options.configuration ?? {};
        const result = items.map((item) => {
          const section = (item as { section?: string }).section;
          if (section === undefined) {
            return configuration;
          }
          return resolveSection(configuration, section) ?? {};
        });
        this.#write({ jsonrpc: '2.0', id, result });
        return;
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
        this.#write({ jsonrpc: '2.0', id, result: null });
        return;
      case 'workspace/workspaceFolders':
        this.#write({ jsonrpc: '2.0', id, result: null });
        return;
      case 'window/showMessageRequest':
        // No hay interfaz para responder; se devuelve "sin eleccion".
        this.#write({ jsonrpc: '2.0', id, result: null });
        return;
      case 'window/workDoneProgress/create':
        this.#write({ jsonrpc: '2.0', id, result: null });
        return;
      default:
        // Metodo desconocido: se responde con el error estandar en vez de
        // dejar al servidor esperando.
        this.#write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Metodo no implementado: ${method}` },
        });
    }
  }

  #failAll(cause: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.#pending.clear();
  }

  public get stderrTail(): string {
    return this.#stderr;
  }
}

/** Resuelve `a.b.c` dentro de un objeto de configuracion. */
function resolveSection(
  configuration: Readonly<Record<string, unknown>>,
  section: string,
): unknown {
  let current: unknown = configuration;
  for (const part of section.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
