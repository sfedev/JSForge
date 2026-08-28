/**
 * Orquestacion del asistente Forge AI.
 *
 * El renderer envia la peticion y recibe el texto por eventos `ai/stream`.
 * Aqui se resuelve la clave, se construye el contexto RAG, se lanza la
 * llamada HTTP y se reenvian los fragmentos.
 */

import {
  forgeError,
  type AiChatRequest,
  type AiProviderId,
  type AiProviderInfo,
} from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { buildContextBlock, systemPromptFor } from './context-builder.js';
import {
  deleteApiKey,
  getApiKey,
  hasApiKey,
  isSecureStorageAvailable,
  setApiKey,
} from './credentials.js';
import { PROVIDERS, listOllamaModels, providerById, streamCompletion } from './providers.js';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;

/** Peticiones en vuelo, para poder cancelarlas. */
const inFlight = new Map<string, AbortController>();

function failure(code: Parameters<typeof forgeError>[0], message: string, detail?: string): never {
  const error = new Error(message) as Error & { forge: ReturnType<typeof forgeError> };
  error.forge = forgeError(code, message, detail);
  throw error;
}

export function listProviders(): readonly AiProviderInfo[] {
  const secureStorage = isSecureStorageAvailable();
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    requiresKey: provider.requiresKey,
    hasKey: provider.requiresKey ? hasApiKey(provider.id) : true,
    defaultModel: provider.defaultModel,
    models: provider.models,
    baseUrl: provider.baseUrl,
    secureStorage,
  }));
}

export function saveKey(provider: AiProviderId, apiKey: string): true {
  const definition = providerById(provider);
  if (definition === undefined) {
    failure('E_INVALID_ARGUMENT', `Proveedor desconocido: ${provider}`);
  }
  if (!definition.requiresKey) {
    failure('E_INVALID_ARGUMENT', `${definition.label} no necesita clave API.`);
  }
  if (!isSecureStorageAvailable()) {
    failure(
      'E_NOT_AVAILABLE',
      'El almacenamiento cifrado del sistema no esta disponible.',
      'La clave no se guarda en claro por seguridad.',
    );
  }
  if (!setApiKey(provider, apiKey)) {
    failure('E_UNKNOWN', 'No se pudo cifrar la clave.');
  }
  return true;
}

export function removeKey(provider: AiProviderId): true {
  deleteApiKey(provider);
  return true;
}

export async function listModels(provider: AiProviderId): Promise<readonly string[]> {
  const definition = providerById(provider);
  if (definition === undefined) {
    return [];
  }
  if (provider !== 'ollama') {
    return definition.models;
  }
  // En un Ollama local lo util es lo que hay descargado, no un catalogo fijo.
  const installed = await listOllamaModels(definition.baseUrl);
  return installed.length > 0 ? installed : definition.models;
}

/* -------------------------------------------------------------------------- */
/*  Conversacion                                                               */
/* -------------------------------------------------------------------------- */

export async function startChat(request: AiChatRequest): Promise<true> {
  if (typeof request?.requestId !== 'string' || request.requestId === '') {
    failure('E_INVALID_ARGUMENT', 'La peticion no declara identificador.');
  }
  if (inFlight.has(request.requestId)) {
    failure('E_ALREADY_EXISTS', 'Ya hay una peticion en curso con ese identificador.');
  }

  const definition = providerById(request.provider);
  if (definition === undefined) {
    failure('E_INVALID_ARGUMENT', `Proveedor desconocido: ${request.provider}`);
  }

  const apiKey = definition.requiresKey ? getApiKey(request.provider) : null;
  if (definition.requiresKey && apiKey === null) {
    failure(
      'E_PERMISSION',
      `Falta la clave API de ${definition.label}.`,
      'Configurala desde el panel de Forge AI.',
    );
  }

  const controller = new AbortController();
  inFlight.set(request.requestId, controller);

  // La llamada se lanza en segundo plano: el manejador IPC responde de
  // inmediato y el texto llega por eventos.
  void runChat(request, definition.baseUrl, apiKey, controller).finally(() => {
    inFlight.delete(request.requestId);
  });

  return true;
}

async function runChat(
  request: AiChatRequest,
  baseUrl: string,
  apiKey: string | null,
  controller: AbortController,
): Promise<void> {
  const started = Date.now();
  emit({
    type: 'ai/stream',
    payload: { kind: 'start', requestId: request.requestId, model: request.model },
  });

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    const contextBlock = await buildContextBlock(request.context);
    const messages = [...request.messages];

    // El contexto se antepone al ultimo mensaje del usuario, no como
    // mensaje aparte: asi no descoloca la alternancia de roles que exigen
    // algunos proveedores.
    if (contextBlock !== '') {
      const lastIndex = messages.length - 1;
      const last = messages[lastIndex];
      if (last !== undefined && last.role === 'user') {
        messages[lastIndex] = {
          role: 'user',
          content: `${contextBlock}\n\n---\n\n${last.content}`,
        };
      }
    }

    const text = await streamCompletion(
      {
        provider: request.provider,
        model: request.model,
        system: systemPromptFor(request.systemPreset),
        messages,
        apiKey,
        baseUrl,
        maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: request.temperature ?? DEFAULT_TEMPERATURE,
        signal: controller.signal,
      },
      {
        onDelta: (delta) => {
          emit({
            type: 'ai/stream',
            payload: { kind: 'delta', requestId: request.requestId, text: delta },
          });
        },
        onUsage: (input, output) => {
          if (input !== undefined) {
            inputTokens = input;
          }
          if (output !== undefined) {
            outputTokens = output;
          }
        },
      },
    );

    emit({
      type: 'ai/stream',
      payload: {
        kind: 'done',
        requestId: request.requestId,
        text,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        elapsedMs: Date.now() - started,
      },
    });
  } catch (cause) {
    const aborted = controller.signal.aborted;
    emit({
      type: 'ai/stream',
      payload: {
        kind: 'error',
        requestId: request.requestId,
        error: aborted
          ? forgeError('E_CANCELLED', 'Peticion cancelada.')
          : forgeError(
              'E_NETWORK',
              'La peticion al proveedor de IA fallo.',
              cause instanceof Error ? cause.message : String(cause),
            ),
      },
    });
  }
}

export function cancelChat(requestId: string): true {
  const controller = inFlight.get(requestId);
  if (controller !== undefined) {
    controller.abort();
    inFlight.delete(requestId);
  }
  return true;
}

/** Cancela todo al cerrar la aplicacion. */
export function cancelAllChats(): void {
  for (const controller of inFlight.values()) {
    controller.abort();
  }
  inFlight.clear();
}
