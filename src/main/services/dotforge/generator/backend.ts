/**
 * Blueprints de servidor: Express con arquitectura hexagonal, NestJS modular
 * y Fastify con plugins tipados.
 */

import {
  addDocker,
  addQualityTooling,
  addTesting,
  dotforgeConfig,
  editorconfig,
  envExample,
  gitignore,
  qualityDependencies,
  qualityScripts,
  readme,
  tsconfig,
} from './common.js';
import { prismaSchema } from './frontend.js';
import { BACKEND_OPTIONS } from './options.js';
import { json, type BlueprintContext, type BlueprintDefinition, type FileMap } from './types.js';

/** URL de conexion por defecto segun la base de datos elegida. */
function databaseUrl(database: string, name: string): string {
  switch (database) {
    case 'mysql':
      return `mysql://root:root@localhost:3306/${name}`;
    case 'mongo':
      return `mongodb://app:app@localhost:27017/${name}?authSource=admin`;
    case 'none':
      return '';
    case 'postgres':
    default:
      return `postgresql://app:app@localhost:5432/${name}?schema=public`;
  }
}

/** Dependencias del ORM elegido. */
function ormDependencies(orm: string): { runtime: Record<string, string>; dev: Record<string, string> } {
  switch (orm) {
    case 'prisma':
      return { runtime: { '@prisma/client': '^6.1.0' }, dev: { prisma: '^6.1.0' } };
    case 'typeorm':
      return { runtime: { typeorm: '^0.3.20', 'reflect-metadata': '^0.2.2', pg: '^8.13.1' }, dev: { '@types/pg': '^8.11.10' } };
    case 'drizzle':
      return { runtime: { 'drizzle-orm': '^0.38.3', postgres: '^3.4.5' }, dev: { 'drizzle-kit': '^0.30.1' } };
    default:
      return { runtime: {}, dev: {} };
  }
}

/** Archivos del ORM elegido, comunes a todos los backends. */
function ormFiles(context: BlueprintContext, files: FileMap): void {
  const orm = context.choice('orm', 'prisma');
  const database = context.choice('database', 'postgres');

  if (orm === 'prisma') {
    files.set('prisma/schema.prisma', prismaSchema(database));
    files.set(
      'src/infrastructure/persistence/prisma-client.ts',
      [
        "import { PrismaClient } from '@prisma/client';",
        '',
        '// Cliente unico por proceso: crear uno por peticion agota el pool.',
        'export const prisma = new PrismaClient();',
        '',
        'export async function cerrarPrisma(): Promise<void> {',
        '  await prisma.$disconnect();',
        '}',
        '',
      ].join('\n'),
    );
  } else if (orm === 'drizzle') {
    files.set(
      'src/infrastructure/persistence/schema.ts',
      [
        "import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';",
        '',
        "export const items = pgTable('items', {",
        "  id: serial('id').primaryKey(),",
        "  nombre: text('nombre').notNull(),",
        "  cantidad: integer('cantidad').notNull().default(1),",
        "  creadoEn: timestamp('creado_en').notNull().defaultNow(),",
        '});',
        '',
        'export type Item = typeof items.$inferSelect;',
        'export type NuevoItem = typeof items.$inferInsert;',
        '',
      ].join('\n'),
    );
    files.set(
      'src/infrastructure/persistence/db.ts',
      [
        "import { drizzle } from 'drizzle-orm/postgres-js';",
        "import postgres from 'postgres';",
        '',
        "import * as schema from './schema.js';",
        '',
        'const url = process.env.DATABASE_URL;',
        'if (url === undefined || url === \'\') {',
        "  throw new Error('Falta DATABASE_URL en el entorno.');",
        '}',
        '',
        'const cliente = postgres(url, { max: 10 });',
        'export const db = drizzle(cliente, { schema });',
        '',
      ].join('\n'),
    );
    files.set(
      'drizzle.config.ts',
      [
        "import { defineConfig } from 'drizzle-kit';",
        '',
        'export default defineConfig({',
        "  schema: './src/infrastructure/persistence/schema.ts',",
        "  out: './drizzle',",
        "  dialect: 'postgresql',",
        "  dbCredentials: { url: process.env.DATABASE_URL ?? '' },",
        '});',
        '',
      ].join('\n'),
    );
  } else if (orm === 'typeorm') {
    files.set(
      'src/infrastructure/persistence/item.entity.ts',
      [
        "import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';",
        '',
        "@Entity('items')",
        'export class ItemEntity {',
        "  @PrimaryGeneratedColumn('increment')",
        '  id!: number;',
        '',
        "  @Column({ type: 'varchar', length: 200 })",
        '  nombre!: string;',
        '',
        "  @Column({ type: 'int', default: 1 })",
        '  cantidad!: number;',
        '',
        '  @CreateDateColumn()',
        '  creadoEn!: Date;',
        '}',
        '',
      ].join('\n'),
    );
    files.set(
      'src/infrastructure/persistence/data-source.ts',
      [
        "import 'reflect-metadata';",
        "import { DataSource } from 'typeorm';",
        '',
        "import { ItemEntity } from './item.entity.js';",
        '',
        'export const dataSource = new DataSource({',
        "  type: 'postgres',",
        "  url: process.env.DATABASE_URL ?? '',",
        '  entities: [ItemEntity],',
        '  // Las migraciones se generan explicitamente; `synchronize` en',
        '  // produccion destruye datos sin avisar.',
        '  synchronize: false,',
        "  migrations: ['dist/migrations/*.js'],",
        '});',
        '',
      ].join('\n'),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Express — arquitectura hexagonal                                           */
/* -------------------------------------------------------------------------- */

const EXPRESS_HEXAGONAL: BlueprintDefinition = {
  id: 'express-hexagonal',
  label: 'Express (arquitectura hexagonal)',
  category: 'backend',
  description:
    'Express en TypeScript con dominio, casos de uso e infraestructura separados; los puertos se definen en el dominio y los adaptadores los implementan.',
  tags: ['express', 'hexagonal', 'clean-architecture'],
  options: BACKEND_OPTIONS,

  build(context) {
    const files: FileMap = new Map();
    const orm = context.choice('orm', 'prisma');
    const database = context.choice('database', 'postgres');
    const ormDeps = ormDependencies(orm);

    files.set(
      'package.json',
      json({
        name: context.packageName,
        version: '0.1.0',
        private: true,
        type: 'module',
        main: 'dist/main.js',
        scripts: {
          dev: 'tsx watch src/main.ts',
          build: 'tsc -p tsconfig.json',
          start: 'node dist/main.js',
          typecheck: 'tsc --noEmit',
          ...(orm === 'prisma' ? { 'db:migrate': 'prisma migrate dev', 'db:studio': 'prisma studio' } : {}),
          ...(orm === 'drizzle' ? { 'db:push': 'drizzle-kit push' } : {}),
          ...qualityScripts(context),
        },
        dependencies: {
          express: '^4.21.2',
          helmet: '^8.0.0',
          cors: '^2.8.5',
          pino: '^9.6.0',
          'pino-http': '^10.3.0',
          zod: '^3.24.1',
          ...ormDeps.runtime,
        },
        devDependencies: {
          '@types/cors': '^2.8.17',
          '@types/express': '^5.0.0',
          '@types/node': '^22.10.2',
          tsx: '^4.19.2',
          typescript: '^5.7.2',
          ...ormDeps.dev,
          ...qualityDependencies(context, false),
        },
      }),
    );

    files.set(
      'tsconfig.json',
      tsconfig({
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: false,
        types: ['node'],
        paths: { '@/*': ['./src/*'] },
      }),
    );

    /* --- Dominio: entidades y puertos --- */
    files.set(
      'src/domain/item.ts',
      [
        '/**',
        ' * Entidad del dominio. No conoce Express, ni la base de datos, ni el',
        ' * transporte: solo las reglas del negocio.',
        ' */',
        'export interface Item {',
        '  readonly id: string;',
        '  readonly nombre: string;',
        '  readonly cantidad: number;',
        '  readonly creadoEn: Date;',
        '}',
        '',
        'export class ItemInvalidoError extends Error {',
        '  public constructor(motivo: string) {',
        '    super(`Item invalido: ${motivo}`);',
        "    this.name = 'ItemInvalidoError';",
        '  }',
        '}',
        '',
        '/** Invariante del dominio, comprobada al crear. */',
        'export function crearItem(nombre: string, cantidad: number, id: string): Item {',
        "  if (nombre.trim() === '') {",
        "    throw new ItemInvalidoError('el nombre no puede estar vacio');",
        '  }',
        '  if (!Number.isInteger(cantidad) || cantidad <= 0) {',
        "    throw new ItemInvalidoError('la cantidad debe ser un entero positivo');",
        '  }',
        '  return { id, nombre: nombre.trim(), cantidad, creadoEn: new Date() };',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/domain/ports/item-repository.ts',
      [
        "import type { Item } from '../item.js';",
        '',
        '/**',
        ' * Puerto de salida. El dominio declara lo que necesita; la',
        ' * infraestructura decide como cumplirlo.',
        ' */',
        'export interface ItemRepository {',
        '  listar(): Promise<readonly Item[]>;',
        '  buscarPorId(id: string): Promise<Item | null>;',
        '  guardar(item: Item): Promise<void>;',
        '  eliminar(id: string): Promise<boolean>;',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/domain/ports/id-generator.ts',
      [
        '/** Puerto de generacion de identificadores, para poder fijarlos en pruebas. */',
        'export interface IdGenerator {',
        '  siguiente(): string;',
        '}',
        '',
      ].join('\n'),
    );

    /* --- Casos de uso --- */
    files.set(
      'src/application/crear-item.ts',
      [
        "import { crearItem, type Item } from '../domain/item.js';",
        "import type { IdGenerator } from '../domain/ports/id-generator.js';",
        "import type { ItemRepository } from '../domain/ports/item-repository.js';",
        '',
        'export interface CrearItemEntrada {',
        '  readonly nombre: string;',
        '  readonly cantidad: number;',
        '}',
        '',
        '/**',
        ' * Caso de uso. Recibe sus dependencias por parametro: no importa nada',
        ' * de infraestructura, asi que se prueba sin base de datos.',
        ' */',
        'export function crearItemUseCase(',
        '  repositorio: ItemRepository,',
        '  generador: IdGenerator,',
        ') {',
        '  return async function ejecutar(entrada: CrearItemEntrada): Promise<Item> {',
        '    const item = crearItem(entrada.nombre, entrada.cantidad, generador.siguiente());',
        '    await repositorio.guardar(item);',
        '    return item;',
        '  };',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/application/listar-items.ts',
      [
        "import type { Item } from '../domain/item.js';",
        "import type { ItemRepository } from '../domain/ports/item-repository.js';",
        '',
        'export function listarItemsUseCase(repositorio: ItemRepository) {',
        '  return async function ejecutar(): Promise<readonly Item[]> {',
        '    return repositorio.listar();',
        '  };',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/application/crear-item.test.ts',
      [
        "import { describe, expect, it } from 'vitest';",
        '',
        "import { crearItemUseCase } from './crear-item.js';",
        "import type { Item } from '../domain/item.js';",
        "import type { ItemRepository } from '../domain/ports/item-repository.js';",
        '',
        '/** Doble en memoria: el caso de uso no necesita base de datos. */',
        'function repositorioFalso(): ItemRepository & { almacen: Item[] } {',
        '  const almacen: Item[] = [];',
        '  return {',
        '    almacen,',
        '    listar: async () => almacen,',
        '    buscarPorId: async (id) => almacen.find((item) => item.id === id) ?? null,',
        '    guardar: async (item) => {',
        '      almacen.push(item);',
        '    },',
        '    eliminar: async (id) => {',
        '      const indice = almacen.findIndex((item) => item.id === id);',
        '      if (indice === -1) {',
        '        return false;',
        '      }',
        '      almacen.splice(indice, 1);',
        '      return true;',
        '    },',
        '  };',
        '}',
        '',
        "describe('crearItemUseCase', () => {",
        "  it('guarda el item y devuelve la entidad creada', async () => {",
        '    const repositorio = repositorioFalso();',
        "    const ejecutar = crearItemUseCase(repositorio, { siguiente: () => 'id-1' });",
        '',
        "    const item = await ejecutar({ nombre: 'Tornillo', cantidad: 3 });",
        '',
        "    expect(item.id).toBe('id-1');",
        '    expect(repositorio.almacen).toHaveLength(1);',
        '  });',
        '',
        "  it('rechaza una cantidad no positiva', async () => {",
        '    const repositorio = repositorioFalso();',
        "    const ejecutar = crearItemUseCase(repositorio, { siguiente: () => 'id-1' });",
        '',
        "    await expect(ejecutar({ nombre: 'Tornillo', cantidad: 0 })).rejects.toThrow();",
        '    expect(repositorio.almacen).toHaveLength(0);',
        '  });',
        '});',
        '',
      ].join('\n'),
    );

    /* --- Infraestructura --- */
    files.set(
      'src/infrastructure/persistence/memory-item-repository.ts',
      [
        "import type { Item } from '../../domain/item.js';",
        "import type { ItemRepository } from '../../domain/ports/item-repository.js';",
        '',
        '/** Adaptador en memoria: util para arrancar y para las pruebas. */',
        'export class MemoryItemRepository implements ItemRepository {',
        '  readonly #items = new Map<string, Item>();',
        '',
        '  public async listar(): Promise<readonly Item[]> {',
        '    return [...this.#items.values()];',
        '  }',
        '',
        '  public async buscarPorId(id: string): Promise<Item | null> {',
        '    return this.#items.get(id) ?? null;',
        '  }',
        '',
        '  public async guardar(item: Item): Promise<void> {',
        '    this.#items.set(item.id, item);',
        '  }',
        '',
        '  public async eliminar(id: string): Promise<boolean> {',
        '    return this.#items.delete(id);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/infrastructure/http/item-router.ts',
      [
        "import { Router } from 'express';",
        "import { z } from 'zod';",
        '',
        "import { crearItemUseCase } from '../../application/crear-item.js';",
        "import { listarItemsUseCase } from '../../application/listar-items.js';",
        "import { ItemInvalidoError } from '../../domain/item.js';",
        "import type { IdGenerator } from '../../domain/ports/id-generator.js';",
        "import type { ItemRepository } from '../../domain/ports/item-repository.js';",
        '',
        'const EsquemaCrear = z.object({',
        "  nombre: z.string().min(1, 'El nombre es obligatorio.'),",
        '  cantidad: z.number().int().positive().default(1),',
        '});',
        '',
        '/** Adaptador de entrada: traduce HTTP a casos de uso y viceversa. */',
        'export function crearItemRouter(repositorio: ItemRepository, generador: IdGenerator): Router {',
        '  const router = Router();',
        '  const listar = listarItemsUseCase(repositorio);',
        '  const crear = crearItemUseCase(repositorio, generador);',
        '',
        "  router.get('/', async (_peticion, respuesta) => {",
        '    respuesta.json({ items: await listar() });',
        '  });',
        '',
        "  router.post('/', async (peticion, respuesta) => {",
        '    const resultado = EsquemaCrear.safeParse(peticion.body);',
        '    if (!resultado.success) {',
        '      respuesta.status(422).json({ error: resultado.error.flatten() });',
        '      return;',
        '    }',
        '    try {',
        '      respuesta.status(201).json({ item: await crear(resultado.data) });',
        '    } catch (causa) {',
        '      if (causa instanceof ItemInvalidoError) {',
        '        respuesta.status(422).json({ error: causa.message });',
        '        return;',
        '      }',
        '      throw causa;',
        '    }',
        '  });',
        '',
        '  return router;',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/infrastructure/http/server.ts',
      [
        "import cors from 'cors';",
        "import express, { type Express, type NextFunction, type Request, type Response } from 'express';",
        "import helmet from 'helmet';",
        "import pinoHttp from 'pino-http';",
        '',
        "import { MemoryItemRepository } from '../persistence/memory-item-repository.js';",
        "import { crearItemRouter } from './item-router.js';",
        '',
        'export function crearServidor(): Express {',
        '  const app = express();',
        '',
        '  app.use(helmet());',
        '  app.use(cors());',
        '  app.use(express.json({ limit: \'1mb\' }));',
        '  app.use(pinoHttp());',
        '',
        '  const repositorio = new MemoryItemRepository();',
        '  const generador = { siguiente: (): string => crypto.randomUUID() };',
        '',
        "  app.get('/health', (_peticion, respuesta) => {",
        "    respuesta.json({ estado: 'ok' });",
        '  });',
        '',
        "  app.use('/api/items', crearItemRouter(repositorio, generador));",
        '',
        '  // Manejador de errores: cuatro parametros, obligatorio en Express.',
        '  app.use((error: Error, _peticion: Request, respuesta: Response, _siguiente: NextFunction) => {',
        '    respuesta.status(500).json({ error: error.message });',
        '  });',
        '',
        '  return app;',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/main.ts',
      [
        "import pino from 'pino';",
        '',
        "import { crearServidor } from './infrastructure/http/server.js';",
        '',
        'const log = pino();',
        'const puerto = Number.parseInt(process.env.PORT ?? \'3000\', 10);',
        '',
        'const servidor = crearServidor().listen(puerto, () => {',
        '  log.info(`Server listening on port ${puerto}`);',
        '});',
        '',
        '// Apagado ordenado: sin esto, un despliegue corta peticiones a medias.',
        "for (const senal of ['SIGINT', 'SIGTERM'] as const) {",
        '  process.on(senal, () => {',
        '    log.info(`Recibida ${senal}; cerrando el servidor.`);',
        '    servidor.close(() => process.exit(0));',
        '  });',
        '}',
        '',
      ].join('\n'),
    );

    ormFiles(context, files);

    files.set(
      '.env.example',
      envExample({
        PORT: '3000',
        NODE_ENV: 'development',
        ...(database === 'none' ? {} : { DATABASE_URL: databaseUrl(database, context.packageName) }),
      }),
    );

    addQualityTooling(files, context);
    addTesting(files, context, {
      environment: 'node',
      baseUrl: 'http://localhost:3000',
      devCommand: `${context.packageManager} run dev`,
    });
    addDocker(files, context, { startCommand: '["node", "dist/main.js"]', port: 3000 });
    files.set('.gitignore', gitignore());
    files.set('.editorconfig', editorconfig());

    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: context.packageName,
        version: '0.1.0',
        preset: 'express-hexagonal',
        packageManager: context.packageManager,
        tasks: {
          dev: {
            label: 'API en desarrollo',
            script: 'dev',
            port: 3000,
            readyPattern: 'Server listening on',
            logFormat: 'pino',
            watch: true,
          },
          build: { label: 'Compilar', script: 'build' },
          test: { label: 'Pruebas', script: 'test' },
          lint: { label: 'Analisis estatico', script: 'lint' },
          ...(orm === 'prisma' ? { migrate: { label: 'Migraciones', script: 'db:migrate' } } : {}),
        },
        pipelines: {
          dev: { label: 'Dev completo', tasks: ['dev'], parallel: true, environment: 'local' },
          ci: { label: 'Verificacion', tasks: ['lint', 'test', 'build'], parallel: false, stopOnError: true },
        },
        environments: {
          local: { label: 'Local', envFiles: ['.env'], secrets: ['DATABASE_URL'] },
        },
        ...(database === 'none'
          ? {}
          : {
              services: [
                {
                  name: 'db',
                  kind: database as 'postgres',
                  composeFile: 'docker-compose.yml',
                  composeService: 'db',
                },
              ],
            }),
      }),
    );

    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: 'API Express con arquitectura hexagonal en TypeScript estricto.',
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'API con recarga en caliente.' },
          { command: 'build', description: 'Compila a `dist/`.' },
          { command: 'test', description: 'Pruebas de los casos de uso.' },
          { command: 'lint', description: 'Analisis estatico.' },
        ],
        structure: [
          'src/',
          '  domain/          entidades y puertos (sin dependencias)',
          '  application/     casos de uso',
          '  infrastructure/  adaptadores: HTTP y persistencia',
          '  main.ts          composicion y arranque',
        ],
        notes: [
          'El dominio no importa nada de infraestructura: esa es la regla que sostiene la arquitectura.',
          'El repositorio en memoria permite arrancar sin base de datos; sustituyelo por el adaptador real cuando toque.',
        ],
      }),
    );
    return files;
  },

  nextSteps(context) {
    const steps = [`${context.packageManager} install`, 'cp .env.example .env'];
    if (context.choice('database', 'postgres') !== 'none' && context.flag('docker')) {
      steps.push('docker compose up -d');
    }
    if (context.choice('orm', 'prisma') === 'prisma') {
      steps.push('npx prisma migrate dev --name inicial');
    }
    steps.push(`${context.packageManager} run dev`, 'Abre http://localhost:3000/health');
    return steps;
  },
};

/* -------------------------------------------------------------------------- */
/*  NestJS                                                                     */
/* -------------------------------------------------------------------------- */

const NESTJS: BlueprintDefinition = {
  id: 'nestjs-modular',
  label: 'NestJS (modular)',
  category: 'backend',
  description: 'NestJS 10 con modulos, DTO validados, filtro de excepciones y ORM configurable.',
  tags: ['nestjs', 'modular', 'api'],
  options: BACKEND_OPTIONS,

  build(context) {
    const files: FileMap = new Map();
    const orm = context.choice('orm', 'prisma');
    const database = context.choice('database', 'postgres');
    const ormDeps = ormDependencies(orm);

    files.set(
      'package.json',
      json({
        name: context.packageName,
        version: '0.1.0',
        private: true,
        scripts: {
          dev: 'nest start --watch',
          build: 'nest build',
          start: 'node dist/main.js',
          typecheck: 'tsc --noEmit',
          ...(orm === 'prisma' ? { 'db:migrate': 'prisma migrate dev' } : {}),
          ...qualityScripts(context),
        },
        dependencies: {
          '@nestjs/common': '^10.4.15',
          '@nestjs/config': '^3.3.0',
          '@nestjs/core': '^10.4.15',
          '@nestjs/platform-express': '^10.4.15',
          'class-transformer': '^0.5.1',
          'class-validator': '^0.14.1',
          helmet: '^8.0.0',
          'reflect-metadata': '^0.2.2',
          rxjs: '^7.8.1',
          ...ormDeps.runtime,
        },
        devDependencies: {
          '@nestjs/cli': '^10.4.9',
          '@nestjs/schematics': '^10.2.3',
          '@types/express': '^5.0.0',
          '@types/node': '^22.10.2',
          typescript: '^5.7.2',
          ...ormDeps.dev,
          ...qualityDependencies(context, false),
        },
      }),
    );

    files.set(
      'nest-cli.json',
      json({
        $schema: 'https://json.schemastore.org/nest-cli',
        collection: '@nestjs/schematics',
        sourceRoot: 'src',
        compilerOptions: { deleteOutDir: true },
      }),
    );

    files.set(
      'tsconfig.json',
      tsconfig({
        module: 'CommonJS',
        moduleResolution: 'Node',
        noEmit: false,
        types: ['node'],
        extra: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          // Nest crea las propiedades en el constructor mediante decoradores.
          strictPropertyInitialization: false,
          useDefineForClassFields: false,
        },
      }),
    );

    files.set(
      'src/main.ts',
      [
        "import 'reflect-metadata';",
        '',
        "import { ValidationPipe } from '@nestjs/common';",
        "import { NestFactory } from '@nestjs/core';",
        "import helmet from 'helmet';",
        '',
        "import { AppModule } from './app.module.js';",
        '',
        'async function arrancar(): Promise<void> {',
        '  const app = await NestFactory.create(AppModule);',
        '',
        '  app.use(helmet());',
        '  app.enableCors();',
        '  // `whitelist` descarta las propiedades no declaradas en el DTO;',
        '  // `forbidNonWhitelisted` ademas rechaza la peticion.',
        '  app.useGlobalPipes(',
        '    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),',
        '  );',
        '  app.enableShutdownHooks();',
        '',
        "  const puerto = Number.parseInt(process.env.PORT ?? '3000', 10);",
        '  await app.listen(puerto);',
        '}',
        '',
        'void arrancar();',
        '',
      ].join('\n'),
    );

    files.set(
      'src/app.module.ts',
      [
        "import { Module } from '@nestjs/common';",
        "import { ConfigModule } from '@nestjs/config';",
        '',
        "import { ItemsModule } from './items/items.module.js';",
        "import { SaludController } from './salud/salud.controller.js';",
        '',
        '@Module({',
        '  imports: [ConfigModule.forRoot({ isGlobal: true }), ItemsModule],',
        '  controllers: [SaludController],',
        '})',
        'export class AppModule {}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/salud/salud.controller.ts',
      [
        "import { Controller, Get } from '@nestjs/common';",
        '',
        "@Controller('health')",
        'export class SaludController {',
        '  @Get()',
        '  comprobar(): { estado: string; hora: string } {',
        "    return { estado: 'ok', hora: new Date().toISOString() };",
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/items/dto/crear-item.dto.ts',
      [
        "import { IsInt, IsPositive, IsString, MinLength } from 'class-validator';",
        '',
        'export class CrearItemDto {',
        '  @IsString()',
        '  @MinLength(1, { message: \'El nombre es obligatorio.\' })',
        '  nombre!: string;',
        '',
        '  @IsInt()',
        '  @IsPositive()',
        '  cantidad!: number;',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/items/items.service.ts',
      [
        "import { Injectable, NotFoundException } from '@nestjs/common';",
        '',
        "import type { CrearItemDto } from './dto/crear-item.dto.js';",
        '',
        'export interface Item {',
        '  readonly id: string;',
        '  readonly nombre: string;',
        '  readonly cantidad: number;',
        '}',
        '',
        '@Injectable()',
        'export class ItemsService {',
        '  readonly #items = new Map<string, Item>();',
        '',
        '  listar(): readonly Item[] {',
        '    return [...this.#items.values()];',
        '  }',
        '',
        '  buscar(id: string): Item {',
        '    const item = this.#items.get(id);',
        '    if (item === undefined) {',
        '      throw new NotFoundException(`No existe el item ${id}.`);',
        '    }',
        '    return item;',
        '  }',
        '',
        '  crear(datos: CrearItemDto): Item {',
        '    const item: Item = { id: crypto.randomUUID(), ...datos };',
        '    this.#items.set(item.id, item);',
        '    return item;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/items/items.controller.ts',
      [
        "import { Body, Controller, Get, Param, Post } from '@nestjs/common';",
        '',
        "import { CrearItemDto } from './dto/crear-item.dto.js';",
        "import { ItemsService, type Item } from './items.service.js';",
        '',
        "@Controller('api/items')",
        'export class ItemsController {',
        '  constructor(private readonly items: ItemsService) {}',
        '',
        '  @Get()',
        '  listar(): { items: readonly Item[] } {',
        '    return { items: this.items.listar() };',
        '  }',
        '',
        "  @Get(':id')",
        "  buscar(@Param('id') id: string): { item: Item } {",
        '    return { item: this.items.buscar(id) };',
        '  }',
        '',
        '  @Post()',
        '  crear(@Body() datos: CrearItemDto): { item: Item } {',
        '    return { item: this.items.crear(datos) };',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/items/items.module.ts',
      [
        "import { Module } from '@nestjs/common';",
        '',
        "import { ItemsController } from './items.controller.js';",
        "import { ItemsService } from './items.service.js';",
        '',
        '@Module({',
        '  controllers: [ItemsController],',
        '  providers: [ItemsService],',
        '  exports: [ItemsService],',
        '})',
        'export class ItemsModule {}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/items/items.service.test.ts',
      [
        "import { describe, expect, it } from 'vitest';",
        '',
        "import { ItemsService } from './items.service.js';",
        '',
        "describe('ItemsService', () => {",
        "  it('crea y recupera un item', () => {",
        '    const servicio = new ItemsService();',
        "    const item = servicio.crear({ nombre: 'Tuerca', cantidad: 2 });",
        '',
        '    expect(servicio.buscar(item.id)).toEqual(item);',
        '    expect(servicio.listar()).toHaveLength(1);',
        '  });',
        '',
        "  it('lanza si el item no existe', () => {",
        '    const servicio = new ItemsService();',
        "    expect(() => servicio.buscar('desconocido')).toThrow();",
        '  });',
        '});',
        '',
      ].join('\n'),
    );

    ormFiles(context, files);

    files.set(
      '.env.example',
      envExample({
        PORT: '3000',
        NODE_ENV: 'development',
        ...(database === 'none' ? {} : { DATABASE_URL: databaseUrl(database, context.packageName) }),
      }),
    );

    addQualityTooling(files, context);
    addTesting(files, context, {
      environment: 'node',
      baseUrl: 'http://localhost:3000',
      devCommand: `${context.packageManager} run dev`,
    });
    addDocker(files, context, { startCommand: '["node", "dist/main.js"]', port: 3000 });
    files.set('.gitignore', gitignore());
    files.set('.editorconfig', editorconfig());

    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: context.packageName,
        version: '0.1.0',
        preset: 'nestjs-modular',
        packageManager: context.packageManager,
        tasks: {
          dev: {
            label: 'Nest en desarrollo',
            script: 'dev',
            port: 3000,
            readyPattern: 'Nest application successfully started',
            watch: true,
          },
          build: { label: 'Compilar', script: 'build' },
          test: { label: 'Pruebas', script: 'test' },
          lint: { label: 'Analisis estatico', script: 'lint' },
        },
        pipelines: {
          dev: { label: 'Dev completo', tasks: ['dev'], environment: 'local' },
          ci: { label: 'Verificacion', tasks: ['lint', 'test', 'build'], parallel: false, stopOnError: true },
        },
        environments: { local: { label: 'Local', envFiles: ['.env'], secrets: ['DATABASE_URL'] } },
        ...(database === 'none'
          ? {}
          : {
              services: [
                { name: 'db', kind: database as 'postgres', composeFile: 'docker-compose.yml', composeService: 'db' },
              ],
            }),
      }),
    );

    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: 'API NestJS modular con validacion por DTO.',
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'Servidor con recarga en caliente.' },
          { command: 'build', description: 'Compilacion de produccion.' },
          { command: 'test', description: 'Pruebas de los servicios.' },
        ],
        structure: [
          'src/',
          '  items/     modulo de ejemplo (controlador, servicio, DTO)',
          '  salud/     comprobacion de salud',
          '  app.module.ts',
        ],
      }),
    );
    return files;
  },

  nextSteps(context) {
    const steps = [`${context.packageManager} install`, 'cp .env.example .env'];
    if (context.choice('database', 'postgres') !== 'none' && context.flag('docker')) {
      steps.push('docker compose up -d');
    }
    steps.push(`${context.packageManager} run dev`, 'Abre http://localhost:3000/health');
    return steps;
  },
};

/* -------------------------------------------------------------------------- */
/*  Fastify                                                                    */
/* -------------------------------------------------------------------------- */

const FASTIFY: BlueprintDefinition = {
  id: 'fastify',
  label: 'Fastify',
  category: 'backend',
  description: 'Fastify 5 con plugins tipados, validacion por esquema JSON y registro estructurado.',
  tags: ['fastify', 'api', 'performance'],
  options: BACKEND_OPTIONS,

  build(context) {
    const files: FileMap = new Map();
    const orm = context.choice('orm', 'prisma');
    const database = context.choice('database', 'postgres');
    const ormDeps = ormDependencies(orm);

    files.set(
      'package.json',
      json({
        name: context.packageName,
        version: '0.1.0',
        private: true,
        type: 'module',
        main: 'dist/main.js',
        scripts: {
          dev: 'tsx watch src/main.ts',
          build: 'tsc -p tsconfig.json',
          start: 'node dist/main.js',
          typecheck: 'tsc --noEmit',
          ...qualityScripts(context),
        },
        dependencies: {
          fastify: '^5.2.0',
          '@fastify/cors': '^10.0.1',
          '@fastify/helmet': '^13.0.1',
          '@fastify/sensible': '^6.0.2',
          ...ormDeps.runtime,
        },
        devDependencies: {
          '@types/node': '^22.10.2',
          tsx: '^4.19.2',
          typescript: '^5.7.2',
          ...ormDeps.dev,
          ...qualityDependencies(context, false),
        },
      }),
    );

    files.set(
      'tsconfig.json',
      tsconfig({ module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: false, types: ['node'] }),
    );

    files.set(
      'src/app.ts',
      [
        "import cors from '@fastify/cors';",
        "import helmet from '@fastify/helmet';",
        "import sensible from '@fastify/sensible';",
        "import Fastify, { type FastifyInstance } from 'fastify';",
        '',
        "import { itemsPlugin } from './plugins/items.js';",
        '',
        'export async function construirApp(): Promise<FastifyInstance> {',
        '  const app = Fastify({',
        '    logger: {',
        "      level: process.env.LOG_LEVEL ?? 'info',",
        '    },',
        '  });',
        '',
        '  await app.register(helmet);',
        '  await app.register(cors);',
        '  await app.register(sensible);',
        '  await app.register(itemsPlugin, { prefix: \'/api/items\' });',
        '',
        "  app.get('/health', async () => ({ estado: 'ok' }));",
        '',
        '  return app;',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/plugins/items.ts',
      [
        "import type { FastifyPluginAsync } from 'fastify';",
        '',
        'interface Item {',
        '  readonly id: string;',
        '  readonly nombre: string;',
        '  readonly cantidad: number;',
        '}',
        '',
        '/**',
        ' * Fastify valida el cuerpo con el esquema JSON antes de llamar al',
        ' * manejador, asi que dentro ya se puede confiar en la forma.',
        ' */',
        'const esquemaCrear = {',
        '  body: {',
        "    type: 'object',",
        "    required: ['nombre'],",
        '    additionalProperties: false,',
        '    properties: {',
        "      nombre: { type: 'string', minLength: 1 },",
        "      cantidad: { type: 'integer', minimum: 1, default: 1 },",
        '    },',
        '  },',
        '} as const;',
        '',
        'export const itemsPlugin: FastifyPluginAsync = async (app) => {',
        '  const items = new Map<string, Item>();',
        '',
        "  app.get('/', async () => ({ items: [...items.values()] }));",
        '',
        "  app.get<{ Params: { id: string } }>('/:id', async (peticion, respuesta) => {",
        '    const item = items.get(peticion.params.id);',
        '    if (item === undefined) {',
        "      return respuesta.notFound('El item no existe.');",
        '    }',
        '    return { item };',
        '  });',
        '',
        "  app.post<{ Body: { nombre: string; cantidad?: number } }>(",
        "    '/',",
        '    { schema: esquemaCrear },',
        '    async (peticion, respuesta) => {',
        '      const item: Item = {',
        '        id: crypto.randomUUID(),',
        '        nombre: peticion.body.nombre,',
        '        cantidad: peticion.body.cantidad ?? 1,',
        '      };',
        '      items.set(item.id, item);',
        '      return respuesta.status(201).send({ item });',
        '    },',
        '  );',
        '};',
        '',
      ].join('\n'),
    );

    files.set(
      'src/main.ts',
      [
        "import { construirApp } from './app.js';",
        '',
        'const puerto = Number.parseInt(process.env.PORT ?? \'3000\', 10);',
        '',
        'const app = await construirApp();',
        '',
        'try {',
        "  await app.listen({ port: puerto, host: '0.0.0.0' });",
        '} catch (causa) {',
        '  app.log.error(causa);',
        '  process.exit(1);',
        '}',
        '',
        "for (const senal of ['SIGINT', 'SIGTERM'] as const) {",
        '  process.on(senal, () => {',
        '    void app.close().then(() => process.exit(0));',
        '  });',
        '}',
        '',
      ].join('\n'),
    );

    ormFiles(context, files);
    files.set(
      '.env.example',
      envExample({
        PORT: '3000',
        LOG_LEVEL: 'info',
        ...(database === 'none' ? {} : { DATABASE_URL: databaseUrl(database, context.packageName) }),
      }),
    );

    addQualityTooling(files, context);
    addTesting(files, context, {
      environment: 'node',
      baseUrl: 'http://localhost:3000',
      devCommand: `${context.packageManager} run dev`,
    });
    addDocker(files, context, { startCommand: '["node", "dist/main.js"]', port: 3000 });
    files.set('.gitignore', gitignore());
    files.set('.editorconfig', editorconfig());

    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: context.packageName,
        version: '0.1.0',
        preset: 'fastify',
        packageManager: context.packageManager,
        tasks: {
          dev: {
            label: 'Fastify en desarrollo',
            script: 'dev',
            port: 3000,
            readyPattern: 'Server listening at',
            logFormat: 'pino',
            watch: true,
          },
          build: { label: 'Compilar', script: 'build' },
          test: { label: 'Pruebas', script: 'test' },
        },
        pipelines: { dev: { label: 'Dev completo', tasks: ['dev'], environment: 'local' } },
        environments: { local: { label: 'Local', envFiles: ['.env'], secrets: ['DATABASE_URL'] } },
      }),
    );

    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: 'API Fastify con plugins tipados y validacion por esquema.',
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'Servidor con recarga en caliente.' },
          { command: 'build', description: 'Compila a `dist/`.' },
        ],
        structure: ['src/', '  app.ts       composicion', '  plugins/     rutas como plugins', '  main.ts      arranque'],
      }),
    );
    return files;
  },

  nextSteps(context) {
    return [
      `${context.packageManager} install`,
      'cp .env.example .env',
      `${context.packageManager} run dev`,
      'Abre http://localhost:3000/health',
    ];
  },
};

export const BACKEND_BLUEPRINTS: readonly BlueprintDefinition[] = [
  EXPRESS_HEXAGONAL,
  NESTJS,
  FASTIFY,
];
