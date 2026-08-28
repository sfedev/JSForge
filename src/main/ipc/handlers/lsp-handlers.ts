/** Manejadores IPC de servidores de lenguaje y formateo. */

import {
  IPC,
  ok,
  type FormatRequest,
  type FormatResponse,
  type LanguageServerId,
  type LspNotifyPayload,
  type LspRequestPayload,
  type LspServerState,
} from '../../../shared/contracts.js';
import { formatDocument } from '../../services/format/format-service.js';
import {
  ensureServer,
  sendNotification,
  sendRequest,
  serverStates,
  stopServer,
} from '../../services/lsp/lsp-manager.js';
import { getSettings } from '../../services/settings-service.js';
import { handle } from '../registry.js';

export function registerLspHandlers(): void {
  handle<[LanguageServerId], LspServerState>(IPC.LSP_ENSURE, async (server) =>
    ok(await ensureServer(server)),
  );

  handle<[LanguageServerId], true>(IPC.LSP_STOP, async (server) => ok(await stopServer(server)));

  handle<[LspRequestPayload], unknown>(IPC.LSP_REQUEST, async (payload) =>
    ok(await sendRequest(payload.server, payload.method, payload.params)),
  );

  handle<[LspNotifyPayload], true>(IPC.LSP_NOTIFY, (payload) =>
    ok(sendNotification(payload.server, payload.method, payload.params)),
  );

  handle<[], readonly LspServerState[]>(IPC.LSP_STATUS, () => ok(serverStates()));

  handle<[FormatRequest], FormatResponse>(IPC.FORMAT_DOCUMENT, async (request) =>
    ok(await formatDocument(request, getSettings().formatter)),
  );
}
