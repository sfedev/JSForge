/**
 * Clientes HTTP de los proveedores de IA.
 *
 * Sin SDK: cada proveedor son unas decenas de lineas sobre `fetch` y un
 * lector de eventos enviados por el servidor. Eso mantiene el arranque
 * instantaneo y evita arrastrar arboles de dependencias que cambian de API
 * cada pocos meses.
 *
 * Los tres hablan el mismo formato de flujo (SSE) salvo Ollama, que emite
 * JSON delimitado por saltos de linea.
 */

import type { AiMessage, AiProviderId } from '../../../shared/contracts.js';

export interface ProviderDefinition {
  readonly id: AiProviderId;
  readonly label: string;
  readonly requiresKey: boolean;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
}

/**
 * Catalogo por defecto. Los modelos concretos se pueden ampliar desde la
 * configuracion del proyecto; esta lista es solo el punto de partida.
 */
export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    requiresKey: true,
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    models: [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-7-sonnet-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    requiresKey: true,
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o1-mini'],
  },
  {
    id: 'ollama',
    label: 'Ollama / LocalAI',
    requiresKey: false,
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'llama3.1',
    models: ['llama3.1', 'qwen2.5-coder', 'deepseek-coder-v2', 'codellama'],
  },
];

export function providerById(id: AiProviderId): ProviderDefinition | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/* -------------------------------------------------------------------------- */
/*  Peticion                                                                   */
/* -------------------------------------------------------------------------- */

export interface StreamRequest {
  readonly provider: AiProviderId;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly AiMessage[];
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly signal: AbortSignal;
}

export interface StreamHandlers {
  readonly onDelta: (text: string) => void;
  readonly onUsage: (input: number | undefined, output: number | undefined) => void;
}

/** Construye la peticion HTTP concreta de cada proveedor. */
function buildRequest(request: StreamRequest): { url: string; init: RequestInit } {
  const history = request.messages.filter((message) => message.role !== 'system');

  switch (request.provider) {
    case 'anthropic':
      return {
        url: `${request.baseUrl}/v1/messages`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': request.apiKey ?? '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            system: request.system,
            stream: true,
            messages: history.map((message) => ({
              role: message.role === 'assistant' ? 'assistant' : 'user',
              content: message.content,
            })),
          }),
        },
      };

    case 'openai':
      return {
        url: `${request.baseUrl}/v1/chat/completions`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${request.apiKey ?? ''}`,
          },
          body: JSON.stringify({
            model: request.model,
            // Los modelos de razonamiento rechazan `temperature`.
            ...(request.model.startsWith('o') ? {} : { temperature: request.temperature }),
            max_completion_tokens: request.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            messages: [
              { role: 'system', content: request.system },
              ...history.map((message) => ({ role: message.role, content: message.content })),
            ],
          }),
        },
      };

    case 'ollama':
    default:
      return {
        url: `${request.baseUrl}/api/chat`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: request.model,
            stream: true,
            options: { temperature: request.temperature, num_predict: request.maxTokens },
            messages: [
              { role: 'system', content: request.system },
              ...history.map((message) => ({ role: message.role, content: message.content })),
            ],
          }),
        },
      };
  }
}

/* -------------------------------------------------------------------------- */
/*  Lectura del flujo                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Extrae el texto de un evento del flujo. Devuelve `null` cuando el evento
 * no aporta texto (por ejemplo, `ping` o `message_start`).
 */
function extractDelta(provider: AiProviderId, payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;

  if (provider === 'anthropic') {
    if (record['type'] === 'content_block_delta') {
      const delta = record['delta'] as { text?: string; type?: string } | undefined;
      return typeof delta?.text === 'string' ? delta.text : null;
    }
    return null;
  }

  if (provider === 'openai') {
    const choices = record['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      return null;
    }
    const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
    return typeof delta?.content === 'string' ? delta.content : null;
  }

  // Ollama.
  const message = record['message'] as { content?: unknown } | undefined;
  return typeof message?.content === 'string' ? message.content : null;
}

function extractUsage(
  provider: AiProviderId,
  payload: unknown,
): { input?: number; output?: number } | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;

  if (provider === 'anthropic') {
    if (record['type'] === 'message_start') {
      const usage = (record['message'] as { usage?: { input_tokens?: number } } | undefined)?.usage;
      return usage?.input_tokens === undefined ? null : { input: usage.input_tokens };
    }
    if (record['type'] === 'message_delta') {
      const usage = record['usage'] as { output_tokens?: number } | undefined;
      return usage?.output_tokens === undefined ? null : { output: usage.output_tokens };
    }
    return null;
  }

  if (provider === 'openai') {
    const usage = record['usage'] as
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    if (usage === undefined || usage === null) {
      return null;
    }
    return { input: usage.prompt_tokens, output: usage.completion_tokens };
  }

  const promptCount = record['prompt_eval_count'];
  const evalCount = record['eval_count'];
  if (typeof promptCount !== 'number' && typeof evalCount !== 'number') {
    return null;
  }
  return {
    ...(typeof promptCount === 'number' ? { input: promptCount } : {}),
    ...(typeof evalCount === 'number' ? { output: evalCount } : {}),
  };
}

/** Mensaje de error legible a partir del cuerpo devuelto por el proveedor. */
function describeError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const error = parsed.error;
    if (typeof error === 'string') {
      return error;
    }
    if (typeof error?.message === 'string') {
      return error.message;
    }
  } catch {
    // El cuerpo no era JSON.
  }
  const trimmed = body.trim().slice(0, 300);
  return trimmed === '' ? `El proveedor respondio con estado ${status}.` : trimmed;
}

/**
 * Ejecuta la peticion y entrega el texto por fragmentos.
 * Lanza si la respuesta no es correcta; el llamante la convierte en evento.
 */
export async function streamCompletion(
  request: StreamRequest,
  handlers: StreamHandlers,
): Promise<string> {
  const { url, init } = buildRequest(request);
  const response = await fetch(url, { ...init, signal: request.signal });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(describeError(response.status, body));
  }
  if (response.body === null) {
    throw new Error('El proveedor no devolvio ningun flujo.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf8');
  const isSse = request.provider !== 'ollama';

  let buffer = '';
  let full = '';

  const handlePayload = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '[DONE]') {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }
    const delta = extractDelta(request.provider, payload);
    if (delta !== null && delta !== '') {
      full += delta;
      handlers.onDelta(delta);
    }
    const usage = extractUsage(request.provider, payload);
    if (usage !== null) {
      handlers.onUsage(usage.input, usage.output);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    if (isSse) {
      // Los eventos SSE se separan por linea en blanco; cada uno puede
      // traer varias lineas `data:`.
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) {
            handlePayload(line.slice(5));
          }
        }
        separator = buffer.indexOf('\n\n');
      }
    } else {
      // Ollama: un objeto JSON por linea.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        handlePayload(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
  }

  // Resto sin terminador.
  if (buffer.trim() !== '') {
    if (isSse) {
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data:')) {
          handlePayload(line.slice(5));
        }
      }
    } else {
      handlePayload(buffer);
    }
  }

  return full;
}

/** Modelos realmente instalados en un Ollama local. */
export async function listOllamaModels(baseUrl: string): Promise<readonly string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as { models?: readonly { name?: string }[] };
    return (payload.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}
