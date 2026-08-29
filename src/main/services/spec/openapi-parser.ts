/**
 * Lector de especificaciones OpenAPI 3.x (y Swagger 2.0 en lo esencial).
 *
 * El documento se analiza como datos, nunca se evalua: un `openapi.json` es
 * contenido del proyecto y podria venir de cualquier sitio. El YAML reutiliza
 * el analizador acotado de `docker/compose-parser.ts` en lugar de anadir una
 * dependencia nueva.
 *
 * Todo lo publico de este modulo es puro: entra texto, sale una vista. Eso
 * permite probar el analisis sin tocar el disco y usarlo tal cual desde el
 * generador de codigo y desde el auditor de contratos.
 */

import type {
  OpenApiDocumentView,
  OpenApiMethod,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiResponse,
  OpenApiSchema,
  OpenApiSchemaField,
} from '../../../shared/contracts.js';
import { parseYaml, type YamlValue } from '../docker/compose-parser.js';

const METHODS: readonly OpenApiMethod[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
];

const PARAMETER_LOCATIONS = new Set(['path', 'query', 'header', 'cookie']);

type Record_ = Record<string, unknown>;

function asRecord(value: unknown): Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record_)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/*  Referencias                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Nombre corto de una referencia: `#/components/schemas/User` -> `User`.
 * Devuelve `null` si no es una referencia local, que es lo unico que este
 * lector resuelve (las externas exigirian leer otros archivos).
 */
export function refName(ref: string): string | null {
  if (!ref.startsWith('#/')) {
    return null;
  }
  const last = ref.split('/').pop() ?? '';
  return last === '' ? null : last;
}

/** Referencia declarada en un nodo, si la hay. */
function refOf(node: Record_): string | null {
  const ref = node['$ref'];
  return typeof ref === 'string' ? refName(ref) : null;
}

/* -------------------------------------------------------------------------- */
/*  Tipos                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Describe el tipo de un esquema en notacion de TypeScript.
 *
 * Se resuelve solo un nivel: los objetos anidados sin `$ref` se describen
 * como `Record<string, unknown>` en vez de expandirse, porque un esquema
 * recursivo colgaria el generador.
 */
export function schemaTypeName(schema: unknown): string {
  const node = asRecord(schema);

  const ref = refOf(node);
  if (ref !== null) {
    return ref;
  }

  // Las composiciones se traducen a uniones e intersecciones de TypeScript.
  for (const [key, separator] of [
    ['oneOf', ' | '],
    ['anyOf', ' | '],
    ['allOf', ' & '],
  ] as const) {
    const list = node[key];
    if (Array.isArray(list) && list.length > 0) {
      return list.map((entry) => schemaTypeName(entry)).join(separator);
    }
  }

  const enumValues = node['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues
      .map((value) => (typeof value === 'string' ? JSON.stringify(value) : String(value)))
      .join(' | ');
  }

  const type = asString(node['type']);
  switch (type) {
    case 'array':
      return `${wrapUnion(schemaTypeName(node['items']))}[]`;
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
      // `format: binary` es un archivo, no una cadena cualquiera.
      return asString(node['format']) === 'binary' ? 'Blob' : 'string';
    case 'object':
      return objectTypeName(node);
    case 'null':
      return 'null';
    default:
      return type === '' ? 'unknown' : type;
  }
}

/** Un tipo union necesita parentesis antes de `[]`. */
function wrapUnion(type: string): string {
  return type.includes(' | ') || type.includes(' & ') ? `(${type})` : type;
}

function objectTypeName(node: Record_): string {
  const additional = node['additionalProperties'];
  if (additional !== undefined && additional !== false) {
    const value = additional === true ? 'unknown' : schemaTypeName(additional);
    return `Record<string, ${value}>`;
  }
  return Object.keys(asRecord(node['properties'])).length === 0
    ? 'Record<string, unknown>'
    : 'Record<string, unknown>';
}

/* -------------------------------------------------------------------------- */
/*  Localizacion en el documento                                               */
/* -------------------------------------------------------------------------- */

/**
 * Linea aproximada de una clave dentro del documento.
 *
 * Es deliberadamente una busqueda textual: llevar la cuenta de posiciones a
 * traves de dos analizadores (JSON y YAML) obligaria a duplicar ambos, y
 * para saltar al sitio correcto en el editor basta con la primera aparicion
 * de la clave. Devuelve 1 cuando no la encuentra, que abre el archivo por
 * arriba en lugar de fallar.
 */
export function findLine(source: string, key: string): number {
  const lines = source.split(/\r?\n/);
  const needles = [`"${key}"`, `'${key}'`, `${key}:`];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (needles.some((needle) => line.includes(needle))) {
      return index + 1;
    }
  }
  return 1;
}

/* -------------------------------------------------------------------------- */
/*  Analisis del documento                                                     */
/* -------------------------------------------------------------------------- */

/** Convierte el texto en objeto, aceptando JSON o YAML segun la extension. */
export function parseSpecSource(relativePath: string, source: string): unknown {
  const trimmed = source.trimStart();
  // El contenido manda sobre la extension: hay `openapi.yaml` con JSON dentro.
  if (trimmed.startsWith('{')) {
    return JSON.parse(source) as unknown;
  }
  if (relativePath.endsWith('.json')) {
    return JSON.parse(source) as unknown;
  }
  return parseYaml(source) as YamlValue;
}

/** Cuerpo de peticion: referencia del esquema y si es obligatorio. */
function readRequestBody(
  operation: Record_,
): { ref: string | undefined; required: boolean; contentType: string | undefined } {
  const body = asRecord(operation['requestBody']);
  if (Object.keys(body).length === 0) {
    return { ref: undefined, required: false, contentType: undefined };
  }
  const content = asRecord(body['content']);
  const contentType = Object.keys(content)[0];
  const media = asRecord(content[contentType ?? '']);
  const type = schemaTypeName(media['schema']);
  return {
    ref: type === 'unknown' ? undefined : type,
    required: body['required'] === true,
    ...(contentType === undefined ? { contentType: undefined } : { contentType }),
  };
}

function readParameters(raw: unknown, warnings: string[]): OpenApiParameter[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const parameters: OpenApiParameter[] = [];
  for (const entry of raw) {
    const node = asRecord(entry);
    const name = asString(node['name']);
    const location = asString(node['in']);
    if (name === '') {
      // Un parametro por `$ref` se ignora: resolverlo exigiria un segundo
      // pase sobre `components.parameters`, y se avisa en vez de callar.
      if (node['$ref'] !== undefined) {
        warnings.push(`Parametro por referencia sin resolver: ${asString(node['$ref'])}.`);
      }
      continue;
    }
    if (!PARAMETER_LOCATIONS.has(location)) {
      warnings.push(`Parametro "${name}" con ubicacion desconocida: "${location}".`);
      continue;
    }
    const description = asString(node['description']);
    parameters.push({
      name,
      location: location as OpenApiParameter['location'],
      // Un parametro de ruta es obligatorio por definicion, lo declare o no.
      required: node['required'] === true || location === 'path',
      type: schemaTypeName(node['schema'] ?? node),
      ...(description === '' ? {} : { description }),
    });
  }
  return parameters;
}

function readResponses(raw: unknown): OpenApiResponse[] {
  const responses: OpenApiResponse[] = [];
  for (const [status, value] of Object.entries(asRecord(raw))) {
    const node = asRecord(value);
    const content = asRecord(node['content']);
    const contentType = Object.keys(content)[0];
    const media = asRecord(content[contentType ?? '']);
    const schemaRef = media['schema'] === undefined ? undefined : schemaTypeName(media['schema']);
    responses.push({
      status,
      description: asString(node['description'], ''),
      ...(schemaRef === undefined || schemaRef === 'unknown' ? {} : { schemaRef }),
      ...(contentType === undefined ? {} : { contentType }),
    });
  }
  return responses;
}

function readSchemas(components: Record_, source: string): OpenApiSchema[] {
  const schemas: OpenApiSchema[] = [];
  for (const [name, value] of Object.entries(asRecord(components['schemas']))) {
    const node = asRecord(value);
    const required = new Set(
      Array.isArray(node['required'])
        ? node['required'].filter((entry): entry is string => typeof entry === 'string')
        : [],
    );

    const fields: OpenApiSchemaField[] = [];
    for (const [fieldName, fieldValue] of Object.entries(asRecord(node['properties']))) {
      const field = asRecord(fieldValue);
      const enumValues = Array.isArray(field['enum'])
        ? field['enum'].map((entry) => String(entry))
        : undefined;
      const ref = refOf(field);
      const description = asString(field['description']);
      fields.push({
        name: fieldName,
        type: schemaTypeName(field),
        required: required.has(fieldName),
        // OpenAPI 3.0 usa `nullable`; 3.1 usa `type: [x, 'null']`.
        nullable: field['nullable'] === true,
        ...(enumValues === undefined ? {} : { enumValues }),
        ...(ref === null ? {} : { ref }),
        ...(description === '' ? {} : { description }),
      });
    }

    schemas.push({
      name,
      type: asString(node['type'], 'object'),
      fields,
      line: findLine(source, name),
    });
  }
  return schemas;
}

/**
 * Analiza el documento completo.
 *
 * Nunca lanza por un documento incompleto: lo que no se entiende se acumula
 * en `warnings` y el resto se devuelve igualmente. Un `openapi.yaml` a medio
 * escribir sigue siendo util para navegar.
 */
export function parseOpenApi(relativePath: string, source: string): OpenApiDocumentView {
  const warnings: string[] = [];
  let document: Record_;
  try {
    document = asRecord(parseSpecSource(relativePath, source));
  } catch (cause) {
    throw Object.assign(new Error('El documento no es JSON ni YAML valido.'), {
      forge: {
        code: 'E_PARSE' as const,
        message: 'El documento no es JSON ni YAML valido.',
        detail: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }

  const info = asRecord(document['info']);
  const openapi = asString(document['openapi']) || asString(document['swagger']);
  if (openapi === '') {
    warnings.push('El documento no declara la version de OpenAPI ni de Swagger.');
  }

  const servers: string[] = [];
  if (Array.isArray(document['servers'])) {
    for (const entry of document['servers']) {
      const url = asString(asRecord(entry)['url']);
      if (url !== '') {
        servers.push(url);
      }
    }
  }
  // Swagger 2.0 no tiene `servers`: se reconstruye de host + basePath.
  const host = asString(document['host']);
  if (servers.length === 0 && host !== '') {
    servers.push(`https://${host}${asString(document['basePath'])}`);
  }

  const operations: OpenApiOperation[] = [];
  for (const [routePath, pathValue] of Object.entries(asRecord(document['paths']))) {
    const pathItem = asRecord(pathValue);
    // Los parametros del nivel de ruta aplican a todas sus operaciones.
    const shared = readParameters(pathItem['parameters'], warnings);

    for (const method of METHODS) {
      const raw = pathItem[method];
      if (raw === undefined) {
        continue;
      }
      const operation = asRecord(raw);
      const body = readRequestBody(operation);
      const summary = asString(operation['summary']);
      const description = asString(operation['description']);

      operations.push({
        id: asString(operation['operationId']) || `${method}:${routePath}`,
        method,
        path: routePath,
        ...(summary === '' ? {} : { summary }),
        ...(description === '' ? {} : { description }),
        tags: Array.isArray(operation['tags'])
          ? operation['tags'].filter((tag): tag is string => typeof tag === 'string')
          : [],
        deprecated: operation['deprecated'] === true,
        parameters: [...shared, ...readParameters(operation['parameters'], warnings)],
        ...(body.ref === undefined ? {} : { requestBodyRef: body.ref }),
        requestBodyRequired: body.required,
        responses: readResponses(operation['responses']),
        line: findLine(source, routePath),
      });
    }
  }

  if (operations.length === 0) {
    warnings.push('El documento no declara ninguna operacion en "paths".');
  }

  return {
    path: relativePath,
    title: asString(info['title'], relativePath),
    version: asString(info['version'], '0.0.0'),
    openapi: openapi === '' ? 'desconocida' : openapi,
    servers,
    operations,
    // Swagger 2.0 pone los esquemas en `definitions`.
    schemas: readSchemas(
      Object.keys(asRecord(document['components'])).length > 0
        ? asRecord(document['components'])
        : { schemas: document['definitions'] },
      source,
    ),
    warnings,
  };
}
