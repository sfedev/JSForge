/** Manejadores IPC de la terminal integrada. */

import {
  IPC,
  ok,
  type CommandSuggestion,
  type PtyCreateRequest,
  type PtyCreateResult,
  type PtyProfile,
} from '../../../shared/contracts.js';
import {
  createSession,
  disposeSession,
  listProfiles,
  resizeSession,
  suggest,
  writeToSession,
} from '../../services/terminal/pty-service.js';
import { handle } from '../registry.js';

export function registerTerminalHandlers(): void {
  handle<[], readonly PtyProfile[]>(IPC.PTY_PROFILES, async () => ok(await listProfiles()));

  handle<[PtyCreateRequest], PtyCreateResult>(IPC.PTY_CREATE, async (request) =>
    ok(await createSession(request)),
  );

  handle<[string, string], true>(IPC.PTY_WRITE, (id, data) => ok(writeToSession(id, data)));

  handle<[string, number, number], true>(IPC.PTY_RESIZE, (id, cols, rows) =>
    ok(resizeSession(id, cols, rows)),
  );

  handle<[string], true>(IPC.PTY_DISPOSE, (id) => ok(disposeSession(id)));

  handle<[string], readonly CommandSuggestion[]>(IPC.PTY_SUGGEST, async (prefix) =>
    ok(await suggest(prefix)),
  );
}
