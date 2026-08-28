/**
 * El asistente visual y la CLI deben generar exactamente lo mismo cuando no
 * se especifica ninguna opcion: los valores por defecto los aplica el motor.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findBlueprint, generate, listBlueprints } from '../src/main/services/dotforge/generator/index.js';

const roots: string[] = [];

function temporaryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'forge-def-'));
  roots.push(root);
  return path.join(root, 'proyecto');
}

test.after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sin opciones se aplican los valores por defecto del blueprint', async () => {
  const blueprint = findBlueprint('express-hexagonal');
  assert.ok(blueprint !== undefined);

  const sinOpciones = await generate({
    blueprintId: 'express-hexagonal',
    targetDir: temporaryDir(),
    projectName: 'API Demo',
    packageManager: 'npm',
    options: {},
    dryRun: true,
  });

  const rutas = new Set(sinOpciones.files.map((file) => file.path));
  // `docker` viene activo por defecto en el blueprint de servidor.
  assert.ok(rutas.has('Dockerfile'), 'deberia aplicarse el valor por defecto de docker');
  assert.ok(rutas.has('docker-compose.yml'), 'deberia aplicarse la base de datos por defecto');
  assert.ok(rutas.has('prisma/schema.prisma'), 'deberia aplicarse el ORM por defecto');
  assert.ok(rutas.has('eslint.config.js'), 'deberia aplicarse el linter por defecto');
});

test('una opcion explicita gana sobre el valor por defecto', async () => {
  const resultado = await generate({
    blueprintId: 'express-hexagonal',
    targetDir: temporaryDir(),
    projectName: 'API Demo',
    packageManager: 'npm',
    options: { docker: false, orm: 'none', linter: 'biome' },
    dryRun: true,
  });

  const rutas = new Set(resultado.files.map((file) => file.path));
  assert.equal(rutas.has('Dockerfile'), false);
  assert.equal(rutas.has('prisma/schema.prisma'), false);
  assert.ok(rutas.has('biome.json'));
});

test('todos los blueprints generan con opciones vacias', async () => {
  for (const blueprint of listBlueprints()) {
    const resultado = await generate({
      blueprintId: blueprint.id,
      targetDir: temporaryDir(),
      projectName: 'Demo',
      packageManager: 'npm',
      options: {},
      dryRun: true,
    });
    assert.ok(resultado.files.length > 4, `${blueprint.id} genero muy pocos archivos`);
  }
});
