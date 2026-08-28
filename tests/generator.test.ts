/**
 * Pruebas del generador de arquitecturas.
 *
 * Se comprueba que cada blueprint produce un arbol coherente y que las
 * opciones cambian de verdad lo generado. La ejecucion en seco permite
 * verificar el plan completo sin tocar el disco.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generate, findBlueprint, listBlueprints } from '../src/main/services/dotforge/generator/index.js';
import { toPackageName } from '../src/main/services/dotforge/generator/types.js';
import { normalizeConfig } from '../src/main/services/dotforge/config-service.js';
import { parseJsonTolerant } from '../src/main/services/toolchain/json-tolerant.js';

const roots: string[] = [];

function temporaryDir(): string {
  const directory = path.join(mkdtempSync(path.join(tmpdir(), 'forge-gen-')), 'proyecto');
  roots.push(path.dirname(directory));
  return directory;
}

test.after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/*  Catalogo                                                                   */
/* -------------------------------------------------------------------------- */

test('el catalogo cubre las cuatro categorias', () => {
  const blueprints = listBlueprints();
  const categories = new Set(blueprints.map((blueprint) => blueprint.category));
  assert.deepEqual(
    [...categories].sort(),
    ['backend', 'frontend', 'fullstack', 'monorepo'],
  );
  assert.ok(blueprints.length >= 10, 'deberia haber al menos diez blueprints');
});

test('cada blueprint tiene identificador unico y opciones con valor por defecto', () => {
  const identifiers = new Set<string>();
  for (const blueprint of listBlueprints()) {
    assert.equal(identifiers.has(blueprint.id), false, `id duplicado: ${blueprint.id}`);
    identifiers.add(blueprint.id);
    assert.notEqual(blueprint.description, '');
    for (const option of blueprint.options) {
      assert.notEqual(option.default, undefined, `${blueprint.id}/${option.id} sin valor por defecto`);
      if (option.type === 'choice') {
        assert.ok(option.choices !== undefined && option.choices.length > 0);
        assert.ok(
          option.choices.some((choice) => choice.id === option.default),
          `${blueprint.id}/${option.id}: el valor por defecto no esta entre las opciones`,
        );
      }
    }
  }
});

test('toPackageName produce nombres npm validos', () => {
  assert.equal(toPackageName('Mi Proyecto Genial'), 'mi-proyecto-genial');
  assert.equal(toPackageName('Aplicación Ñandú'), 'aplicacion-nandu');
  assert.equal(toPackageName('  ---  '), 'proyecto-forge');
  assert.equal(toPackageName('API v2.0'), 'api-v2.0');
});

/* -------------------------------------------------------------------------- */
/*  Generacion en seco                                                         */
/* -------------------------------------------------------------------------- */

/** Genera en seco y devuelve el mapa de archivos que produciria. */
function planFor(blueprintId: string, options: Record<string, string | boolean> = {}) {
  const blueprint = findBlueprint(blueprintId);
  assert.ok(blueprint !== undefined, `blueprint ${blueprintId} no encontrado`);

  const defaults: Record<string, string | boolean> = {};
  for (const option of blueprint.options) {
    defaults[option.id] = option.default;
  }
  return blueprint.build({
    projectName: 'Proyecto Demo',
    packageName: 'proyecto-demo',
    packageManager: 'pnpm',
    options: { ...defaults, ...options },
    flag: (id) => {
      const value = { ...defaults, ...options }[id];
      return value === true || value === 'true';
    },
    choice: (id, fallback) => {
      const value = { ...defaults, ...options }[id];
      return typeof value === 'string' && value !== '' ? value : fallback;
    },
  });
}

test('todos los blueprints generan package.json, README y manifiesto DotForge validos', () => {
  for (const blueprint of listBlueprints()) {
    const files = planFor(blueprint.id);

    const packageJson = files.get('package.json');
    assert.ok(packageJson !== undefined, `${blueprint.id}: falta package.json`);
    const parsedPackage = parseJsonTolerant<Record<string, unknown>>(packageJson);
    assert.equal(parsedPackage.error, undefined, `${blueprint.id}: package.json invalido`);
    assert.equal(parsedPackage.value?.['name'], 'proyecto-demo');

    assert.ok(files.get('README.md') !== undefined, `${blueprint.id}: falta README`);
    assert.ok(files.get('.gitignore') !== undefined, `${blueprint.id}: falta .gitignore`);

    const manifest = files.get('dotforge.config.json');
    assert.ok(manifest !== undefined, `${blueprint.id}: falta dotforge.config.json`);
    const parsedManifest = parseJsonTolerant<Record<string, unknown>>(manifest);
    assert.equal(parsedManifest.error, undefined, `${blueprint.id}: manifiesto invalido`);

    // El manifiesto generado debe pasar la normalizacion del motor sin avisos
    // sobre tareas inexistentes ni claves desconocidas.
    const { config, warnings } = normalizeConfig(parsedManifest.value, 'respaldo');
    assert.equal(
      warnings.length,
      0,
      `${blueprint.id}: el manifiesto genera avisos -> ${warnings.join(' | ')}`,
    );
    assert.equal(config.name, 'proyecto-demo');
    assert.ok(
      Object.keys(config.tasks ?? {}).length > 0,
      `${blueprint.id}: el manifiesto no declara tareas`,
    );
  }
});

test('todos los blueprints generan JSON valido en cada archivo .json', () => {
  for (const blueprint of listBlueprints()) {
    for (const [relative, content] of planFor(blueprint.id)) {
      if (!relative.endsWith('.json')) {
        continue;
      }
      const parsed = parseJsonTolerant(content);
      assert.equal(parsed.error, undefined, `${blueprint.id}/${relative}: ${parsed.error?.message ?? ''}`);
    }
  }
});

test('la opcion de linter cambia los archivos de calidad', () => {
  const conEslint = planFor('react-vite', { linter: 'eslint' });
  assert.ok(conEslint.has('eslint.config.js'));
  assert.ok(conEslint.has('.prettierrc.json'));
  assert.equal(conEslint.has('biome.json'), false);

  const conBiome = planFor('react-vite', { linter: 'biome' });
  assert.ok(conBiome.has('biome.json'));
  assert.equal(conBiome.has('eslint.config.js'), false);
});

test('la opcion de Docker anade Dockerfile y compose solo cuando procede', () => {
  const sinDocker = planFor('express', { docker: false });
  assert.equal(sinDocker.has('Dockerfile'), false);
  assert.equal(sinDocker.has('docker-compose.yml'), false);

  const conDocker = planFor('express', { docker: true, database: 'postgres' });
  assert.ok(conDocker.has('Dockerfile'));
  assert.ok(conDocker.get('docker-compose.yml')?.includes('postgres:16-alpine'));

  const sinBase = planFor('express', { docker: true, database: 'none', redis: false });
  assert.ok(sinBase.has('Dockerfile'));
  assert.equal(sinBase.has('docker-compose.yml'), false);
});

test('la opcion de ORM cambia los archivos de persistencia', () => {
  assert.ok(planFor('express', { orm: 'prisma' }).has('prisma/schema.prisma'));
  assert.ok(
    planFor('express', { orm: 'drizzle' }).has('src/infrastructure/persistence/schema.ts'),
  );
  assert.ok(
    planFor('express', { orm: 'typeorm' }).has('src/infrastructure/persistence/item.entity.ts'),
  );
  assert.equal(planFor('express', { orm: 'none' }).has('prisma/schema.prisma'), false);
});

test('el blueprint hexagonal mantiene el dominio libre de infraestructura', () => {
  const files = planFor('express');
  for (const [relative, content] of files) {
    if (!relative.startsWith('src/domain/')) {
      continue;
    }
    assert.equal(
      /from '(express|@prisma\/client|typeorm|drizzle-orm)/.test(content),
      false,
      `${relative} importa infraestructura`,
    );
    assert.equal(
      content.includes('../infrastructure/'),
      false,
      `${relative} importa la capa de infraestructura`,
    );
  }
});

test('el monorepo genera las dos aplicaciones y el paquete compartido', () => {
  const files = planFor('turborepo');
  assert.ok(files.has('apps/web/package.json'));
  assert.ok(files.has('apps/api/package.json'));
  assert.ok(files.has('packages/shared/src/index.ts'));
  assert.ok(files.has('turbo.json'));

  const manifest = parseJsonTolerant<Record<string, unknown>>(
    files.get('dotforge.config.json') ?? '{}',
  ).value;
  const pipelines = manifest?.['pipelines'] as Record<string, { tasks: string[] }> | undefined;
  assert.deepEqual(pipelines?.['dev']?.tasks, ['web', 'api']);
});

test('la combinacion Vue + NestJS cambia ambas aplicaciones', () => {
  const files = planFor('turborepo', { stack: 'vue-nestjs' });
  assert.ok(files.has('apps/web/src/App.vue'));
  assert.ok(files.get('apps/api/package.json')?.includes('@nestjs/core'));
});

/* -------------------------------------------------------------------------- */
/*  Escritura real                                                             */
/* -------------------------------------------------------------------------- */

test('dryRun devuelve el plan sin escribir nada', async () => {
  const target = temporaryDir();
  const result = await generate({
    blueprintId: 'react-vite',
    targetDir: target,
    projectName: 'Proyecto Demo',
    packageManager: 'npm',
    options: {},
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.ok(result.files.length > 5);
  assert.ok(result.files.every((file) => file.bytes > 0));
  assert.throws(() => readFileSync(path.join(target, 'package.json')));
});

test('la generacion real escribe el arbol completo', async () => {
  const target = temporaryDir();
  const result = await generate({
    blueprintId: 'express',
    targetDir: target,
    projectName: 'API Demo',
    packageManager: 'npm',
    options: { orm: 'prisma', database: 'postgres', docker: true },
  });

  assert.equal(result.dryRun, false);
  assert.ok(result.nextSteps.length > 0);

  for (const file of result.files) {
    const content = readFileSync(path.join(target, file.path), 'utf8');
    assert.equal(Buffer.byteLength(content, 'utf8'), file.bytes, `${file.path} difiere en tamano`);
  }
  assert.ok(readFileSync(path.join(target, 'src/main.ts'), 'utf8').includes('crearServidor'));
});

test('se rechaza generar en un directorio que ya tiene contenido', async () => {
  const target = temporaryDir();
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'algo.txt'), 'ocupado\n');

  await assert.rejects(
    generate({
      blueprintId: 'react-vite',
      targetDir: target,
      projectName: 'Demo',
      packageManager: 'npm',
      options: {},
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { forge?: { code?: string } }).forge?.code === 'E_ALREADY_EXISTS',
  );
});

test('se rechaza un blueprint desconocido y una ruta relativa', async () => {
  await assert.rejects(
    generate({
      blueprintId: 'no-existe',
      targetDir: temporaryDir(),
      projectName: 'Demo',
      packageManager: 'npm',
      options: {},
    }),
    (error: unknown) => (error as { forge?: { code?: string } }).forge?.code === 'E_NOT_FOUND',
  );

  await assert.rejects(
    generate({
      blueprintId: 'react-vite',
      targetDir: 'relativa/no/vale',
      projectName: 'Demo',
      packageManager: 'npm',
      options: {},
    }),
    (error: unknown) => (error as { forge?: { code?: string } }).forge?.code === 'E_INVALID_ARGUMENT',
  );
});
