/** Manejadores IPC del asistente Forge AI. */

import {
  IPC,
  ok,
  type AiChatRequest,
  type AiProviderId,
  type AiProviderInfo,
} from '../../../shared/contracts.js';
import {
  cancelChat,
  listModels,
  listProviders,
  removeKey,
  saveKey,
  startChat,
} from '../../services/ai/ai-service.js';
import { handle } from '../registry.js';

export function registerAiHandlers(): void {
  handle<[], readonly AiProviderInfo[]>(IPC.AI_PROVIDERS, () => ok(listProviders()));

  handle<[AiProviderId, string], true>(IPC.AI_SET_KEY, (provider, apiKey) =>
    ok(saveKey(provider, apiKey)),
  );

  handle<[AiProviderId], true>(IPC.AI_DELETE_KEY, (provider) => ok(removeKey(provider)));

  handle<[AiProviderId], readonly string[]>(IPC.AI_MODELS, async (provider) =>
    ok(await listModels(provider)),
  );

  handle<[AiChatRequest], true>(IPC.AI_CHAT_START, async (request) => ok(await startChat(request)));

  handle<[string], true>(IPC.AI_CHAT_CANCEL, (requestId) => ok(cancelChat(requestId)));
}
