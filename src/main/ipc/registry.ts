/**
 * Registro central de manejadores IPC.
 *
 * Reglas aplicadas de forma uniforme a todos los canales:
 *  - Solo se aceptan canales declarados en `IPC`; cualquier otro nombre es
 *    un error de programacion y se detecta al arrancar.
 *  - Solo se atiende al `webContents` de la ventana principal registrada.
 *  - Ninguna excepcion cruza la frontera IPC: se convierte en `Result.error`.
 *  - Los errores del guardian de rutas conservan su codigo original.
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  IPC,
  err,
  forgeError,
  type ForgeError,
  type IpcChannel,
  type Result,
} from '../../shared/contracts.js';
import { WorkspaceGuardError } from '../security/workspace-guard.js';

const VALID_CHANNELS = new Set<string>(Object.values(IPC));

const registered = new Set<string>();

let trustedContents: WebContents | null = null;

/** Fija el unico `webContents` autorizado a invocar canales. */
export function setTrustedContents(contents: WebContents | null): void {
  trustedContents = contents;
}

export type Handler<TArgs extends readonly unknown[], TResult> = (
  ...args: TArgs
) => Promise<Result<TResult>> | Result<TResult>;

/** Convierte cualquier valor lanzado en un `ForgeError` seguro de serializar. */
export function toForgeError(cause: unknown): ForgeError {
  if (cause instanceof WorkspaceGuardError) {
    return cause.forge;
  }
  // Los servicios etiquetan sus errores de dominio con `.forge` para
  // conservar el codigo semantico (E_CONFLICT, E_BINARY, E_TOO_LARGE…).
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'forge' in cause &&
    typeof (cause as { forge?: unknown }).forge === 'object'
  ) {
    return (cause as { forge: ForgeError }).forge;
  }
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    switch (code) {
      case 'ENOENT':
        return forgeError('E_NOT_FOUND', 'El recurso no existe.', cause.message);
      case 'EEXIST':
        return forgeError('E_ALREADY_EXISTS', 'El recurso ya existe.', cause.message);
      case 'EACCES':
      case 'EPERM':
        return forgeError('E_PERMISSION', 'Permiso denegado por el sistema.', cause.message);
      case 'EISDIR':
      case 'ENOTDIR':
        return forgeError('E_INVALID_ARGUMENT', 'Tipo de recurso inesperado.', cause.message);
      case 'ETIMEDOUT':
        return forgeError('E_TIMEOUT', 'La operacion agoto el tiempo de espera.', cause.message);
      case 'ECONNREFUSED':
      case 'ENOTFOUND':
      case 'ECONNRESET':
        return forgeError('E_NETWORK', 'Fallo de red.', cause.message);
      default:
        return forgeError('E_UNKNOWN', cause.message, cause.stack);
    }
  }
  return forgeError('E_UNKNOWN', 'Error desconocido.', String(cause));
}

/**
 * Registra un manejador `invoke`. La firma obliga a devolver `Result`, de modo
 * que el renderer nunca ve una promesa rechazada.
 */
export function handle<TArgs extends readonly unknown[], TResult>(
  channel: IpcChannel,
  handler: Handler<TArgs, TResult>,
): void {
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`Canal IPC no declarado en contracts.ts: ${channel}`);
  }
  if (registered.has(channel)) {
    throw new Error(`Canal IPC registrado dos veces: ${channel}`);
  }
  registered.add(channel);

  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (trustedContents !== null && event.sender !== trustedContents) {
      return err(
        forgeError('E_PERMISSION', 'Origen IPC no autorizado.', `Canal ${channel}.`),
      );
    }
    try {
      return await handler(...(args as unknown as TArgs));
    } catch (cause) {
      return err(toForgeError(cause));
    }
  });
}

/** Elimina todos los manejadores; usado al cerrar la aplicacion. */
export function disposeAll(): void {
  for (const channel of registered) {
    ipcMain.removeHandler(channel);
  }
  registered.clear();
  trustedContents = null;
}

/** Canales declarados que aun no tienen manejador (diagnostico de arranque). */
export function missingChannels(): readonly string[] {
  return Object.values(IPC).filter((channel) => !registered.has(channel));
}
