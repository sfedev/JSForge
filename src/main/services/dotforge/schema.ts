/**
 * Esquema del manifiesto DotForge.
 *
 * Sirve para tres cosas a la vez:
 *  - Autocompletado y validacion en el editor (se entrega al cliente JSON
 *    de Monaco a traves del canal `dotforge/schema`).
 *  - Validacion en el proceso principal al leer y al escribir.
 *  - Documentacion viva del formato: cada campo lleva su descripcion.
 */

import { DOTFORGE_SCHEMA_VERSION } from '../../../shared/contracts.js';

export const DOTFORGE_SCHEMA_URI = 'https://dotforge.dev/schema/dotforge.config.json';

export const DOTFORGE_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: DOTFORGE_SCHEMA_URI,
  title: 'Manifiesto DotForge',
  description:
    'Define tareas, pipelines, entornos y servicios de un proyecto para el motor DotForge.',
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string', description: 'URI del esquema, para editores externos.' },
    $schemaVersion: {
      type: 'string',
      description: `Version del esquema. Actual: ${DOTFORGE_SCHEMA_VERSION}.`,
      default: DOTFORGE_SCHEMA_VERSION,
    },
    name: { type: 'string', description: 'Nombre del proyecto.', minLength: 1 },
    version: { type: 'string', description: 'Version del proyecto.' },
    description: { type: 'string', description: 'Descripcion breve del proyecto.' },
    runtime: {
      type: 'string',
      enum: ['node', 'bun', 'deno'],
      default: 'node',
      description: 'Runtime con el que se ejecutan las tareas.',
    },
    packageManager: {
      type: 'string',
      enum: ['npm', 'pnpm', 'yarn', 'bun'],
      description: 'Gestor de paquetes. Si se omite, se infiere del lockfile.',
    },
    preset: {
      type: 'string',
      description: 'Blueprint de arquitectura con el que se genero el proyecto.',
    },
    workspaces: {
      type: 'array',
      items: { type: 'string' },
      description: 'Rutas o patrones de los paquetes del monorepo.',
    },
    tasks: {
      type: 'object',
      description: 'Tareas invocables. La clave es el identificador de la tarea.',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'Etiqueta mostrada en la interfaz.' },
          command: { type: 'string', description: 'Comando completo a ejecutar.' },
          script: {
            type: 'string',
            description: 'Script de package.json a ejecutar con el gestor detectado.',
          },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string', description: 'Directorio relativo al workspace.' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          port: {
            type: 'integer',
            minimum: 1,
            maximum: 65535,
            description: 'Puerto esperado; genera el hipervinculo local en la salida.',
          },
          readyPattern: {
            type: 'string',
            description: 'Expresion regular que marca el proceso como listo.',
          },
          logFormat: {
            type: 'string',
            enum: ['auto', 'plain', 'pino', 'winston', 'bunyan', 'morgan', 'dotforge'],
            default: 'auto',
          },
          watch: { type: 'boolean', description: 'La tarea permanece viva observando cambios.' },
        },
      },
    },
    pipelines: {
      type: 'object',
      description: 'Composiciones de tareas lanzadas juntas desde el gestor de inicio.',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['tasks'],
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          tasks: { type: 'array', items: { type: 'string' }, minItems: 1 },
          parallel: {
            type: 'boolean',
            default: true,
            description: 'true lanza todas a la vez; false las encadena.',
          },
          environment: { type: 'string', description: 'Entorno aplicado a todas las tareas.' },
          stopOnError: { type: 'boolean', default: false },
        },
      },
    },
    environments: {
      type: 'object',
      description: 'Perfiles de variables de entorno.',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          envFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Archivos .env cargados en orden; los ultimos ganan.',
          },
          variables: { type: 'object', additionalProperties: { type: 'string' } },
          secrets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Claves siempre enmascaradas en la interfaz y en los registros.',
          },
        },
      },
    },
    services: {
      type: 'array',
      description: 'Servicios de apoyo (bases de datos, colas) del proyecto.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind'],
        properties: {
          name: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['postgres', 'mysql', 'mongo', 'redis', 'mailhog', 'other'],
          },
          composeFile: { type: 'string' },
          composeService: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          url: { type: 'string' },
        },
      },
    },
    ai: {
      type: 'object',
      additionalProperties: false,
      description: 'Ajustes del asistente integrado para este proyecto.',
      properties: {
        provider: { type: 'string', enum: ['anthropic', 'openai', 'ollama'] },
        model: { type: 'string' },
        excludeFromContext: {
          type: 'array',
          items: { type: 'string' },
          description: 'Patrones excluidos de la inyeccion contextual.',
        },
      },
    },
  },
} as const;
