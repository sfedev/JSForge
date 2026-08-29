/**
 * Generador de codigo a partir de una especificacion OpenAPI.
 *
 * Produce TypeScript en texto: tipos, hooks de React, composables de Vue o
 * un cliente tipado. Todo el modulo es puro (vista -> cadena), de modo que
 * el asistente visual, el menu contextual y las pruebas comparten la misma
 * salida byte a byte.
 *
 * El codigo generado no usa `any` en ningun caso: el proyecto compila en
 * modo estricto y un archivo generado que no pasara `tsc` seria peor que no
 * generar nada.
 */

import type {
  OpenApiDocumentView,
  OpenApiOperation,
  OpenApiSchema,
  SpecGenerationTarget,
} from '../../../shared/contracts.js';

/** Palabras reservadas que no pueden ser identificadores. */
const RESERVED = new Set([
  'default',
  'delete',
  'function',
  'import',
  'export',
  'new',
  'return',
  'class',
  'const',
  'let',
  'var',
  'interface',
  'type',
  'enum',
]);

/**
 * Identificador seguro en TypeScript.
 * `pascal('get:/api/users/{id}')` -> `GetApiUsersId`.
 */
export function toPascalCase(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((part) => part !== '');
  const joined = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  // Un identificador no puede empezar por digito.
  return /^[0-9]/.test(joined) ? `N${joined}` : joined || 'Sin Nombre'.replace(/\s/g, '');
}

export function toCamelCase(raw: string): string {
  const pascal = toPascalCase(raw);
  const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  return RESERVED.has(camel) ? `${camel}_` : camel;
}

/** Nombre de propiedad valido sin comillas, o entrecomillado si hace falta. */
export function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Comentario de documentacion, omitido cuando no hay nada que decir. */
function docComment(lines: readonly (string | undefined)[], indent = ''): string {
  const useful = lines.filter((line): line is string => line !== undefined && line.trim() !== '');
  if (useful.length === 0) {
    return '';
  }
  if (useful.length === 1) {
    return `${indent}/** ${useful[0]} */\n`;
  }
  return `${indent}/**\n${useful.map((line) => `${indent} * ${line}`).join('\n')}\n${indent} */\n`;
}

const HEADER = [
  '/*',
  ' * Archivo generado por ForgeJS IDE a partir de la especificacion OpenAPI.',
  ' * No lo edites a mano: se sobrescribe al regenerar.',
  ' */',
  '',
].join('\n');

/* -------------------------------------------------------------------------- */
/*  Tipos                                                                      */
/* -------------------------------------------------------------------------- */

/** Interfaz de un esquema, con sus campos opcionales y anulables. */
export function renderSchema(schema: OpenApiSchema): string {
  const lines: string[] = [];
  lines.push(docComment([schema.name === '' ? undefined : undefined]).trimEnd());
  lines.push(`export interface ${toPascalCase(schema.name)} {`);

  for (const field of schema.fields) {
    const doc = docComment([field.description], '  ');
    if (doc !== '') {
      lines.push(doc.trimEnd());
    }
    const optional = field.required ? '' : '?';
    // `nullable` y opcional son cosas distintas: un campo puede ser
    // obligatorio y valer null, y colapsarlos perderia informacion.
    const type = field.nullable ? `${field.type} | null` : field.type;
    lines.push(`  readonly ${propertyKey(field.name)}${optional}: ${type};`);
  }

  lines.push('}');
  return lines.filter((line) => line !== '').join('\n');
}

export function renderTypes(document: OpenApiDocumentView): string {
  const blocks = [HEADER];
  blocks.push(
    docComment([
      `${document.title} v${document.version}`,
      `OpenAPI ${document.openapi}`,
    ]).trimEnd(),
  );

  for (const schema of document.schemas) {
    blocks.push(renderSchema(schema));
  }

  if (document.schemas.length === 0) {
    blocks.push('// La especificacion no declara esquemas en components.schemas.');
  }
  return `${blocks.filter((block) => block !== '').join('\n\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Firma de una operacion                                                     */
/* -------------------------------------------------------------------------- */

export interface OperationSignature {
  readonly name: string;
  /** Parametros de la funcion, ya formateados. */
  readonly args: readonly string[];
  /** Nombres de los parametros de ruta, en el orden en que aparecen. */
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly bodyType: string | null;
  readonly responseType: string;
  /** Plantilla de la URL, con los parametros ya interpolados. */
  readonly urlTemplate: string;
}

/** Tipo de la respuesta correcta (2xx); `void` si no devuelve cuerpo. */
export function successResponseType(operation: OpenApiOperation): string {
  const success = operation.responses.find((response) => /^2\d\d$/.test(response.status));
  const fallback = operation.responses.find((response) => response.status === 'default');
  const schemaRef = success?.schemaRef ?? fallback?.schemaRef;
  if (schemaRef !== undefined) {
    return schemaRef;
  }
  // 204 y 205 no llevan cuerpo por definicion.
  return success === undefined || success.status === '204' || success.status === '205'
    ? 'void'
    : 'unknown';
}

export function operationSignature(operation: OpenApiOperation): OperationSignature {
  const pathParams = operation.parameters
    .filter((parameter) => parameter.location === 'path')
    .map((parameter) => parameter.name);
  const queryParams = operation.parameters
    .filter((parameter) => parameter.location === 'query')
    .map((parameter) => parameter.name);

  const args: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.location !== 'path') {
      continue;
    }
    args.push(`${toCamelCase(parameter.name)}: ${parameter.type}`);
  }
  if (queryParams.length > 0) {
    const fields = operation.parameters
      .filter((parameter) => parameter.location === 'query')
      .map(
        (parameter) =>
          `${propertyKey(parameter.name)}${parameter.required ? '' : '?'}: ${parameter.type}`,
      )
      .join('; ');
    args.push(`query${queryParams.every((name) => isOptional(operation, name)) ? '?' : ''}: { ${fields} }`);
  }

  const bodyType = operation.requestBodyRef ?? null;
  if (bodyType !== null) {
    args.push(`body${operation.requestBodyRequired ? '' : '?'}: ${bodyType}`);
  }

  // `{id}` de OpenAPI se convierte en `${id}` de plantilla de TypeScript.
  const urlTemplate = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    `\${${toCamelCase(name)}}`,
  );

  return {
    name: toCamelCase(operation.id),
    args,
    pathParams,
    queryParams,
    bodyType,
    responseType: successResponseType(operation),
    urlTemplate,
  };
}

function isOptional(operation: OpenApiOperation, name: string): boolean {
  const parameter = operation.parameters.find((entry) => entry.name === name);
  return parameter === undefined || !parameter.required;
}

/* -------------------------------------------------------------------------- */
/*  Cliente tipado                                                             */
/* -------------------------------------------------------------------------- */

const CLIENT_PREAMBLE = [
  'export interface ApiClientOptions {',
  '  readonly baseUrl: string;',
  '  /** Se mezclan con las cabeceras de cada peticion. */',
  '  readonly headers?: Readonly<Record<string, string>>;',
  '  /** Permite inyectar un fetch propio en pruebas. */',
  '  readonly fetch?: typeof globalThis.fetch;',
  '}',
  '',
  'export class ApiError extends Error {',
  '  public readonly status: number;',
  '  public readonly body: unknown;',
  '',
  '  public constructor(status: number, body: unknown) {',
  '    super(`La peticion fallo con estado ${status}.`);',
  '    this.name = "ApiError";',
  '    this.status = status;',
  '    this.body = body;',
  '  }',
  '}',
  '',
  '/** Serializa la cadena de consulta omitiendo lo que no se paso. */',
  'function toQuery(params: Readonly<Record<string, unknown>> | undefined): string {',
  '  if (params === undefined) {',
  '    return "";',
  '  }',
  '  const search = new URLSearchParams();',
  '  for (const [key, value] of Object.entries(params)) {',
  '    if (value !== undefined && value !== null) {',
  '      search.set(key, String(value));',
  '    }',
  '  }',
  '  const text = search.toString();',
  '  return text === "" ? "" : `?${text}`;',
  '}',
].join('\n');

function renderClientMethod(operation: OpenApiOperation): string {
  const signature = operationSignature(operation);
  const lines: string[] = [];

  const doc = docComment(
    [
      operation.summary,
      operation.description,
      operation.deprecated ? '@deprecated Marcada como obsoleta en la especificacion.' : undefined,
      `${operation.method.toUpperCase()} ${operation.path}`,
    ],
    '  ',
  );
  if (doc !== '') {
    lines.push(doc.trimEnd());
  }

  lines.push(
    `  public async ${signature.name}(${signature.args.join(', ')}): Promise<${signature.responseType}> {`,
  );
  const query = signature.queryParams.length > 0 ? '${toQuery(query)}' : '';
  lines.push(`    const url = \`\${this.#baseUrl}${signature.urlTemplate}${query}\`;`);
  lines.push('    const response = await this.#fetch(url, {');
  lines.push(`      method: ${JSON.stringify(operation.method.toUpperCase())},`);
  lines.push('      headers: {');
  if (signature.bodyType !== null) {
    lines.push('        "Content-Type": "application/json",');
  }
  lines.push('        ...this.#headers,');
  lines.push('      },');
  if (signature.bodyType !== null) {
    lines.push('      body: body === undefined ? undefined : JSON.stringify(body),');
  }
  lines.push('    });');
  lines.push('    if (!response.ok) {');
  // El cuerpo del error puede no ser JSON: se intenta y se cae a texto.
  lines.push('      throw new ApiError(response.status, await response.text());');
  lines.push('    }');
  if (signature.responseType === 'void') {
    lines.push('    return;');
  } else {
    lines.push(`    return (await response.json()) as ${signature.responseType};`);
  }
  lines.push('  }');
  return lines.join('\n');
}

export function renderClient(document: OpenApiDocumentView): string {
  const blocks = [HEADER, CLIENT_PREAMBLE];

  const body: string[] = [];
  body.push(docComment([`Cliente de ${document.title} v${document.version}.`]).trimEnd());
  body.push('export class ApiClient {');
  body.push('  readonly #baseUrl: string;');
  body.push('  readonly #headers: Readonly<Record<string, string>>;');
  body.push('  readonly #fetch: typeof globalThis.fetch;');
  body.push('');
  body.push('  public constructor(options: ApiClientOptions) {');
  // Se quita la barra final para no generar `//api/users`.
  body.push('    this.#baseUrl = options.baseUrl.replace(/\\/$/, "");');
  body.push('    this.#headers = options.headers ?? {};');
  body.push('    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);');
  body.push('  }');

  for (const operation of document.operations) {
    body.push('');
    body.push(renderClientMethod(operation));
  }
  body.push('}');

  blocks.push(body.filter((line) => line !== undefined).join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Hooks de React                                                             */
/* -------------------------------------------------------------------------- */

const REACT_PREAMBLE = [
  "import { useCallback, useEffect, useRef, useState } from 'react';",
  '',
  'export interface QueryState<T> {',
  '  readonly data: T | null;',
  '  readonly error: Error | null;',
  '  readonly loading: boolean;',
  '  readonly refetch: () => void;',
  '}',
].join('\n');

/**
 * Hook de lectura.
 *
 * Cancela con `AbortController` al desmontar y descarta la respuesta si el
 * efecto ya se relanzo: sin eso, dos peticiones rapidas pueden resolverse en
 * orden inverso y dejar en pantalla el resultado antiguo.
 */
function renderReactQuery(operation: OpenApiOperation): string {
  const signature = operationSignature(operation);
  const hookName = `use${toPascalCase(operation.id)}`;
  const dependencies = [...signature.pathParams.map((name) => toCamelCase(name))];
  if (signature.queryParams.length > 0) {
    // El objeto de consulta se serializa como dependencia: comparar por
    // identidad relanzaria la peticion en cada render.
    dependencies.push('queryKey');
  }

  const lines: string[] = [];
  const doc = docComment(
    [operation.summary, `${operation.method.toUpperCase()} ${operation.path}`],
  );
  if (doc !== '') {
    lines.push(doc.trimEnd());
  }
  lines.push(
    `export function ${hookName}(${signature.args.join(', ')}): QueryState<${signature.responseType}> {`,
  );
  lines.push(`  const [data, setData] = useState<${signature.responseType} | null>(null);`);
  lines.push('  const [error, setError] = useState<Error | null>(null);');
  lines.push('  const [loading, setLoading] = useState(true);');
  lines.push('  const [nonce, setNonce] = useState(0);');
  if (signature.queryParams.length > 0) {
    lines.push('  const queryKey = JSON.stringify(query ?? {});');
  }
  lines.push('');
  lines.push('  useEffect(() => {');
  lines.push('    const controller = new AbortController();');
  lines.push('    setLoading(true);');
  const query = signature.queryParams.length > 0 ? '${toQuery(query)}' : '';
  lines.push(`    const url = \`\${API_BASE_URL}${signature.urlTemplate}${query}\`;`);
  lines.push('    fetch(url, { signal: controller.signal })');
  lines.push('      .then(async (response) => {');
  lines.push('        if (!response.ok) {');
  lines.push('          throw new Error(`La peticion fallo con estado ${response.status}.`);');
  lines.push('        }');
  lines.push(
    signature.responseType === 'void'
      ? '        return null;'
      : `        return (await response.json()) as ${signature.responseType};`,
  );
  lines.push('      })');
  lines.push('      .then((value) => {');
  lines.push('        setData(value);');
  lines.push('        setError(null);');
  lines.push('      })');
  lines.push('      .catch((cause: unknown) => {');
  // Abortar es lo normal al desmontar: no es un error que mostrar.
  lines.push('        if (cause instanceof DOMException && cause.name === "AbortError") {');
  lines.push('          return;');
  lines.push('        }');
  lines.push('        setError(cause instanceof Error ? cause : new Error(String(cause)));');
  lines.push('      })');
  lines.push('      .finally(() => setLoading(false));');
  lines.push('');
  lines.push('    return () => controller.abort();');
  lines.push(`  }, [${[...dependencies, 'nonce'].join(', ')}]);`);
  lines.push('');
  lines.push('  const refetch = useCallback(() => setNonce((value) => value + 1), []);');
  lines.push('  return { data, error, loading, refetch };');
  lines.push('}');
  return lines.join('\n');
}

/** Hook de mutacion: se dispara a mano y expone el estado de la llamada. */
function renderReactMutation(operation: OpenApiOperation): string {
  const signature = operationSignature(operation);
  const hookName = `use${toPascalCase(operation.id)}`;

  const lines: string[] = [];
  const doc = docComment(
    [operation.summary, `${operation.method.toUpperCase()} ${operation.path}`],
  );
  if (doc !== '') {
    lines.push(doc.trimEnd());
  }
  lines.push(`export function ${hookName}() {`);
  lines.push(`  const [data, setData] = useState<${signature.responseType} | null>(null);`);
  lines.push('  const [error, setError] = useState<Error | null>(null);');
  lines.push('  const [loading, setLoading] = useState(false);');
  // Evita avisar de un cambio de estado sobre un componente desmontado.
  lines.push('  const mounted = useRef(true);');
  lines.push('  useEffect(() => () => { mounted.current = false; }, []);');
  lines.push('');
  lines.push(`  const mutate = useCallback(async (${signature.args.join(', ')}) => {`);
  lines.push('    setLoading(true);');
  const query = signature.queryParams.length > 0 ? '${toQuery(query)}' : '';
  lines.push(`    const url = \`\${API_BASE_URL}${signature.urlTemplate}${query}\`;`);
  lines.push('    try {');
  lines.push('      const response = await fetch(url, {');
  lines.push(`        method: ${JSON.stringify(operation.method.toUpperCase())},`);
  if (signature.bodyType !== null) {
    lines.push('        headers: { "Content-Type": "application/json" },');
    lines.push('        body: body === undefined ? undefined : JSON.stringify(body),');
  }
  lines.push('      });');
  lines.push('      if (!response.ok) {');
  lines.push('        throw new Error(`La peticion fallo con estado ${response.status}.`);');
  lines.push('      }');
  lines.push(
    signature.responseType === 'void'
      ? '      const value = null;'
      : `      const value = (await response.json()) as ${signature.responseType};`,
  );
  lines.push('      if (mounted.current) {');
  lines.push('        setData(value);');
  lines.push('        setError(null);');
  lines.push('      }');
  lines.push('      return value;');
  lines.push('    } catch (cause: unknown) {');
  lines.push('      const failure = cause instanceof Error ? cause : new Error(String(cause));');
  lines.push('      if (mounted.current) {');
  lines.push('        setError(failure);');
  lines.push('      }');
  lines.push('      throw failure;');
  lines.push('    } finally {');
  lines.push('      if (mounted.current) {');
  lines.push('        setLoading(false);');
  lines.push('      }');
  lines.push('    }');
  lines.push('  }, []);');
  lines.push('');
  lines.push('  return { mutate, data, error, loading };');
  lines.push('}');
  return lines.join('\n');
}

/** true si la operacion solo lee: determina si el hook es query o mutacion. */
export function isReadOperation(operation: OpenApiOperation): boolean {
  return operation.method === 'get' || operation.method === 'head';
}

export function renderReactHooks(document: OpenApiDocumentView): string {
  const blocks = [HEADER, REACT_PREAMBLE];
  blocks.push(baseUrlConstant(document));
  if (document.operations.some((operation) => operation.parameters.some((p) => p.location === 'query'))) {
    blocks.push(QUERY_HELPER);
  }

  for (const operation of document.operations) {
    blocks.push(
      isReadOperation(operation) ? renderReactQuery(operation) : renderReactMutation(operation),
    );
  }
  return `${blocks.join('\n\n')}\n`;
}

const QUERY_HELPER = [
  '/** Serializa la cadena de consulta omitiendo lo que no se paso. */',
  'function toQuery(params: Readonly<Record<string, unknown>> | undefined): string {',
  '  if (params === undefined) {',
  '    return "";',
  '  }',
  '  const search = new URLSearchParams();',
  '  for (const [key, value] of Object.entries(params)) {',
  '    if (value !== undefined && value !== null) {',
  '      search.set(key, String(value));',
  '    }',
  '  }',
  '  const text = search.toString();',
  '  return text === "" ? "" : `?${text}`;',
  '}',
].join('\n');

function baseUrlConstant(document: OpenApiDocumentView): string {
  const server = document.servers[0] ?? '';
  return [
    '/** Base de la API. Ajustala o leela de tu configuracion de entorno. */',
    `export const API_BASE_URL = ${JSON.stringify(server.replace(/\/$/, ''))};`,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Composables de Vue                                                         */
/* -------------------------------------------------------------------------- */

const VUE_PREAMBLE = [
  "import { onScopeDispose, ref, shallowRef, watchEffect, type Ref } from 'vue';",
  '',
  'export interface QueryState<T> {',
  '  readonly data: Ref<T | null>;',
  '  readonly error: Ref<Error | null>;',
  '  readonly loading: Ref<boolean>;',
  '  readonly refetch: () => void;',
  '}',
].join('\n');

function renderVueComposable(operation: OpenApiOperation): string {
  const signature = operationSignature(operation);
  const name = `use${toPascalCase(operation.id)}`;

  const lines: string[] = [];
  const doc = docComment(
    [operation.summary, `${operation.method.toUpperCase()} ${operation.path}`],
  );
  if (doc !== '') {
    lines.push(doc.trimEnd());
  }
  lines.push(
    `export function ${name}(${signature.args.join(', ')}): QueryState<${signature.responseType}> {`,
  );
  lines.push(`  const data = shallowRef<${signature.responseType} | null>(null);`);
  lines.push('  const error = ref<Error | null>(null);');
  lines.push('  const loading = ref(true);');
  lines.push('  const nonce = ref(0);');
  lines.push('  let controller: AbortController | null = null;');
  lines.push('');
  lines.push('  watchEffect(() => {');
  lines.push('    // Se lee para que el efecto dependa de el y `refetch` funcione.');
  lines.push('    void nonce.value;');
  lines.push('    controller?.abort();');
  lines.push('    controller = new AbortController();');
  lines.push('    loading.value = true;');
  const query = signature.queryParams.length > 0 ? '${toQuery(query)}' : '';
  lines.push(`    const url = \`\${API_BASE_URL}${signature.urlTemplate}${query}\`;`);
  lines.push('    fetch(url, { signal: controller.signal })');
  lines.push('      .then(async (response) => {');
  lines.push('        if (!response.ok) {');
  lines.push('          throw new Error(`La peticion fallo con estado ${response.status}.`);');
  lines.push('        }');
  lines.push(
    signature.responseType === 'void'
      ? '        return null;'
      : `        return (await response.json()) as ${signature.responseType};`,
  );
  lines.push('      })');
  lines.push('      .then((value) => {');
  lines.push('        data.value = value;');
  lines.push('        error.value = null;');
  lines.push('      })');
  lines.push('      .catch((cause: unknown) => {');
  lines.push('        if (cause instanceof DOMException && cause.name === "AbortError") {');
  lines.push('          return;');
  lines.push('        }');
  lines.push('        error.value = cause instanceof Error ? cause : new Error(String(cause));');
  lines.push('      })');
  lines.push('      .finally(() => {');
  lines.push('        loading.value = false;');
  lines.push('      });');
  lines.push('  });');
  lines.push('');
  // El scope de Vue puede morir con la peticion en vuelo.
  lines.push('  onScopeDispose(() => controller?.abort());');
  lines.push('');
  lines.push('  return { data, error, loading, refetch: () => { nonce.value += 1; } };');
  lines.push('}');
  return lines.join('\n');
}

export function renderVueComposables(document: OpenApiDocumentView): string {
  const blocks = [HEADER, VUE_PREAMBLE, baseUrlConstant(document)];
  if (document.operations.some((operation) => operation.parameters.some((p) => p.location === 'query'))) {
    blocks.push(QUERY_HELPER);
  }
  for (const operation of document.operations) {
    blocks.push(renderVueComposable(operation));
  }
  return `${blocks.join('\n\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Punto de entrada                                                           */
/* -------------------------------------------------------------------------- */

/** Filtra el documento a las operaciones pedidas; vacio significa todas. */
export function narrowDocument(
  document: OpenApiDocumentView,
  operationIds: readonly string[] | undefined,
): OpenApiDocumentView {
  if (operationIds === undefined || operationIds.length === 0) {
    return document;
  }
  const wanted = new Set(operationIds);
  return {
    ...document,
    operations: document.operations.filter((operation) => wanted.has(operation.id)),
  };
}

export function generate(
  document: OpenApiDocumentView,
  target: SpecGenerationTarget,
): string {
  switch (target) {
    case 'types':
      return renderTypes(document);
    case 'client':
      return renderClient(document);
    case 'react-hooks':
      return renderReactHooks(document);
    case 'vue-composables':
      return renderVueComposables(document);
    default: {
      // Union exhaustiva: anadir un objetivo nuevo deja de compilar aqui.
      const unreachable: never = target;
      throw new Error(`Objetivo de generacion desconocido: ${String(unreachable)}`);
    }
  }
}

/** Nombre de archivo sugerido para cada objetivo. */
export function defaultOutputPath(specPath: string, target: SpecGenerationTarget): string {
  const directory = specPath.includes('/') ? specPath.slice(0, specPath.lastIndexOf('/')) : '';
  const prefix = directory === '' ? '' : `${directory}/`;
  switch (target) {
    case 'types':
      return `${prefix}api-types.ts`;
    case 'client':
      return `${prefix}api-client.ts`;
    case 'react-hooks':
      return `${prefix}api-hooks.ts`;
    case 'vue-composables':
      return `${prefix}api-composables.ts`;
    default:
      return `${prefix}api-generated.ts`;
  }
}
